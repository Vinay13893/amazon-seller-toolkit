"""
Deep Professional Analysis — Master Report
============================================
Uses ALL available data:
  - Orders (365d, 40K+ rows) for actual sales per ASIN
  - SP Advertised Product (ASIN-level ads)
  - SP Search Terms (7,392 rows) for keyword analysis
  - SP Targeting (318 keywords) for bid analysis
  - SP/SD Campaigns (30d default + monthly)
  - Category mappings
  
Produces:
  1. ASIN Master: actual sales vs ad sales, organic %, profit analysis
  2. Campaign-ASIN Duplication: which ASINs are in too many campaigns
  3. Search Term Analysis: duplicated keywords, waste, gaps
  4. Keyword Bid Analysis: overbids, underbids
  5. Category P&L: unit economics
  6. Competitor Targeting gaps
"""
import os, sys, json, csv
import pandas as pd
from collections import defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from category_analysis.categories import classify_asin, classify_campaign, CATEGORIES

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ADS_DIR = os.path.join(SCRIPT_DIR, "amazon_ads_tool", "reports")
MONTHLY_DIR = os.path.join(ADS_DIR, "monthly")
OUT_DIR = os.path.join(SCRIPT_DIR, "output")
os.makedirs(OUT_DIR, exist_ok=True)

# Days for prorating
DAYS_SP = {'2026-01': 26, '2026-02': 28, '2026-03': 31, '2026-04': 11}

# ── Load all data ──
print("Loading data...")
sp_products = json.load(open(os.path.join(ADS_DIR, "sp_advertised_product_data.json")))
sp_campaigns = json.load(open(os.path.join(ADS_DIR, "sp_campaigns_data.json")))
sd_campaigns = json.load(open(os.path.join(ADS_DIR, "sd_campaigns_data.json")))
search_terms = json.load(open(os.path.join(ADS_DIR, "sp_search_terms_data.json")))
targeting = json.load(open(os.path.join(ADS_DIR, "sp_targeting_data.json")))

# Monthly ads data
monthly_asin = {}
monthly_sp = {}
monthly_sd = {}
for m in ['2026-01', '2026-02', '2026-03', '2026-04']:
    for rt, store in [('sp_advertised_product', monthly_asin), ('sp_campaigns', monthly_sp), ('sd_campaigns', monthly_sd)]:
        fpath = os.path.join(MONTHLY_DIR, f"{rt}_{m}.json")
        if os.path.exists(fpath):
            store[m] = json.load(open(fpath))
        else:
            store[m] = []

# Orders data
orders = pd.read_csv(os.path.join(SCRIPT_DIR, "category_analysis", "cache_orders_365d.csv"))
orders['order_date'] = pd.to_datetime(orders['order_date'], errors='coerce', utc=True)
orders = orders.dropna(subset=['order_date'])
orders['item_price'] = pd.to_numeric(orders['item_price'], errors='coerce').fillna(0)
orders['quantity'] = pd.to_numeric(orders['quantity'], errors='coerce').fillna(1).astype(int)
orders['cat_key'] = orders.apply(lambda r: classify_asin(str(r.get('asin','')), str(r.get('sku',''))), axis=1)
orders['category'] = orders['cat_key'].map(lambda k: CATEGORIES[k]['display_name'] if k in CATEGORIES else k)
orders['month'] = orders['order_date'].dt.strftime('%Y-%m')
shipped = {'Shipped', 'Delivered', 'Shipped - Delivered to Buyer',
           'Shipped - Out for Delivery', 'Shipped - Picked Up', 'Unshipped'}
orders = orders[orders['item_status'].isin(shipped)]

print(f"  SP Products: {len(sp_products)} rows")
print(f"  Search Terms: {len(search_terms)} rows")
print(f"  Targeting/Keywords: {len(targeting)} rows")
print(f"  Orders: {len(orders)} rows, {orders['asin'].nunique()} ASINs")

# ══════════════════════════════════════════════════════════════════════════
# 1. ASIN MASTER: Actual Sales vs Ad Sales, Organic %, Unit Economics
# ══════════════════════════════════════════════════════════════════════════
print("\n[1/6] ASIN Master Report...")

# Actual sales from orders (last 90 days to align with ads data ~Jan-Apr)
cutoff_90d = orders['order_date'].max() - timedelta(days=96)  # roughly Jan 6 to Apr 11
orders_90d = orders[orders['order_date'] >= cutoff_90d]

actual_sales = orders_90d.groupby('asin').agg(
    total_revenue=('item_price', 'sum'),
    total_units=('quantity', 'sum'),
    category=('category', 'first'),
    avg_price=('item_price', 'mean'),
    order_count=('item_price', 'count'),
).reset_index()

