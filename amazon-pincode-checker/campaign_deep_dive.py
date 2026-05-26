"""
Campaign-Level Deep Dive: Why is April 2026 expensive?
Compares campaign performance across months to find what changed.
"""
import os, sys, json
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from category_analysis.categories import classify_asin, classify_campaign, CATEGORIES

ADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "amazon_ads_tool", "reports", "monthly")

months = ['2026-01', '2026-02', '2026-03', '2026-04']

# Load all data
data = {}
for m in months:
    data[m] = {}
    for rt in ['sp_campaigns', 'sd_campaigns', 'sp_advertised_product']:
        fpath = os.path.join(ADS_DIR, f"{rt}_{m}.json")
        if os.path.exists(fpath):
            with open(fpath) as f:
                data[m][rt] = json.load(f)
        else:
            data[m][rt] = []

# ══════════════════════════════════════════════════════════════
# 1. SP CAMPAIGN LEVEL - Month over Month
# ══════════════════════════════════════════════════════════════
print("=" * 120)
print("  SP CAMPAIGNS — MONTH-OVER-MONTH COMPARISON")
print("=" * 120)

# Collect all campaign names across months
all_campaigns = {}
for m in months:
    for c in data[m]['sp_campaigns']:
        name = c.get('campaignName', 'Unknown')
        if name not in all_campaigns:
            all_campaigns[name] = {}
        all_campaigns[name][m] = {
            'spend': float(c.get('cost', 0)),
            'sales': float(c.get('sales', 0)),
            'impressions': int(c.get('impressions', 0)),
            'clicks': int(c.get('clicks', 0)),
        }

# Sort by Apr spend descending
camp_list = []
for name, months_data in all_campaigns.items():
    apr = months_data.get('2026-04', {'spend': 0, 'sales': 0})
    mar = months_data.get('2026-03', {'spend': 0, 'sales': 0})
    feb = months_data.get('2026-02', {'spend': 0, 'sales': 0})
    jan = months_data.get('2026-01', {'spend': 0, 'sales': 0})
    total_spend = sum(d.get('spend', 0) for d in months_data.values())
    camp_list.append({
        'name': name,
        'jan': jan, 'feb': feb, 'mar': mar, 'apr': apr,
        'total_spend': total_spend,
        'apr_spend': apr.get('spend', 0),
    })

camp_list.sort(key=lambda x: x['total_spend'], reverse=True)

print(f"\n  {'Campaign':<55} {'Jan Spend':>10} {'Jan ROAS':>9} {'Feb Spend':>10} {'Feb ROAS':>9} {'Mar Spend':>10} {'Mar ROAS':>9} {'Apr Spend':>10} {'Apr ROAS':>9} {'Trend'}")
print("  " + "-" * 155)

for c in camp_list[:40]:
    name = c['name'][:53]
    row = f"  {name:<55}"
    prev_roas = None
    for mkey in ['jan', 'feb', 'mar', 'apr']:
        d = c[mkey]
        spend = d.get('spend', 0)
        sales = d.get('sales', 0)
        roas = sales / spend if spend > 0 else 0
        acos = (spend / sales * 100) if sales > 0 else 0
        row += f" Rs{spend:>7,.0f}  {roas:>6.2f}x"
        if mkey == 'apr':
            apr_roas = roas
        if mkey == 'mar':
            mar_roas = roas
    
    # Trend indicator
    apr_d = c['apr']
    mar_d = c['mar']
    if apr_d.get('spend', 0) > 0 and mar_d.get('spend', 0) > 0:
        apr_roas = apr_d['sales'] / apr_d['spend'] if apr_d['spend'] > 0 else 0
        mar_roas = mar_d['sales'] / mar_d['spend'] if mar_d['spend'] > 0 else 0
        if apr_roas < mar_roas * 0.7:
            trend = "WORSE"
        elif apr_roas > mar_roas * 1.3:
            trend = "BETTER"
        else:
            trend = "SAME"
    elif apr_d.get('spend', 0) > 0 and mar_d.get('spend', 0) == 0:
        trend = "NEW"
    elif apr_d.get('spend', 0) == 0:
        trend = "PAUSED"
    else:
        trend = "-"
    row += f"  {trend}"
    print(row)


# ══════════════════════════════════════════════════════════════
# 2. SD CAMPAIGN LEVEL - Month over Month
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 120)
print("  SD (DISPLAY) CAMPAIGNS — MONTH-OVER-MONTH COMPARISON")
print("=" * 120)

