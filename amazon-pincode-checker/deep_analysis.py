"""
Deep Analysis of 12-Month Revenue + Ads Data
=============================================
Reads cached order data + ads JSON files, computes:
  - Category-wise revenue & growth trends
  - Ads efficiency per category (ACoS, ROAS, Blended ROAS)
  - Organic vs Paid sales split
  - Profit levers & recommendations
"""

import os
import sys
import json
import pandas as pd
from collections import defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from category_analysis.categories import CATEGORIES, classify_asin, classify_campaign

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, "category_analysis", "cache_orders_365d.csv")
ADS_DIR = os.path.join(SCRIPT_DIR, "amazon_ads_tool", "reports", "monthly")

# ── Load Orders ──
df = pd.read_csv(CACHE_FILE)
df['order_date'] = pd.to_datetime(df['order_date'], errors='coerce', utc=True)
df = df.dropna(subset=['order_date'])
df['month'] = df['order_date'].dt.strftime('%Y-%m')
df['item_price'] = pd.to_numeric(df['item_price'], errors='coerce').fillna(0)
df['quantity'] = pd.to_numeric(df['quantity'], errors='coerce').fillna(1).astype(int)
df['category'] = df.apply(lambda r: classify_asin(str(r.get('asin', '')), str(r.get('sku', ''))), axis=1)

shipped = {'Shipped', 'Delivered', 'Shipped - Delivered to Buyer',
           'Shipped - Out for Delivery', 'Shipped - Picked Up', 'Unshipped'}
df = df[df['item_status'].isin(shipped)]

# ── Load Ads Data ──
ads_months = ['2026-01', '2026-02', '2026-03', '2026-04']
monthly_ads = {}
for m in ads_months:
    monthly_ads[m] = {}
    for rtype in ['sp_campaigns', 'sd_campaigns', 'sp_advertised_product']:
        fpath = os.path.join(ADS_DIR, f"{rtype}_{m}.json")
        if os.path.exists(fpath):
            with open(fpath) as f:
                monthly_ads[m][rtype] = json.load(f)
        else:
            monthly_ads[m][rtype] = []

# ══════════════════════════════════════════════════════════════
# ANALYSIS 1: Revenue by Category (All 12 Months)
# ══════════════════════════════════════════════════════════════
print("\n" + "=" * 80)
print("  ANALYSIS 1: CATEGORY-WISE 12-MONTH REVENUE")
print("=" * 80)

cat_rev = df.groupby('category').agg(
    revenue=('item_price', 'sum'),
    units=('quantity', 'sum'),
    orders=('asin', 'count'),
).sort_values('revenue', ascending=False)

total_rev = cat_rev['revenue'].sum()
print(f"\n  Total 12-Month Revenue: Rs {total_rev:,.0f} (Rs {total_rev/1e7:.2f} Cr)\n")
print(f"  {'Category':<30} {'Revenue':>14} {'Share':>8} {'Units':>8} {'Avg Price':>10}")
print("  " + "-" * 75)
for cat, row in cat_rev.iterrows():
    disp = CATEGORIES.get(cat, {}).get('display_name', cat)
    share = row['revenue'] / total_rev * 100
    avg_price = row['revenue'] / row['units'] if row['units'] > 0 else 0
    print(f"  {disp:<30} Rs {row['revenue']:>11,.0f} {share:>6.1f}%  {int(row['units']):>6}  Rs {avg_price:>7,.0f}")

# ══════════════════════════════════════════════════════════════
# ANALYSIS 2: Monthly Revenue Growth Trends by Category
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 2: MONTHLY REVENUE GROWTH TRENDS")
print("=" * 80)

months_all = sorted(df['month'].unique())
cat_monthly = df.groupby(['month', 'category'])['item_price'].sum().unstack(fill_value=0)

# Show last 6 months trend per category
recent_months = months_all[-6:]
print(f"\n  {'Category':<20}", end="")
for m in recent_months:
    print(f" {m:>12}", end="")
print(f" {'6M Growth':>10}")
print("  " + "-" * (20 + 12 * len(recent_months) + 12))