# 12-month sales
actual_12m = orders.groupby('asin').agg(
    revenue_12m=('item_price', 'sum'),
    units_12m=('quantity', 'sum'),
).reset_index()

# Ad sales per ASIN across all 4 months 
asin_ads = {}
for m in ['2026-01', '2026-02', '2026-03', '2026-04']:
    for r in monthly_asin.get(m, []):
        asin = r.get('advertisedAsin', '')
        if not asin:
            continue
        if asin not in asin_ads:
            asin_ads[asin] = {'ad_spend': 0, 'ad_sales': 0, 'ad_clicks': 0, 'ad_impressions': 0, 'ad_orders': 0}
        asin_ads[asin]['ad_spend'] += float(r.get('cost', 0))
        asin_ads[asin]['ad_sales'] += float(r.get('sales1d', r.get('sales', 0)))
        asin_ads[asin]['ad_clicks'] += int(r.get('clicks', 0))
        asin_ads[asin]['ad_impressions'] += int(r.get('impressions', 0))
        asin_ads[asin]['ad_orders'] += int(r.get('unitsSoldClicks1d', r.get('unitsSoldClicks', 0)))

# Per-month ads for trend
asin_monthly_ads = {}
for m in ['2026-01', '2026-02', '2026-03', '2026-04']:
    for r in monthly_asin.get(m, []):
        asin = r.get('advertisedAsin', '')
        if not asin:
            continue
        if asin not in asin_monthly_ads:
            asin_monthly_ads[asin] = {}
        days = DAYS_SP[m]
        spend = float(r.get('cost', 0))
        sales = float(r.get('sales1d', r.get('sales', 0)))
        asin_monthly_ads[asin][m] = {
            'spend': spend, 
            'sales': sales,
            'daily_spend': spend / days if days > 0 else 0,
            'roas': sales / spend if spend > 0 else 0,
        }

# ASIN to campaign mapping (duplication count)
asin_camp_map = defaultdict(set)
for r in sp_products:
    asin = r.get('advertisedAsin', '')
    camp = r.get('campaignName', '')
    if asin and camp:
        asin_camp_map[asin].add(camp)

# Merge into master
all_asins = set(actual_sales['asin'].tolist()) | set(asin_ads.keys())