all_sd = {}
for m in months:
    for c in data[m]['sd_campaigns']:
        name = c.get('campaignName', 'Unknown')
        if name not in all_sd:
            all_sd[name] = {}
        all_sd[name][m] = {
            'spend': float(c.get('cost', 0)),
            'sales': float(c.get('sales', 0)),
            'impressions': int(c.get('impressions', 0)),
            'clicks': int(c.get('clicks', 0)),
        }

sd_list = []
for name, months_data in all_sd.items():
    total_spend = sum(d.get('spend', 0) for d in months_data.values())
    sd_list.append({'name': name, 'months': months_data, 'total_spend': total_spend})

sd_list.sort(key=lambda x: x['total_spend'], reverse=True)

print(f"\n  {'Campaign':<55} {'Jan Spend':>10} {'Jan ROAS':>9} {'Feb Spend':>10} {'Feb ROAS':>9} {'Mar Spend':>10} {'Mar ROAS':>9} {'Apr Spend':>10} {'Apr ROAS':>9}")
print("  " + "-" * 140)

for c in sd_list[:30]:
    name = c['name'][:53]
    row = f"  {name:<55}"
    for mkey in months:
        d = c['months'].get(mkey, {'spend': 0, 'sales': 0})
        spend = d.get('spend', 0)
        sales = d.get('sales', 0)
        roas = sales / spend if spend > 0 else 0
        row += f" Rs{spend:>7,.0f}  {roas:>6.2f}x"
    print(row)


# ══════════════════════════════════════════════════════════════
# 3. ASIN-LEVEL COMPARISON: Mar vs Apr (what changed?)
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 120)
print("  ASIN-LEVEL: MARCH vs APRIL COMPARISON (biggest changes)")
print("=" * 120)

# Aggregate by ASIN per month
asin_by_month = defaultdict(lambda: defaultdict(lambda: {'cost': 0, 'sales': 0, 'clicks': 0, 'impressions': 0}))
for m in months:
    for p in data[m]['sp_advertised_product']:
        a = p.get('advertisedAsin', '')
        asin_by_month[a][m]['cost'] += float(p.get('cost', 0))
        asin_by_month[a][m]['sales'] += float(p.get('sales1d', 0))
        asin_by_month[a][m]['clicks'] += int(p.get('clicks', 0))
        asin_by_month[a][m]['impressions'] += int(p.get('impressions', 0))

# Compare Mar vs Apr (prorated: Apr is 10 days, Mar is 31 days)
apr_days = 10
mar_days = 31
comparisons = []

for asin, md in asin_by_month.items():
    mar = md.get('2026-03', {'cost': 0, 'sales': 0, 'clicks': 0, 'impressions': 0})
    apr = md.get('2026-04', {'cost': 0, 'sales': 0, 'clicks': 0, 'impressions': 0})
    
    mar_daily_spend = mar['cost'] / mar_days if mar['cost'] > 0 else 0
    apr_daily_spend = apr['cost'] / apr_days if apr['cost'] > 0 else 0
    mar_daily_sales = mar['sales'] / mar_days if mar['sales'] > 0 else 0
    apr_daily_sales = apr['sales'] / apr_days if apr['sales'] > 0 else 0
    
    mar_roas = mar['sales'] / mar['cost'] if mar['cost'] > 100 else 0
    apr_roas = apr['sales'] / apr['cost'] if apr['cost'] > 100 else 0
    mar_acos = (mar['cost'] / mar['sales'] * 100) if mar['sales'] > 0 else 999
    apr_acos = (apr['cost'] / apr['sales'] * 100) if apr['sales'] > 0 else 999
    
    mar_ctr = (mar['clicks'] / mar['impressions'] * 100) if mar['impressions'] > 0 else 0
    apr_ctr = (apr['clicks'] / apr['impressions'] * 100) if apr['impressions'] > 0 else 0
    
    # Only include ASINs with meaningful spend in either month
    if mar['cost'] > 500 or apr['cost'] > 200:
        spend_change = ((apr_daily_spend - mar_daily_spend) / mar_daily_spend * 100) if mar_daily_spend > 0 else 999
        roas_change = apr_roas - mar_roas
        
        comparisons.append({
            'asin': asin,
            'category': classify_asin(asin),
            'mar_spend': mar['cost'], 'apr_spend': apr['cost'],
            'mar_daily_spend': mar_daily_spend, 'apr_daily_spend': apr_daily_spend,
            'mar_sales': mar['sales'], 'apr_sales': apr['sales'],
            'mar_roas': mar_roas, 'apr_roas': apr_roas,
            'mar_acos': mar_acos, 'apr_acos': apr_acos,
            'mar_ctr': mar_ctr, 'apr_ctr': apr_ctr,
            'roas_change': roas_change,
            'spend_change': spend_change,
        })