for cat in ['EVA_Kids', 'EVA_Gym', 'ASM', 'BPM', 'Storage', 'WTC', 'UNCATEGORIZED']:
    if cat not in cat_monthly.columns:
        continue
    disp = CATEGORIES.get(cat, {}).get('display_name', cat)[:18]
    first = cat_monthly.loc[recent_months[0], cat] if recent_months[0] in cat_monthly.index else 0
    last = cat_monthly.loc[recent_months[-1], cat] if recent_months[-1] in cat_monthly.index else 0
    growth = ((last - first) / first * 100) if first > 0 else 0
    print(f"  {disp:<20}", end="")
    for m in recent_months:
        val = cat_monthly.loc[m, cat] if m in cat_monthly.index else 0
        print(f" Rs {val/1000:>7,.0f}K", end="")
    print(f" {growth:>+8.1f}%")

# Overall monthly trend
monthly_total = df.groupby('month')['item_price'].sum()
print(f"\n  {'TOTAL':<20}", end="")
for m in recent_months:
    val = monthly_total.get(m, 0)
    print(f" Rs {val/1000:>7,.0f}K", end="")
first_total = monthly_total.get(recent_months[0], 0)
last_total = monthly_total.get(recent_months[-1], 0)
growth_total = ((last_total - first_total) / first_total * 100) if first_total > 0 else 0
print(f" {growth_total:>+8.1f}%")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 3: ADS EFFICIENCY BY CATEGORY (Jan-Apr 2026)
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 3: ADS EFFICIENCY BY CATEGORY (Jan-Apr 2026)")
print("=" * 80)

# Aggregate ads data by category across all available months
cat_ads_total = defaultdict(lambda: {'spend': 0, 'ad_sales': 0})
for m in ads_months:
    for p in monthly_ads[m].get('sp_advertised_product', []):
        asin = p.get('advertisedAsin', '')
        sku = p.get('advertisedSku', '')
        cat = classify_asin(asin, sku)
        cat_ads_total[cat]['spend'] += float(p.get('cost', 0))
        cat_ads_total[cat]['ad_sales'] += float(p.get('sales1d', 0))
    for c in monthly_ads[m].get('sd_campaigns', []):
        cat = classify_campaign(c.get('campaignName', ''))
        cat_ads_total[cat]['spend'] += float(c.get('cost', 0))
        cat_ads_total[cat]['ad_sales'] += float(c.get('sales', 0))

# Get revenue for same period (Jan-Apr 2026)
rev_jan_apr = df[df['month'].isin(ads_months)].groupby('category')['item_price'].sum()

print(f"\n  {'Category':<22} {'Ad Spend':>10} {'Ad Sales':>11} {'ACoS':>7} {'Ads ROAS':>9} {'Revenue':>12} {'Organic':>10} {'Org%':>6} {'BlendROAS':>10} {'Target':>8} {'Status':>10}")
print("  " + "-" * 125)

total_spend = 0
total_ad_sales = 0
total_rev_period = 0

for cat in ['EVA_Kids', 'EVA_Gym', 'ASM', 'BPM', 'Storage', 'WTC', 'UNCATEGORIZED']:
    ads = cat_ads_total.get(cat, {'spend': 0, 'ad_sales': 0})
    spend = ads['spend']
    ad_sales = ads['ad_sales']
    rev = rev_jan_apr.get(cat, 0)
    organic = max(0, rev - ad_sales)
    org_pct = (organic / rev * 100) if rev > 0 else 0
    acos = (spend / ad_sales * 100) if ad_sales > 0 else 0
    ads_roas = (ad_sales / spend) if spend > 0 else 0
    blend_roas = (rev / spend) if spend > 0 else 0

    target_roas = CATEGORIES.get(cat, {}).get('target_ads_roi', 0)
    target_blend = CATEGORIES.get(cat, {}).get('target_blended_roi', 0)
    
    if target_roas > 0:
        if ads_roas >= target_roas:
            status = "ON TARGET"
        elif ads_roas >= target_roas * 0.8:
            status = "CLOSE"
        else:
            status = "BELOW"
    else:
        status = "-"

    disp = CATEGORIES.get(cat, {}).get('display_name', cat)[:20]
    print(f"  {disp:<22} Rs{spend:>8,.0f} Rs{ad_sales:>9,.0f}  {acos:>5.1f}%  {ads_roas:>7.2f}x  Rs{rev:>10,.0f}  Rs{organic:>8,.0f} {org_pct:>5.1f}%  {blend_roas:>8.2f}x  {target_roas:>6.1f}x  {status:>10}")
    
    total_spend += spend
    total_ad_sales += ad_sales
    total_rev_period += rev