asin_master = []
for asin in sorted(all_asins):
    act = actual_sales[actual_sales['asin'] == asin]
    act12 = actual_12m[actual_12m['asin'] == asin]
    ads = asin_ads.get(asin, {})
    
    revenue_90d = float(act['total_revenue'].values[0]) if len(act) > 0 else 0
    units_90d = int(act['total_units'].values[0]) if len(act) > 0 else 0
    cat_key = classify_asin(asin, '')
    category = CATEGORIES[cat_key]['display_name'] if cat_key in CATEGORIES else cat_key
    avg_price = float(act['avg_price'].values[0]) if len(act) > 0 else 0
    avg_price = float(act['avg_price'].values[0]) if len(act) > 0 else 0
    
    revenue_12m = float(act12['revenue_12m'].values[0]) if len(act12) > 0 else 0
    units_12m = int(act12['units_12m'].values[0]) if len(act12) > 0 else 0
    
    ad_spend = ads.get('ad_spend', 0)
    ad_sales = ads.get('ad_sales', 0)
    ad_clicks = ads.get('ad_clicks', 0)
    ad_impressions = ads.get('ad_impressions', 0)
    ad_orders = ads.get('ad_orders', 0)
    
    ad_roas = ad_sales / ad_spend if ad_spend > 0 else 0
    ad_acos = ad_spend / ad_sales * 100 if ad_sales > 0 else 0
    
    organic_revenue = max(0, revenue_90d - ad_sales)
    organic_pct = (organic_revenue / revenue_90d * 100) if revenue_90d > 0 else 100
    
    total_orders_90d = int(act['order_count'].values[0]) if len(act) > 0 else 0
    organic_orders = max(0, total_orders_90d - ad_orders)
    
    # Ad cost per unit sold
    ad_cost_per_unit = ad_spend / ad_orders if ad_orders > 0 else 0
    # CPC
    cpc = ad_spend / ad_clicks if ad_clicks > 0 else 0
    # CTR
    ctr = (ad_clicks / ad_impressions * 100) if ad_impressions > 0 else 0
    # Conv rate
    conv = (ad_orders / ad_clicks * 100) if ad_clicks > 0 else 0
    
    # How many campaigns is this ASIN in?
    num_campaigns = len(asin_camp_map.get(asin, set()))
    
    # Monthly trend
    ma = asin_monthly_ads.get(asin, {})
    
    # Blended ROAS
    blended_roas = revenue_90d / ad_spend if ad_spend > 0 else 0
    
    # Profit estimate (rough: revenue - ad spend - 30% amazon fees - est 20% COGS)
    # Amazon fees ~30% (referral 8-15% + FBA/shipping ~15%)
    amazon_fees_pct = 0.30
    cogs_pct = 0.20  # estimated manufacturing/procurement
    gross_revenue = revenue_90d
    amazon_fees = gross_revenue * amazon_fees_pct
    cogs = gross_revenue * cogs_pct
    profit_before_ads = gross_revenue - amazon_fees - cogs
    profit_after_ads = profit_before_ads - ad_spend
    profit_margin = (profit_after_ads / gross_revenue * 100) if gross_revenue > 0 else 0
    
    row = {
        'ASIN': asin,
        'Category': category,
        'Avg_Selling_Price': round(avg_price, 0),
        # Actual sales
        'Revenue_90d': round(revenue_90d, 0),
        'Units_90d': units_90d,
        'Orders_90d': total_orders_90d,
        'Revenue_12m': round(revenue_12m, 0),
        'Units_12m': units_12m,
        # Ad performance
        'Ad_Spend_4m': round(ad_spend, 0),
        'Ad_Sales_4m': round(ad_sales, 0),
        'Ad_ROAS': round(ad_roas, 2),
        'Ad_ACoS%': round(ad_acos, 1) if ad_acos > 0 else '',
        'Ad_Clicks': ad_clicks,
        'Ad_Impressions': ad_impressions,
        'Ad_Orders': ad_orders,
        'CPC': round(cpc, 1),
        'CTR%': round(ctr, 2),
        'Conv%': round(conv, 1),
        'Ad_Cost_Per_Unit': round(ad_cost_per_unit, 0),
        # Organic
        'Organic_Revenue_90d': round(organic_revenue, 0),
        'Organic%': round(organic_pct, 1),
        'Organic_Orders': organic_orders,
        # Blended
        'Blended_ROAS': round(blended_roas, 2),
        # Profit (estimated)
        'Est_Profit_Before_Ads': round(profit_before_ads, 0),
        'Est_Profit_After_Ads': round(profit_after_ads, 0),
        'Est_Margin%': round(profit_margin, 1),
        # Duplication
        'Num_Campaigns': num_campaigns,
        'Campaigns_List': '; '.join(sorted(asin_camp_map.get(asin, set()))) if num_campaigns > 0 else '',
        # Monthly trend (daily spend)
        'Jan_Daily_Spend': round(ma.get('2026-01', {}).get('daily_spend', 0), 0),
        'Feb_Daily_Spend': round(ma.get('2026-02', {}).get('daily_spend', 0), 0),
        'Mar_Daily_Spend': round(ma.get('2026-03', {}).get('daily_spend', 0), 0),
        'Apr_Daily_Spend': round(ma.get('2026-04', {}).get('daily_spend', 0), 0),
        'Jan_ROAS': round(ma.get('2026-01', {}).get('roas', 0), 2),
        'Feb_ROAS': round(ma.get('2026-02', {}).get('roas', 0), 2),
        'Mar_ROAS': round(ma.get('2026-03', {}).get('roas', 0), 2),
        'Apr_ROAS': round(ma.get('2026-04', {}).get('roas', 0), 2),
    }
    asin_master.append(row)

asin_master.sort(key=lambda r: r['Revenue_90d'], reverse=True)
print(f"  {len(asin_master)} ASINs in master")

# ══════════════════════════════════════════════════════════════════════════
# 2. CAMPAIGN-ASIN DUPLICATION: self-competition analysis
# ══════════════════════════════════════════════════════════════════════════
print("\n[2/6] Campaign-ASIN Duplication Report...")