# ASINs where ROAS got worse
worse = sorted([c for c in comparisons if c['roas_change'] < -1 and c['mar_roas'] > 0], key=lambda x: x['roas_change'])
print(f"\n  ASINs where ROAS DROPPED (Mar to Apr):")
print(f"  {'ASIN':<14} {'Category':<18} {'Mar Spend':>10} {'Mar ROAS':>9} {'Apr Spend':>10} {'Apr ROAS':>9} {'ROAS Drop':>10} {'Mar CTR':>8} {'Apr CTR':>8}")
print("  " + "-" * 105)
for c in worse[:20]:
    cat = CATEGORIES.get(c['category'], {}).get('display_name', c['category'])[:16]
    print(f"  {c['asin']:<14} {cat:<18} Rs{c['mar_spend']:>8,.0f}  {c['mar_roas']:>6.2f}x  Rs{c['apr_spend']:>8,.0f}  {c['apr_roas']:>6.2f}x  {c['roas_change']:>+8.2f}x  {c['mar_ctr']:>6.2f}%  {c['apr_ctr']:>6.2f}%")

# ASINs where daily spend increased significantly  
print(f"\n  ASINs where DAILY SPEND INCREASED significantly (Apr daily vs Mar daily):")
spend_up = sorted([c for c in comparisons if c['spend_change'] > 30 and c['apr_spend'] > 300], key=lambda x: x['apr_daily_spend'], reverse=True)
print(f"  {'ASIN':<14} {'Category':<18} {'Mar/day':>9} {'Apr/day':>9} {'Change':>8} {'Mar ROAS':>9} {'Apr ROAS':>9}")
print("  " + "-" * 85)
for c in spend_up[:15]:
    cat = CATEGORIES.get(c['category'], {}).get('display_name', c['category'])[:16]
    print(f"  {c['asin']:<14} {cat:<18} Rs{c['mar_daily_spend']:>7,.0f} Rs{c['apr_daily_spend']:>7,.0f} {c['spend_change']:>+6.0f}%  {c['mar_roas']:>6.2f}x  {c['apr_roas']:>6.2f}x")


# ══════════════════════════════════════════════════════════════
# 4. CATEGORY-LEVEL: Mar vs Apr ACoS Comparison
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 120)
print("  CATEGORY ACoS TREND: Jan > Feb > Mar > Apr (getting worse?)")
print("=" * 120)

for cat in ['EVA_Kids', 'EVA_Gym', 'ASM', 'BPM', 'Storage']:
    disp = CATEGORIES.get(cat, {}).get('display_name', cat)
    target_acos = CATEGORIES.get(cat, {}).get('target_acos', 0)
    print(f"\n  {disp} (Target ACoS: {target_acos}%)")
    print(f"  {'Month':>8} {'Spend':>10} {'Sales':>12} {'ACoS':>8} {'ROAS':>7} {'Clicks':>8} {'Impr':>10} {'CTR':>7} {'CPC':>7} {'Conv%':>7}")
    print("  " + "-" * 95)
    
    for m in months:
        cat_spend = 0
        cat_sales = 0
        cat_clicks = 0
        cat_impr = 0
        cat_orders = 0
        
        for p in data[m]['sp_advertised_product']:
            a = p.get('advertisedAsin', '')
            s = p.get('advertisedSku', '')
            if classify_asin(a, s) == cat:
                cat_spend += float(p.get('cost', 0))
                cat_sales += float(p.get('sales1d', 0))
                cat_clicks += int(p.get('clicks', 0))
                cat_impr += int(p.get('impressions', 0))
                cat_orders += int(p.get('unitsSoldClicks1d', 0) if p.get('unitsSoldClicks1d') else 0)
        
        for c in data[m]['sd_campaigns']:
            if classify_campaign(c.get('campaignName', '')) == cat:
                cat_spend += float(c.get('cost', 0))
                cat_sales += float(c.get('sales', 0))
                cat_clicks += int(c.get('clicks', 0))
                cat_impr += int(c.get('impressions', 0))
        
        acos = (cat_spend / cat_sales * 100) if cat_sales > 0 else 0
        roas = cat_sales / cat_spend if cat_spend > 0 else 0
        ctr = (cat_clicks / cat_impr * 100) if cat_impr > 0 else 0
        cpc = cat_spend / cat_clicks if cat_clicks > 0 else 0
        conv = (cat_orders / cat_clicks * 100) if cat_clicks > 0 else 0
        
        marker = " !" if acos > target_acos * 1.2 else ""
        print(f"  {m:>8} Rs{cat_spend:>8,.0f} Rs{cat_sales:>10,.0f}  {acos:>5.1f}%  {roas:>5.2f}x  {cat_clicks:>6}  {cat_impr:>8}  {ctr:>5.2f}%  Rs{cpc:>5.1f}  {conv:>5.1f}%{marker}")