tot_acos = (total_spend / total_ad_sales * 100) if total_ad_sales > 0 else 0
tot_roas = (total_ad_sales / total_spend) if total_spend > 0 else 0
tot_blend = (total_rev_period / total_spend) if total_spend > 0 else 0
tot_organic = max(0, total_rev_period - total_ad_sales)
tot_org_pct = (tot_organic / total_rev_period * 100) if total_rev_period > 0 else 0
print("  " + "-" * 125)
print(f"  {'TOTAL':<22} Rs{total_spend:>8,.0f} Rs{total_ad_sales:>9,.0f}  {tot_acos:>5.1f}%  {tot_roas:>7.2f}x  Rs{total_rev_period:>10,.0f}  Rs{tot_organic:>8,.0f} {tot_org_pct:>5.1f}%  {tot_blend:>8.2f}x")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 4: MONTH-OVER-MONTH ADS TREND
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 4: MONTHLY ADS TREND (Jan-Apr 2026)")
print("=" * 80)

print(f"\n  {'Month':>8} {'Ad Spend':>10} {'Ad Sales':>12} {'ACoS':>7} {'ROAS':>7} {'Revenue':>12} {'Organic':>12} {'Org%':>6} {'BlendROAS':>10}")
print("  " + "-" * 90)

for m in ads_months:
    m_spend = 0
    m_ad_sales = 0
    for p in monthly_ads[m].get('sp_advertised_product', []):
        m_spend += float(p.get('cost', 0))
        m_ad_sales += float(p.get('sales1d', 0))
    for c in monthly_ads[m].get('sd_campaigns', []):
        m_spend += float(c.get('cost', 0))
        m_ad_sales += float(c.get('sales', 0))
    
    m_rev = monthly_total.get(m, 0)
    m_organic = max(0, m_rev - m_ad_sales)
    m_org_pct = (m_organic / m_rev * 100) if m_rev > 0 else 0
    m_acos = (m_spend / m_ad_sales * 100) if m_ad_sales > 0 else 0
    m_roas = (m_ad_sales / m_spend) if m_spend > 0 else 0
    m_blend = (m_rev / m_spend) if m_spend > 0 else 0
    
    print(f"  {m:>8} Rs{m_spend:>8,.0f} Rs{m_ad_sales:>10,.0f}  {m_acos:>5.1f}%  {m_roas:>5.2f}x  Rs{m_rev:>10,.0f} Rs{m_organic:>10,.0f} {m_org_pct:>5.1f}%  {m_blend:>8.2f}x")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 5: TOP/BOTTOM ASINS BY PROFITABILITY
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 5: TOP & BOTTOM ASINs BY ADS EFFICIENCY")
print("=" * 80)

# Aggregate all sp_advertised_product data
asin_ads = defaultdict(lambda: {'cost': 0, 'sales': 0, 'impressions': 0, 'clicks': 0})
for m in ads_months:
    for p in monthly_ads[m].get('sp_advertised_product', []):
        a = p.get('advertisedAsin', '')
        asin_ads[a]['cost'] += float(p.get('cost', 0))
        asin_ads[a]['sales'] += float(p.get('sales1d', 0))
        asin_ads[a]['impressions'] += int(p.get('impressions', 0))
        asin_ads[a]['clicks'] += int(p.get('clicks', 0))