dup_rows = []
for r in sp_products:
    asin = r.get('advertisedAsin', '')
    camp = r.get('campaignName', '')
    ag = r.get('adGroupName', '')
    spend = float(r.get('cost', 0))
    sales = float(r.get('sales1d', 0))
    clicks = int(r.get('clicks', 0))
    impressions = int(r.get('impressions', 0))
    orders_count = int(r.get('purchases1d', 0))
    
    sku = r.get('advertisedSku', '')
    cat_key = classify_asin(asin, sku)
    cat = CATEGORIES[cat_key]['display_name'] if cat_key in CATEGORIES else cat_key
    num_camps = len(asin_camp_map.get(asin, set()))
    
    roas = sales / spend if spend > 0 else 0
    cpc = spend / clicks if clicks > 0 else 0
    
    dup_rows.append({
        'ASIN': asin,
        'Category': cat,
        'Campaign': camp,
        'Ad_Group': ag,
        'Num_Campaigns_For_ASIN': num_camps,
        'Spend_30d': round(spend, 0),
        'Sales_30d': round(sales, 0),
        'ROAS': round(roas, 2),
        'Clicks': clicks,
        'Impressions': impressions,
        'Orders': orders_count,
        'CPC': round(cpc, 1),
        'Is_Duplicated': 'YES' if num_camps > 5 else 'NO',
    })

dup_rows.sort(key=lambda r: (-r['Num_Campaigns_For_ASIN'], r['ASIN'], -r['Spend_30d']))
print(f"  {len(dup_rows)} ASIN-campaign combinations")

# ══════════════════════════════════════════════════════════════════════════
# 3. SEARCH TERM ANALYSIS: duplication, waste, opportunities
# ══════════════════════════════════════════════════════════════════════════
print("\n[3/6] Search Term Analysis...")

# Group search terms
st_data = defaultdict(lambda: {'campaigns': set(), 'total_spend': 0, 'total_sales': 0, 'total_clicks': 0, 'total_impressions': 0, 'total_orders': 0, 'entries': []})
for r in search_terms:
    st = r.get('searchTerm', '').strip()
    camp = r.get('campaignName', '')
    spend = float(r.get('cost', 0))
    sales = float(r.get('sales1d', 0))
    clicks = int(r.get('clicks', 0))
    impressions = int(r.get('impressions', 0))
    orders_count = int(r.get('purchases1d', 0))
    ag = r.get('adGroupName', '')
    
    d = st_data[st]
    d['campaigns'].add(camp)
    d['total_spend'] += spend
    d['total_sales'] += sales
    d['total_clicks'] += clicks
    d['total_impressions'] += impressions
    d['total_orders'] += orders_count
    d['entries'].append({
        'campaign': camp,
        'ad_group': ag,
        'spend': spend,
        'sales': sales,
        'clicks': clicks,
    })

st_rows = []
for st, d in st_data.items():
    roas = d['total_sales'] / d['total_spend'] if d['total_spend'] > 0 else 0
    acos = (d['total_spend'] / d['total_sales'] * 100) if d['total_sales'] > 0 else (999 if d['total_spend'] > 0 else 0)
    ctr = (d['total_clicks'] / d['total_impressions'] * 100) if d['total_impressions'] > 0 else 0
    conv = (d['total_orders'] / d['total_clicks'] * 100) if d['total_clicks'] > 0 else 0
    num_camps = len(d['campaigns'])
    
    # Classify the search term
    cat_key = 'UNCATEGORIZED'
    for c in d['campaigns']:
        ck = classify_campaign(c)
        if ck != 'UNCATEGORIZED':
            cat_key = ck
            break
    cat = CATEGORIES[cat_key]['display_name'] if cat_key in CATEGORIES else cat_key
    
    # Determine action
    if d['total_spend'] > 50 and roas < 1:
        action = "NEGATE - Losing money"
    elif d['total_spend'] > 100 and roas < 2:
        action = "NEGATE or REDUCE BID"
    elif num_camps >= 3 and d['total_spend'] > 50:
        action = f"DEDUPLICATE - In {num_camps} campaigns (self-competition)"
    elif d['total_clicks'] >= 10 and d['total_orders'] == 0:
        action = "NEGATE - Clicks but no orders"
    elif roas >= 8 and d['total_spend'] > 0:
        action = "SCALE - High ROAS keyword"
    elif roas >= 5 and num_camps == 1:
        action = "EXPAND - Good keyword, add to more campaigns"
    else:
        action = "MONITOR"
    
    # Is it a branded/ASIN search?
    st_lower = st.lower()
    is_asin = st_lower.startswith('b0') and len(st) == 10
    is_branded = any(b in st_lower for b in ['ehomekart', 'emount', 'ehk'])
    
    st_rows.append({
        'Search_Term': st,
        'Category': cat,
        'Action': action,
        'Num_Campaigns': num_camps,
        'Total_Spend': round(d['total_spend'], 0),
        'Total_Sales': round(d['total_sales'], 0),
        'ROAS': round(roas, 2),
        'ACoS%': round(acos, 1) if acos < 999 else 'N/A',
        'Total_Clicks': d['total_clicks'],
        'Total_Impressions': d['total_impressions'],
        'Total_Orders': d['total_orders'],
        'CTR%': round(ctr, 2),
        'Conv%': round(conv, 1),
        'Is_ASIN_Target': 'YES' if is_asin else '',
        'Is_Branded': 'YES' if is_branded else '',
        'Campaigns': '; '.join(sorted(d['campaigns'])),
    })