# ══════════════════════════════════════════════════════════════
# 5. CPC & CTR TRENDS (rising CPCs = Amazon tax)
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 120)
print("  OVERALL CPC & CTR TREND (Is Amazon getting more expensive?)")
print("=" * 120)

print(f"\n  {'Month':>8} {'Total Spend':>12} {'Total Clicks':>13} {'Avg CPC':>9} {'Total Impr':>12} {'CTR':>7} {'SP Orders':>10} {'Conv%':>7}")
print("  " + "-" * 85)
for m in months:
    t_spend = 0
    t_clicks = 0
    t_impr = 0
    t_orders = 0
    for p in data[m]['sp_advertised_product']:
        t_spend += float(p.get('cost', 0))
        t_clicks += int(p.get('clicks', 0))
        t_impr += int(p.get('impressions', 0))
        t_orders += int(p.get('unitsSoldClicks1d', 0) if p.get('unitsSoldClicks1d') else 0)
    
    cpc = t_spend / t_clicks if t_clicks > 0 else 0
    ctr = (t_clicks / t_impr * 100) if t_impr > 0 else 0
    conv = (t_orders / t_clicks * 100) if t_clicks > 0 else 0
    print(f"  {m:>8} Rs{t_spend:>10,.0f}  {t_clicks:>11,}  Rs{cpc:>6.2f}  {t_impr:>10,}  {ctr:>5.2f}%  {t_orders:>8,}  {conv:>5.1f}%")


# ══════════════════════════════════════════════════════════════
# 6. NEW/CHANGED CAMPAIGNS IN APRIL
# ══════════════════════════════════════════════════════════════
print("\n\n" + "=" * 120)
print("  NEW OR CHANGED CAMPAIGNS IN APRIL")
print("=" * 120)

# Campaigns that only appear in April (new)
apr_only = []
for name, md in all_campaigns.items():
    if '2026-04' in md and '2026-03' not in md and '2026-02' not in md:
        apr_only.append({'name': name, **md['2026-04']})

if apr_only:
    apr_only.sort(key=lambda x: x['spend'], reverse=True)
    print(f"\n  NEW SP campaigns in April (not present in Feb/Mar):")
    print(f"  {'Campaign':<60} {'Spend':>9} {'Sales':>11} {'ROAS':>7}")
    print("  " + "-" * 90)
    for c in apr_only[:15]:
        roas = c['sales'] / c['spend'] if c['spend'] > 0 else 0
        print(f"  {c['name'][:58]:<60} Rs{c['spend']:>7,.0f} Rs{c['sales']:>9,.0f}  {roas:>5.2f}x")
else:
    print("\n  No new SP campaigns found in April.")

# Campaigns with spend spike in April vs March
print(f"\n  SP Campaigns with spend INCREASE (Apr daily vs Mar daily):")
camp_compare = []
for name, md in all_campaigns.items():
    mar = md.get('2026-03', {'spend': 0})
    apr = md.get('2026-04', {'spend': 0})
    mar_daily = mar['spend'] / 31 if mar['spend'] > 0 else 0
    apr_daily = apr['spend'] / 10 if apr['spend'] > 0 else 0
    if apr_daily > mar_daily * 1.3 and apr['spend'] > 200:
        spending_change = ((apr_daily - mar_daily) / mar_daily * 100) if mar_daily > 0 else 999
        mar_roas = mar.get('sales', 0) / mar['spend'] if mar['spend'] > 0 else 0
        apr_roas = apr.get('sales', 0) / apr['spend'] if apr['spend'] > 0 else 0
        camp_compare.append({
            'name': name, 'mar_daily': mar_daily, 'apr_daily': apr_daily,
            'change': spending_change, 'mar_roas': mar_roas, 'apr_roas': apr_roas,
            'apr_spend': apr['spend'],
        })

camp_compare.sort(key=lambda x: x['apr_spend'], reverse=True)
print(f"  {'Campaign':<55} {'Mar/day':>9} {'Apr/day':>9} {'Change':>8} {'Mar ROAS':>9} {'Apr ROAS':>9}")
print("  " + "-" * 105)
for c in camp_compare[:20]:
    print(f"  {c['name'][:53]:<55} Rs{c['mar_daily']:>7,.0f} Rs{c['apr_daily']:>7,.0f} {c['change']:>+6.0f}%  {c['mar_roas']:>6.2f}x  {c['apr_roas']:>6.2f}x")

print("\n\n" + "=" * 120)
print("  ANALYSIS COMPLETE")
print("=" * 120)