# Filter to ASINs with meaningful spend
asin_list = []
for asin, d in asin_ads.items():
    if d['cost'] > 500:  # Min Rs 500 spend
        roas = d['sales'] / d['cost'] if d['cost'] > 0 else 0
        acos = (d['cost'] / d['sales'] * 100) if d['sales'] > 0 else 999
        ctr = (d['clicks'] / d['impressions'] * 100) if d['impressions'] > 0 else 0
        cat = classify_asin(asin)
        asin_list.append({
            'asin': asin,
            'category': cat,
            'spend': d['cost'],
            'sales': d['sales'],
            'roas': roas,
            'acos': acos,
            'ctr': ctr,
            'clicks': d['clicks'],
            'impressions': d['impressions'],
        })

asin_df = pd.DataFrame(asin_list).sort_values('spend', ascending=False)

# Top performers (high ROAS, significant spend)
print("\n  TOP 15 ASINs by Spend (with ROAS):")
print(f"  {'ASIN':<14} {'Category':<18} {'Spend':>9} {'Sales':>11} {'ROAS':>7} {'ACoS':>7} {'CTR':>6} {'Clicks':>8}")
print("  " + "-" * 85)
for _, r in asin_df.head(15).iterrows():
    cat_disp = CATEGORIES.get(r['category'], {}).get('display_name', r['category'])[:16]
    print(f"  {r['asin']:<14} {cat_disp:<18} Rs{r['spend']:>7,.0f} Rs{r['sales']:>9,.0f}  {r['roas']:>5.2f}x {r['acos']:>5.1f}% {r['ctr']:>5.2f}% {int(r['clicks']):>7}")

# Worst performers (high spend, low ROAS)
bleeders = asin_df[asin_df['roas'] < 3].sort_values('spend', ascending=False)
print(f"\n  BLEEDERS: ASINs with ROAS < 3x (wasting ad money):")
print(f"  {'ASIN':<14} {'Category':<18} {'Spend':>9} {'Sales':>11} {'ROAS':>7} {'ACoS':>7} {'Wasted':>9}")
print("  " + "-" * 85)
for _, r in bleeders.head(15).iterrows():
    cat_disp = CATEGORIES.get(r['category'], {}).get('display_name', r['category'])[:16]
    # "Wasted" = spend beyond what a 5x ROAS would need
    efficient_spend = r['sales'] / 5 if r['sales'] > 0 else 0
    wasted = max(0, r['spend'] - efficient_spend)
    print(f"  {r['asin']:<14} {cat_disp:<18} Rs{r['spend']:>7,.0f} Rs{r['sales']:>9,.0f}  {r['roas']:>5.2f}x {r['acos']:>5.1f}% Rs{wasted:>7,.0f}")

total_bleed_spend = bleeders['spend'].sum()
total_bleed_waste = sum(max(0, r['spend'] - r['sales']/5) for _, r in bleeders.iterrows())
print(f"\n  Total bleeder spend: Rs {total_bleed_spend:,.0f} | Estimated waste: Rs {total_bleed_waste:,.0f}")


# Best ROAS ASINs (high efficiency)
stars = asin_df[asin_df['roas'] >= 10].sort_values('sales', ascending=False)
print(f"\n  STARS: ASINs with ROAS >= 10x (scale these up):")
print(f"  {'ASIN':<14} {'Category':<18} {'Spend':>9} {'Sales':>11} {'ROAS':>7} {'ACoS':>7}")
print("  " + "-" * 70)
for _, r in stars.head(15).iterrows():
    cat_disp = CATEGORIES.get(r['category'], {}).get('display_name', r['category'])[:16]
    print(f"  {r['asin']:<14} {cat_disp:<18} Rs{r['spend']:>7,.0f} Rs{r['sales']:>9,.0f}  {r['roas']:>5.2f}x {r['acos']:>5.1f}%")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 6: ORGANIC % BY CATEGORY (KEY PROFIT LEVER)
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 6: ORGANIC SHARE BY CATEGORY (Jan-Apr 2026)")
print("=" * 80)