st_rows.sort(key=lambda r: r['Total_Spend'], reverse=True)
print(f"  {len(st_rows)} unique search terms")

# ══════════════════════════════════════════════════════════════════════════
# 4. KEYWORD BID ANALYSIS
# ══════════════════════════════════════════════════════════════════════════
print("\n[4/6] Keyword Bid Analysis...")

kw_rows = []
for r in targeting:
    keyword = r.get('keyword', '') or r.get('targeting', '')
    bid = float(r.get('keywordBid', 0))
    spend = float(r.get('cost', 0))
    sales = float(r.get('sales1d', 0))
    clicks = int(r.get('clicks', 0))
    impressions = int(r.get('impressions', 0))
    orders_count = int(r.get('purchases1d', 0))
    match_type = r.get('matchType', '')
    camp = r.get('campaignName', '')
    ag = r.get('adGroupName', '')
    kw_type = r.get('keywordType', '')
    
    actual_cpc = spend / clicks if clicks > 0 else 0
    roas = sales / spend if spend > 0 else 0
    acos = (spend / sales * 100) if sales > 0 else (999 if spend > 0 else 0)
    conv = (orders_count / clicks * 100) if clicks > 0 else 0
    ctr = (clicks / impressions * 100) if impressions > 0 else 0
    
    # Bid analysis
    if bid > 0 and actual_cpc > 0:
        bid_vs_actual = ((bid - actual_cpc) / actual_cpc * 100)
    else:
        bid_vs_actual = 0
    
    # Determine action
    if spend > 50 and roas < 1:
        action = "PAUSE/NEGATE - Losing money"
    elif spend > 100 and roas < 2:
        action = "REDUCE BID 30%"
    elif bid > actual_cpc * 2 and clicks > 5:
        action = "OVERBIDDING - Reduce bid to actual CPC + 20%"
    elif roas >= 8 and impressions > 100:
        action = "INCREASE BID 20% - Star keyword"
    elif clicks > 20 and orders_count == 0:
        action = "NEGATE - High clicks, zero orders"
    else:
        action = "MONITOR"
    
    cat_key = classify_campaign(camp)
    cat = CATEGORIES[cat_key]['display_name'] if cat_key in CATEGORIES else cat_key
    
    kw_rows.append({
        'Keyword': keyword,
        'Match_Type': match_type,
        'Keyword_Type': kw_type,
        'Campaign': camp,
        'Ad_Group': ag,
        'Category': cat,
        'Action': action,
        'Bid': round(bid, 2),
        'Actual_CPC': round(actual_cpc, 2),
        'Bid_vs_CPC%': round(bid_vs_actual, 0),
        'Spend': round(spend, 0),
        'Sales': round(sales, 0),
        'ROAS': round(roas, 2),
        'ACoS%': round(acos, 1) if acos < 999 else 'N/A',
        'Clicks': clicks,
        'Impressions': impressions,
        'Orders': orders_count,
        'CTR%': round(ctr, 2),
        'Conv%': round(conv, 1),
    })

kw_rows.sort(key=lambda r: r['Spend'], reverse=True)
print(f"  {len(kw_rows)} keyword-campaign combinations")

# ══════════════════════════════════════════════════════════════════════════
# 5. CATEGORY P&L: Unit Economics
# ══════════════════════════════════════════════════════════════════════════
print("\n[5/6] Category P&L...")

cat_pl = []
for cat_key, cat_info in CATEGORIES.items():
    cat_name = cat_info['display_name']
    
    # Orders data (match on cat_key since orders has cat_key column)
    cat_orders = orders[orders['cat_key'] == cat_key]
    cat_orders_90d = orders_90d[orders_90d['cat_key'] == cat_key]
    
    revenue_12m = cat_orders['item_price'].sum()
    units_12m = cat_orders['quantity'].sum()
    revenue_90d = cat_orders_90d['item_price'].sum()
    units_90d = cat_orders_90d['quantity'].sum()
    
    avg_price = revenue_90d / units_90d if units_90d > 0 else 0
    
    # Monthly revenue
    monthly_rev = {}
    for m in ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']:
        mr = cat_orders[cat_orders['month'] == m]['item_price'].sum()
        mu = cat_orders[cat_orders['month'] == m]['quantity'].sum()
        monthly_rev[m] = {'revenue': mr, 'units': mu}
    
    # Ads data (all 4 months)
    total_ad_spend = 0
    total_ad_sales = 0
    total_ad_clicks = 0
    total_ad_impressions = 0
    total_ad_orders = 0
    monthly_ads = {}
    for m in ['2026-01', '2026-02', '2026-03', '2026-04']:
        m_spend = 0
        m_sales = 0
        m_clicks = 0
        m_impr = 0
        m_orders = 0
        for r in monthly_asin.get(m, []):
            asin = r.get('advertisedAsin', '')
            sku = r.get('advertisedSku', '')
            if classify_asin(asin, sku) == cat_key:
                s = float(r.get('cost', 0))
                sl = float(r.get('sales1d', r.get('sales', 0)))
                m_spend += s
                m_sales += sl
                m_clicks += int(r.get('clicks', 0))
                m_impr += int(r.get('impressions', 0))
                m_orders += int(r.get('unitsSoldClicks1d', r.get('unitsSoldClicks', 0)))
        # Add SD
        for r in monthly_sd.get(m, []):
            cname = r.get('campaignName', '')
            if classify_campaign(cname) == cat_key:
                s = float(r.get('cost', 0))
                sl_key = 'sales1d' if 'sales1d' in r else 'sales'
                sl = float(r.get(sl_key, 0))
                m_spend += s
                m_sales += sl
                m_clicks += int(r.get('clicks', 0))
                m_impr += int(r.get('impressions', 0))
        
        days = DAYS_SP[m]
        monthly_ads[m] = {
            'spend': m_spend, 'sales': m_sales, 'clicks': m_clicks,
            'daily_spend': m_spend / days if days > 0 else 0,
            'roas': m_sales / m_spend if m_spend > 0 else 0,
            'acos': (m_spend / m_sales * 100) if m_sales > 0 else 0,
            'cpc': m_spend / m_clicks if m_clicks > 0 else 0,
        }
        total_ad_spend += m_spend
        total_ad_sales += m_sales
        total_ad_clicks += m_clicks
        total_ad_impressions += m_impr
        total_ad_orders += m_orders
    
    # Unit economics
    amazon_fees_pct = 0.30
    cogs_pct = 0.20
    profit_per_unit_before_ads = avg_price * (1 - amazon_fees_pct - cogs_pct)
    ad_cost_per_unit = total_ad_spend / total_ad_orders if total_ad_orders > 0 else 0
    profit_per_ad_unit = profit_per_unit_before_ads - ad_cost_per_unit
    profit_per_organic_unit = profit_per_unit_before_ads
    
    organic_revenue = max(0, revenue_90d - total_ad_sales)
    organic_pct = (organic_revenue / revenue_90d * 100) if revenue_90d > 0 else 100
    
    total_profit_90d = (revenue_90d * (1 - amazon_fees_pct - cogs_pct)) - total_ad_spend
    margin = (total_profit_90d / revenue_90d * 100) if revenue_90d > 0 else 0
    
    # Number of active advertised ASINs
    advertised_asins = set()
    for r in sp_products:
        a = r.get('advertisedAsin', '')
        s = r.get('advertisedSku', '')
        if classify_asin(a, s) == cat_key:
            advertised_asins.add(a)
    
    # Total ASINs selling
    all_selling_asins = cat_orders_90d['asin'].nunique()
    not_advertised = all_selling_asins - len(advertised_asins)
    
    target_acos = cat_info['target_acos']
    target_roas = cat_info['target_ads_roi']
    target_blended = cat_info['target_blended_roi']
    actual_roas = total_ad_sales / total_ad_spend if total_ad_spend > 0 else 0
    actual_acos = (total_ad_spend / total_ad_sales * 100) if total_ad_sales > 0 else 0
    blended_roas = revenue_90d / total_ad_spend if total_ad_spend > 0 else 0
    
    cat_pl.append({
        'Category': cat_name,
        'Avg_Selling_Price': round(avg_price, 0),
        'Revenue_12m': round(revenue_12m, 0),
        'Units_12m': units_12m,
        'Revenue_90d': round(revenue_90d, 0),
        'Units_90d': units_90d,
        # Monthly revenue
        'Nov_Revenue': round(monthly_rev['2025-11']['revenue'], 0),
        'Dec_Revenue': round(monthly_rev['2025-12']['revenue'], 0),
        'Jan_Revenue': round(monthly_rev['2026-01']['revenue'], 0),
        'Feb_Revenue': round(monthly_rev['2026-02']['revenue'], 0),
        'Mar_Revenue': round(monthly_rev['2026-03']['revenue'], 0),
        'Apr_Revenue_11d': round(monthly_rev['2026-04']['revenue'], 0),
        # Ads performance
        'Total_Ad_Spend': round(total_ad_spend, 0),
        'Total_Ad_Sales': round(total_ad_sales, 0),
        'Ads_ROAS': round(actual_roas, 2),
        'Ads_ACoS%': round(actual_acos, 1),
        'Target_ACoS%': target_acos,
        'Target_Ads_ROAS': target_roas,
        'Blended_ROAS': round(blended_roas, 2),
        'Target_Blended_ROAS': target_blended,
        # Monthly ads trend (daily)
        'Jan_Daily_Spend': round(monthly_ads['2026-01']['daily_spend'], 0),
        'Feb_Daily_Spend': round(monthly_ads['2026-02']['daily_spend'], 0),
        'Mar_Daily_Spend': round(monthly_ads['2026-03']['daily_spend'], 0),
        'Apr_Daily_Spend': round(monthly_ads['2026-04']['daily_spend'], 0),
        'Jan_ROAS': round(monthly_ads['2026-01']['roas'], 2),
        'Feb_ROAS': round(monthly_ads['2026-02']['roas'], 2),
        'Mar_ROAS': round(monthly_ads['2026-03']['roas'], 2),
        'Apr_ROAS': round(monthly_ads['2026-04']['roas'], 2),
        'Jan_CPC': round(monthly_ads['2026-01']['cpc'], 1),
        'Feb_CPC': round(monthly_ads['2026-02']['cpc'], 1),
        'Mar_CPC': round(monthly_ads['2026-03']['cpc'], 1),
        'Apr_CPC': round(monthly_ads['2026-04']['cpc'], 1),
        # Organic
        'Organic_Revenue_90d': round(organic_revenue, 0),
        'Organic%': round(organic_pct, 1),
        # Unit economics
        'Profit_Per_Unit_Before_Ads': round(profit_per_unit_before_ads, 0),
        'Ad_Cost_Per_Unit_Sold': round(ad_cost_per_unit, 0),
        'Profit_Per_Ad_Unit': round(profit_per_ad_unit, 0),
        'Profit_Per_Organic_Unit': round(profit_per_organic_unit, 0),
        'Total_Est_Profit_90d': round(total_profit_90d, 0),
        'Est_Margin%': round(margin, 1),
        # Coverage
        'Total_Selling_ASINs': all_selling_asins,
        'Advertised_ASINs': len(advertised_asins),
        'Not_Advertised_ASINs': not_advertised,
    })