print(f"\n  {'Category':<25} {'Revenue':>12} {'Ad Sales':>11} {'Organic':>12} {'Org%':>8} {'Verdict'}")
print("  " + "-" * 85)
for cat in ['EVA_Kids', 'EVA_Gym', 'ASM', 'BPM', 'Storage', 'WTC']:
    ads = cat_ads_total.get(cat, {'spend': 0, 'ad_sales': 0})
    rev = rev_jan_apr.get(cat, 0)
    organic = max(0, rev - ads['ad_sales'])
    org_pct = (organic / rev * 100) if rev > 0 else 0
    
    if org_pct >= 70:
        verdict = "EXCELLENT - strong organic"
    elif org_pct >= 50:
        verdict = "GOOD - balanced"
    elif org_pct >= 30:
        verdict = "WATCH - ads dependent"
    else:
        verdict = "DANGER - too ads dependent"
    
    disp = CATEGORIES.get(cat, {}).get('display_name', cat)[:23]
    print(f"  {disp:<25} Rs{rev:>10,.0f} Rs{ads['ad_sales']:>9,.0f} Rs{organic:>10,.0f} {org_pct:>6.1f}%  {verdict}")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 7: SEASONALITY & PEAK DETECTION
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 7: SEASONALITY & PEAK MONTHS")
print("=" * 80)

avg_monthly = monthly_total.mean()
print(f"\n  Average Monthly Revenue: Rs {avg_monthly:,.0f}")
print(f"\n  {'Month':>8} {'Revenue':>12} {'vs Avg':>8} {'Index':>6}")
print("  " + "-" * 40)
for m in months_all:
    val = monthly_total.get(m, 0)
    vs_avg = (val / avg_monthly * 100) if avg_monthly > 0 else 0
    marker = " ***" if vs_avg > 120 else (" !" if vs_avg < 80 else "")
    print(f"  {m:>8} Rs{val:>10,.0f} {vs_avg:>6.0f}%  {vs_avg/100:>5.2f}x{marker}")


# ══════════════════════════════════════════════════════════════
# ANALYSIS 8: SD vs SP SPLIT
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 80)
print("  ANALYSIS 8: SP vs SD CAMPAIGN SPLIT (Jan-Apr 2026)")
print("=" * 80)

sp_total = {'spend': 0, 'sales': 0}
sd_total = {'spend': 0, 'sales': 0}

for m in ads_months:
    for p in monthly_ads[m].get('sp_advertised_product', []):
        sp_total['spend'] += float(p.get('cost', 0))
        sp_total['sales'] += float(p.get('sales1d', 0))
    for c in monthly_ads[m].get('sd_campaigns', []):
        sd_total['spend'] += float(c.get('cost', 0))
        sd_total['sales'] += float(c.get('sales', 0))

sp_roas = sp_total['sales'] / sp_total['spend'] if sp_total['spend'] > 0 else 0
sd_roas = sd_total['sales'] / sd_total['spend'] if sd_total['spend'] > 0 else 0
sp_acos = (sp_total['spend'] / sp_total['sales'] * 100) if sp_total['sales'] > 0 else 0
sd_acos = (sd_total['spend'] / sd_total['sales'] * 100) if sd_total['sales'] > 0 else 0

total_all_spend = sp_total['spend'] + sd_total['spend']
sp_share = (sp_total['spend'] / total_all_spend * 100) if total_all_spend > 0 else 0
sd_share = (sd_total['spend'] / total_all_spend * 100) if total_all_spend > 0 else 0

print(f"\n  {'Type':<15} {'Spend':>12} {'Sales':>12} {'ACoS':>8} {'ROAS':>8} {'Spend%':>8}")
print("  " + "-" * 65)
print(f"  {'SP (Sponsored)' :<15} Rs{sp_total['spend']:>10,.0f} Rs{sp_total['sales']:>10,.0f}  {sp_acos:>5.1f}%  {sp_roas:>5.2f}x  {sp_share:>5.1f}%")
print(f"  {'SD (Display)':<15} Rs{sd_total['spend']:>10,.0f} Rs{sd_total['sales']:>10,.0f}  {sd_acos:>5.1f}%  {sd_roas:>5.2f}x  {sd_share:>5.1f}%")
print(f"\n  Verdict: {'SP' if sp_roas > sd_roas else 'SD'} is more efficient ({max(sp_roas, sd_roas):.2f}x vs {min(sp_roas, sd_roas):.2f}x ROAS)")

print("\n\n" + "=" * 80)
print("  DONE - Full analysis complete")
print("=" * 80)