cat_pl.sort(key=lambda r: r['Revenue_12m'], reverse=True)
print(f"  {len(cat_pl)} categories")

# ══════════════════════════════════════════════════════════════════════════
# 6. COMPETITOR TARGETING: what competitor ASINs are we targeting?
# ══════════════════════════════════════════════════════════════════════════
print("\n[6/6] Competitor Targeting Analysis...")

# Extract ASIN targets from search terms and targeting
comp_rows = []
for r in search_terms:
    st = r.get('searchTerm', '').strip()
    if st.upper().startswith('B0') and len(st) == 10:
        # This is an ASIN target
        camp = r.get('campaignName', '')
        spend = float(r.get('cost', 0))
        sales = float(r.get('sales1d', 0))
        clicks = int(r.get('clicks', 0))
        impressions = int(r.get('impressions', 0))
        orders_count = int(r.get('purchases1d', 0))
        roas = sales / spend if spend > 0 else 0
        cpc = spend / clicks if clicks > 0 else 0
        conv = (orders_count / clicks * 100) if clicks > 0 else 0
        
        # Is it our own ASIN?
        is_own = st.upper() in asin_camp_map or st.upper() in set(orders['asin'].unique())
        
        comp_rows.append({
            'Competitor_ASIN': st.upper(),
            'Campaign': camp,
            'Is_Own_ASIN': 'YES' if is_own else 'NO',
            'Spend': round(spend, 0),
            'Sales': round(sales, 0),
            'ROAS': round(roas, 2),
            'Clicks': clicks,
            'Impressions': impressions,
            'Orders': orders_count,
            'CPC': round(cpc, 1),
            'Conv%': round(conv, 1),
            'Action': 'OWN ASIN - NEGATE' if is_own else ('SCALE' if roas > 5 else 'MONITOR' if roas > 2 else ('NEGATE' if spend > 50 and roas < 1 else 'MONITOR')),
        })

# Also check from targeting data
for r in targeting:
    tgt = r.get('targeting', '')
    if tgt and tgt.upper().startswith('B0') and len(tgt) == 10:
        camp = r.get('campaignName', '')
        spend = float(r.get('cost', 0))
        sales = float(r.get('sales1d', 0))
        clicks = int(r.get('clicks', 0))
        impressions = int(r.get('impressions', 0))
        orders_count = int(r.get('purchases1d', 0))
        roas = sales / spend if spend > 0 else 0
        
        is_own = tgt.upper() in asin_camp_map or tgt.upper() in set(orders['asin'].unique())
        
        comp_rows.append({
            'Competitor_ASIN': tgt.upper(),
            'Campaign': camp,
            'Is_Own_ASIN': 'YES' if is_own else 'NO',
            'Spend': round(spend, 0),
            'Sales': round(sales, 0),
            'ROAS': round(roas, 2),
            'Clicks': clicks,
            'Impressions': impressions,
            'Orders': orders_count,
            'CPC': round(spend / clicks if clicks > 0 else 0, 1),
            'Conv%': round(orders_count / clicks * 100 if clicks > 0 else 0, 1),
            'Action': 'OWN ASIN - NEGATE' if is_own else ('SCALE' if roas > 5 else 'MONITOR' if roas > 2 else ('NEGATE' if spend > 50 and roas < 1 else 'MONITOR')),
        })

comp_rows.sort(key=lambda r: r['Spend'], reverse=True)
print(f"  {len(comp_rows)} competitor ASIN targeting entries")

# ══════════════════════════════════════════════════════════════════════════
# WRITE ALL CSVs
# ══════════════════════════════════════════════════════════════════════════
def write_csv(filename, rows):
    if not rows:
        print(f"SKIP: {filename} (no data)")
        return
    fpath = os.path.join(OUT_DIR, filename)
    with open(fpath, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    print(f"  Saved: {filename} ({len(rows)} rows)")

print("\nWriting CSVs...")
write_csv('master_asin_report.csv', asin_master)
write_csv('master_duplication_report.csv', dup_rows)
write_csv('master_search_terms.csv', st_rows)
write_csv('master_keyword_bids.csv', kw_rows)
write_csv('master_category_pl.csv', cat_pl)
write_csv('master_competitor_targeting.csv', comp_rows)

# ══════════════════════════════════════════════════════════════════════════
# PRINT KEY FINDINGS SUMMARY
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 80)
print("  KEY FINDINGS SUMMARY")
print("=" * 80)

# Duplication issue
dup_asins = sum(1 for a in asin_camp_map.values() if len(a) > 10)
print(f"\n  DUPLICATION: {dup_asins} ASINs are in 10+ campaigns (bidding against yourself)")
total_dup_spend = sum(r['Spend_30d'] for r in dup_rows if r['Num_Campaigns_For_ASIN'] > 10)
print(f"  These duplicated ASINs account for Rs {total_dup_spend:,.0f} in 30-day spend")

# Search term waste
waste_st = [r for r in st_rows if 'NEGATE' in r['Action']]
waste_spend = sum(r['Total_Spend'] for r in waste_st)
print(f"\n  WASTED SEARCH TERMS: {len(waste_st)} terms should be negated")
print(f"  Total waste on bad search terms: Rs {waste_spend:,.0f}")

# Keyword overbidding
overbid = [r for r in kw_rows if 'OVERBID' in r['Action']]
print(f"\n  OVERBIDDING: {len(overbid)} keywords with bid > 2x actual CPC")

# Unadvertised ASINs
total_unadv = sum(r['Not_Advertised_ASINs'] for r in cat_pl)
print(f"\n  UNADVERTISED: {total_unadv} selling ASINs have ZERO ads")

# Competitor targeting waste
own_asin_targets = [r for r in comp_rows if r['Is_Own_ASIN'] == 'YES']
own_waste = sum(r['Spend'] for r in own_asin_targets)
print(f"\n  OWN ASIN TARGETING: {len(own_asin_targets)} entries targeting our own ASINs (waste: Rs {own_waste:,.0f})")

# Profit summary
total_profit = sum(r['Total_Est_Profit_90d'] for r in cat_pl)
total_rev = sum(r['Revenue_90d'] for r in cat_pl)
avg_margin = (total_profit / total_rev * 100) if total_rev > 0 else 0
print(f"\n  PROFIT: Rs {total_profit:,.0f} estimated profit on Rs {total_rev:,.0f} revenue (90d)")
print(f"  Average margin: {avg_margin:.1f}%")

print("\n" + "=" * 80)
print("  ALL 6 MASTER CSVs SAVED")
print("=" * 80)
