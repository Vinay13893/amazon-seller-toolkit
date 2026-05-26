"""
Action Report — Properly prorated, comparing ALL months (Jan-Apr 2026)
======================================================================
- Jan SP: 26 days (from Jan 6), no SD
- Feb: 28 days SP, 24 days SD (from Feb 5)
- Mar: 31 days (full)
- Apr: 11 days (Apr 1-11)

All comparisons use DAILY AVERAGES for fair comparison.
"""
import os, sys, json, csv
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from category_analysis.categories import classify_asin, classify_campaign, CATEGORIES

ADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "amazon_ads_tool", "reports", "monthly")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUT_DIR, exist_ok=True)

months = ['2026-01', '2026-02', '2026-03', '2026-04']

# Days per month for prorating
DAYS_SP = {'2026-01': 26, '2026-02': 28, '2026-03': 31, '2026-04': 11}
DAYS_SD = {'2026-01': 0, '2026-02': 24, '2026-03': 31, '2026-04': 11}
FULL_MONTH = 30  # normalize to 30-day month

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


# ======================================================================
# SHEET 1: ASIN Performance (SP advertised product level)
# ======================================================================
asin_data = {}
for m in months:
    for row in data[m].get('sp_advertised_product', []):
        asin = row.get('advertisedAsin', '')
        if not asin:
            continue
        sku = row.get('advertisedSku', '')
        cat = classify_asin(asin, sku)
        if asin not in asin_data:
            asin_data[asin] = {'category': cat, 'sku': sku}
        d = asin_data[asin]
        d[f'{m}_spend'] = float(row.get('cost', 0))
        d[f'{m}_sales'] = float(row.get('sales', 0))
        d[f'{m}_clicks'] = int(row.get('clicks', 0))
        d[f'{m}_impressions'] = int(row.get('impressions', 0))
        d[f'{m}_orders'] = int(row.get('unitsSoldClicks', 0))

asin_rows = []
for asin, d in asin_data.items():
    total_spend = sum(d.get(f'{m}_spend', 0) for m in months)
    total_sales = sum(d.get(f'{m}_sales', 0) for m in months)
    total_clicks = sum(d.get(f'{m}_clicks', 0) for m in months)
    total_impressions = sum(d.get(f'{m}_impressions', 0) for m in months)
    total_orders = sum(d.get(f'{m}_orders', 0) for m in months)
    roas = total_sales / total_spend if total_spend > 0 else 0
    acos = (total_spend / total_sales * 100) if total_sales > 0 else 999
    ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
    conv = (total_orders / total_clicks * 100) if total_clicks > 0 else 0

    # Per-month DAILY averages
    monthly_daily = {}
    for m in months:
        ms = d.get(f'{m}_spend', 0)
        msl = d.get(f'{m}_sales', 0)
        days = DAYS_SP[m]
        monthly_daily[m] = {
            'daily_spend': ms / days if days > 0 else 0,
            'daily_sales': msl / days if days > 0 else 0,
            'roas': msl / ms if ms > 0 else 0,
            'projected_spend': ms / days * FULL_MONTH if days > 0 else 0,
            'projected_sales': msl / days * FULL_MONTH if days > 0 else 0,
        }

    jan_daily = monthly_daily['2026-01']['daily_spend']
    feb_daily = monthly_daily['2026-02']['daily_spend']
    mar_daily = monthly_daily['2026-03']['daily_spend']
    apr_daily = monthly_daily['2026-04']['daily_spend']

    jan_roas = monthly_daily['2026-01']['roas']
    feb_roas = monthly_daily['2026-02']['roas']
    mar_roas = monthly_daily['2026-03']['roas']
    apr_roas = monthly_daily['2026-04']['roas']

    # Average of prior months (those with spend)
    prior_dailies = [x for x in [jan_daily, feb_daily, mar_daily] if x > 0]
    avg_prior_daily = sum(prior_dailies) / len(prior_dailies) if prior_dailies else 0
    prior_roas = [x for x in [jan_roas, feb_roas, mar_roas] if x > 0]
    avg_prior_roas = sum(prior_roas) / len(prior_roas) if prior_roas else 0

    spend_change_vs_avg = ((apr_daily - avg_prior_daily) / avg_prior_daily * 100) if avg_prior_daily > 0 and apr_daily > 0 else 0
    roas_change_vs_avg = apr_roas - avg_prior_roas if avg_prior_roas > 0 and apr_roas > 0 else 0

    # ROAS trend direction
    active_roas = [(m, monthly_daily[m]['roas']) for m in months if monthly_daily[m]['roas'] > 0]
    if len(active_roas) >= 2:
        first_roas = active_roas[0][1]
        last_roas = active_roas[-1][1]
        if last_roas > first_roas * 1.15:
            roas_trend = "IMPROVING"
        elif last_roas < first_roas * 0.7:
            roas_trend = "DECLINING"
        else:
            roas_trend = "STABLE"
    else:
        roas_trend = "NEW"

    # Determine action
    if roas < 2:
        action = "PAUSE - ROAS < 2x"
        priority = "TODAY"
    elif roas < 3 and total_spend > 2000:
        action = "CUT BID 30% - Bleeder"
        priority = "TODAY"
    elif roas >= 10 and total_spend > 1000:
        action = "SCALE +20% bid - Star ASIN"
        priority = "THIS WEEK"
    elif roas_trend == "DECLINING" and apr_daily > avg_prior_daily * 1.3:
        action = "CUT BID 25% - Scaling with declining ROAS"
        priority = "TODAY"
    elif spend_change_vs_avg > 100 and apr_roas < avg_prior_roas * 0.8:
        action = "CUT BID 30% - Spend doubled, ROAS dropped"
        priority = "TODAY"
    elif spend_change_vs_avg > 100:
        action = "REVIEW - Spend ramped vs avg"
        priority = "THIS WEEK"
    elif roas_trend == "IMPROVING" and roas > 5:
        action = "SCALE +15% - Improving trend"
        priority = "THIS WEEK"
    else:
        action = "MONITOR"
        priority = ""

    row = {
        'ASIN': asin,
        'Category': d['category'],
        'Action': action,
        'Priority': priority,
        'ROAS_Trend': roas_trend,
        'Total_Spend_Raw': round(total_spend, 0),
        'Total_Ad_Sales_Raw': round(total_sales, 0),
        'Overall_ROAS': round(roas, 2),
        'Overall_ACoS%': round(acos, 1) if acos < 999 else 'N/A',
        'CTR%': round(ctr, 2),
        'Conv%': round(conv, 1),
        # Jan (26 days)
        'Jan_Spend_26d': round(d.get('2026-01_spend', 0), 0),
        'Jan_Daily_Spend': round(jan_daily, 0),
        'Jan_Proj_30d': round(monthly_daily['2026-01']['projected_spend'], 0),
        'Jan_ROAS': round(jan_roas, 2),
        # Feb (28 days)
        'Feb_Spend_28d': round(d.get('2026-02_spend', 0), 0),
        'Feb_Daily_Spend': round(feb_daily, 0),
        'Feb_Proj_30d': round(monthly_daily['2026-02']['projected_spend'], 0),
        'Feb_ROAS': round(feb_roas, 2),
        # Mar (31 days)
        'Mar_Spend_31d': round(d.get('2026-03_spend', 0), 0),
        'Mar_Daily_Spend': round(mar_daily, 0),
        'Mar_Proj_30d': round(monthly_daily['2026-03']['projected_spend'], 0),
        'Mar_ROAS': round(mar_roas, 2),
        # Apr (11 days)
        'Apr_Spend_11d': round(d.get('2026-04_spend', 0), 0),
        'Apr_Daily_Spend': round(apr_daily, 0),
        'Apr_Proj_30d': round(monthly_daily['2026-04']['projected_spend'], 0),
        'Apr_ROAS': round(apr_roas, 2),
        # Comparisons
        'Avg_Prior_Daily_Spend': round(avg_prior_daily, 0),
        'Apr_vs_AvgPrior_Spend%': round(spend_change_vs_avg, 0) if avg_prior_daily > 0 and apr_daily > 0 else '',
        'Avg_Prior_ROAS': round(avg_prior_roas, 2),
        'Apr_ROAS_vs_Avg': round(roas_change_vs_avg, 2) if avg_prior_roas > 0 and apr_roas > 0 else '',
    }
    asin_rows.append(row)

asin_rows.sort(key=lambda r: r['Total_Spend_Raw'], reverse=True)

# ======================================================================
# SHEET 2: Campaign Performance (SP + SD)
# ======================================================================
camp_rows = []
for camp_type in ['sp_campaigns', 'sd_campaigns']:
    label = 'SP' if 'sp' in camp_type else 'SD'
    rtype = 'sp' if label == 'SP' else 'sd'
    DAYS = DAYS_SP if rtype == 'sp' else DAYS_SD
    all_camps = {}
    for m in months:
        days = DAYS[m]
        for c in data[m].get(camp_type, []):
            name = c.get('campaignName', 'Unknown')
            if name not in all_camps:
                all_camps[name] = {'type': label, 'status': c.get('campaignStatus', '')}
            d = all_camps[name]
            spend = float(c.get('cost', 0))
            sales_key = 'sales1d' if 'sales1d' in c else 'sales'
            sales = float(c.get(sales_key, 0))
            d[f'{m}_spend'] = spend
            d[f'{m}_sales'] = sales
            d[f'{m}_clicks'] = int(c.get('clicks', 0))
            d[f'{m}_impressions'] = int(c.get('impressions', 0))
            d[f'{m}_days'] = days
            d[f'{m}_daily_spend'] = spend / days if days > 0 else 0
            d[f'{m}_daily_sales'] = sales / days if days > 0 else 0
            d[f'{m}_roas'] = sales / spend if spend > 0 else 0

    for name, d in all_camps.items():
        total_spend = sum(d.get(f'{m}_spend', 0) for m in months)
        total_sales = sum(d.get(f'{m}_sales', 0) for m in months)
        roas = total_sales / total_spend if total_spend > 0 else 0
        cat = classify_campaign(name)

        jan_daily = d.get('2026-01_daily_spend', 0)
        feb_daily = d.get('2026-02_daily_spend', 0)
        mar_daily = d.get('2026-03_daily_spend', 0)
        apr_daily = d.get('2026-04_daily_spend', 0)

        jan_roas = d.get('2026-01_roas', 0)
        feb_roas = d.get('2026-02_roas', 0)
        mar_roas = d.get('2026-03_roas', 0)
        apr_roas = d.get('2026-04_roas', 0)

        prior_ds = [x for x in [jan_daily, feb_daily, mar_daily] if x > 0]
        avg_prior_daily = sum(prior_ds) / len(prior_ds) if prior_ds else 0
        prior_rs = [x for x in [jan_roas, feb_roas, mar_roas] if x > 0]
        avg_prior_roas = sum(prior_rs) / len(prior_rs) if prior_rs else 0

        spend_pct = ((apr_daily - avg_prior_daily) / avg_prior_daily * 100) if avg_prior_daily > 0 and apr_daily > 0 else 0

        if total_spend == 0:
            action = "INACTIVE"
        elif label == 'SD' and roas > 5:
            action = "SCALE SD +30%"
        elif spend_pct > 150 and apr_roas < avg_prior_roas * 0.7:
            action = f"CUT - Spend UP {spend_pct:.0f}% with ROAS declining"
        elif spend_pct > 100:
            action = f"REVIEW - Daily spend UP {spend_pct:.0f}% vs avg"
        else:
            action = "MONITOR"

        camp_rows.append({
            'Campaign': name,
            'Type': label,
            'Category': cat,
            'Status': d.get('status', ''),
            'Action': action,
            'Total_Spend_Raw': round(total_spend, 0),
            'Total_Sales_Raw': round(total_sales, 0),
            'Overall_ROAS': round(roas, 2),
            # Jan
            'Jan_Spend': round(d.get('2026-01_spend', 0), 0),
            'Jan_Daily': round(jan_daily, 0),
            'Jan_Proj_30d': round(jan_daily * 30, 0),
            'Jan_ROAS': round(jan_roas, 2),
            # Feb
            'Feb_Spend': round(d.get('2026-02_spend', 0), 0),
            'Feb_Daily': round(feb_daily, 0),
            'Feb_Proj_30d': round(feb_daily * 30, 0),
            'Feb_ROAS': round(feb_roas, 2),
            # Mar
            'Mar_Spend': round(d.get('2026-03_spend', 0), 0),
            'Mar_Daily': round(mar_daily, 0),
            'Mar_Proj_30d': round(mar_daily * 30, 0),
            'Mar_ROAS': round(mar_roas, 2),
            # Apr (11 days)
            'Apr_Spend_11d': round(d.get('2026-04_spend', 0), 0),
            'Apr_Daily': round(apr_daily, 0),
            'Apr_Proj_30d': round(apr_daily * 30, 0),
            'Apr_ROAS': round(apr_roas, 2),
            # Comparisons
            'Avg_Prior_Daily': round(avg_prior_daily, 0),
            'Apr_vs_AvgPrior%': round(spend_pct, 0) if avg_prior_daily > 0 and apr_daily > 0 else '',
            'Avg_Prior_ROAS': round(avg_prior_roas, 2),
        })

camp_rows.sort(key=lambda r: r['Total_Spend_Raw'], reverse=True)

# ======================================================================
# SHEET 3: Category Monthly Trend (prorated)
# ======================================================================
cat_rows = []
for m in months:
    cat_agg = defaultdict(lambda: {'spend': 0, 'sales': 0, 'clicks': 0, 'impressions': 0, 'orders': 0, 'sp_spend': 0, 'sd_spend': 0, 'sp_sales': 0, 'sd_sales': 0})

    # SP ASIN level
    for row in data[m].get('sp_advertised_product', []):
        asin = row.get('advertisedAsin', '')
        sku = row.get('advertisedSku', '')
        cat = classify_asin(asin, sku)
        s = float(row.get('cost', 0))
        sl = float(row.get('sales', 0))
        cat_agg[cat]['spend'] += s
        cat_agg[cat]['sales'] += sl
        cat_agg[cat]['sp_spend'] += s
        cat_agg[cat]['sp_sales'] += sl
        cat_agg[cat]['clicks'] += int(row.get('clicks', 0))
        cat_agg[cat]['impressions'] += int(row.get('impressions', 0))
        cat_agg[cat]['orders'] += int(row.get('unitsSoldClicks', 0))

    # SD campaign level
    for row in data[m].get('sd_campaigns', []):
        cname = row.get('campaignName', '')
        cat = classify_campaign(cname)
        s = float(row.get('cost', 0))
        sales_key = 'sales1d' if 'sales1d' in row else 'sales'
        sl = float(row.get(sales_key, 0))
        cat_agg[cat]['spend'] += s
        cat_agg[cat]['sales'] += sl
        cat_agg[cat]['sd_spend'] += s
        cat_agg[cat]['sd_sales'] += sl
        cat_agg[cat]['clicks'] += int(row.get('clicks', 0))
        cat_agg[cat]['impressions'] += int(row.get('impressions', 0))

    sp_days = DAYS_SP[m]

    for cat, vals in cat_agg.items():
        if vals['spend'] == 0:
            continue
        days = sp_days
        roas = vals['sales'] / vals['spend'] if vals['spend'] > 0 else 0
        acos = (vals['spend'] / vals['sales'] * 100) if vals['sales'] > 0 else 0
        cpc = vals['spend'] / vals['clicks'] if vals['clicks'] > 0 else 0
        ctr = (vals['clicks'] / vals['impressions'] * 100) if vals['impressions'] > 0 else 0
        conv = (vals['orders'] / vals['clicks'] * 100) if vals['clicks'] > 0 else 0

        daily_spend = vals['spend'] / days if days > 0 else 0
        daily_sales = vals['sales'] / days if days > 0 else 0

        target_acos = 0
        target_roas = 0
        for k, v in CATEGORIES.items():
            if v['display_name'] == cat:
                target_acos = v['target_acos']
                target_roas = v['target_ads_roi']
                break

        cat_rows.append({
            'Month': m,
            'Days_in_Period': days,
            'Category': cat,
            'Raw_Spend': round(vals['spend'], 0),
            'Raw_Sales': round(vals['sales'], 0),
            'Daily_Spend': round(daily_spend, 0),
            'Daily_Ad_Sales': round(daily_sales, 0),
            'Proj_30d_Spend': round(daily_spend * 30, 0),
            'Proj_30d_Sales': round(daily_sales * 30, 0),
            'ROAS': round(roas, 2),
            'ACoS%': round(acos, 1),
            'Target_ACoS%': target_acos,
            'ACoS_vs_Target': round(acos - target_acos, 1) if target_acos > 0 else '',
            'Target_ROAS': target_roas,
            'CPC': round(cpc, 1),
            'CTR%': round(ctr, 2),
            'Conv%': round(conv, 1),
            'Clicks': vals['clicks'],
            'Impressions': vals['impressions'],
            'SP_Spend': round(vals['sp_spend'], 0),
            'SD_Spend': round(vals['sd_spend'], 0),
        })

cat_rows.sort(key=lambda r: (r['Category'], r['Month']))

# ======================================================================
# SHEET 4: Action Items
# ======================================================================
actions = [
    {'Priority': '1-TODAY', 'Category': 'ASM', 'ASIN_or_Campaign': 'B0F48HZBYQ', 'Action': 'PAUSE ADS', 'Reason': '0.39x ROAS = 254% ACoS. Rs 1987 spent, Rs 781 returned. Losing money every day.', 'Expected_Monthly_Impact': 'Save Rs 600/mo'},
    {'Priority': '1-TODAY', 'Category': 'ASM', 'ASIN_or_Campaign': 'B0CJJSVBSJ', 'Action': 'PAUSE ADS', 'Reason': '0.46x ROAS = 217% ACoS. Dead product for ads.', 'Expected_Monthly_Impact': 'Save Rs 500/mo'},
    {'Priority': '1-TODAY', 'Category': 'EVA Gym', 'ASIN_or_Campaign': 'B0D9HDFSH3', 'Action': 'PAUSE ADS', 'Reason': '0.00x ROAS. Rs 517 spent, ZERO sales. No conversion at all.', 'Expected_Monthly_Impact': 'Save Rs 500/mo'},
    {'Priority': '1-TODAY', 'Category': 'EVA Kids', 'ASIN_or_Campaign': 'B09MYDPF3Y', 'Action': 'CUT BID 35%', 'Reason': 'Daily spend: Rs 382(Jan/26d) > Rs 288(Feb/28d) > Rs 995(Mar/31d) > Rs 1408(Apr/11d). ROAS: 12.1x > 7.3x > 9.5x > 5.0x. Spend tripled while ROAS halved vs Jan.', 'Expected_Monthly_Impact': 'Save Rs 8-10K/mo'},
    {'Priority': '1-TODAY', 'Category': 'EVA Gym', 'ASIN_or_Campaign': 'B0D9HB8LTP', 'Action': 'CUT BID 40%', 'Reason': 'Daily spend: Rs 67(Jan/26d) > Rs 171(Feb/28d) > Rs 197(Mar/31d) > Rs 287(Apr/11d). ROAS: 14.8x > 8.3x > 8.5x > 2.3x. ROAS crashed 84% since Jan while spend 4x.', 'Expected_Monthly_Impact': 'Save Rs 3-4K/mo'},
    {'Priority': '1-TODAY', 'Category': 'BPM', 'ASIN_or_Campaign': 'All BPM campaigns', 'Action': 'CAP at Rs 200/day total', 'Reason': 'SP-KT-BPM daily: Rs 0(Jan) > Rs 0(Feb) > Rs 58(Mar/31d) > Rs 455(Apr/11d) = +684%. ROAS only 4x vs 5.5x target. Scaling before proven.', 'Expected_Monthly_Impact': 'Save Rs 10-15K/mo'},
    {'Priority': '1-TODAY', 'Category': 'ASM', 'ASIN_or_Campaign': 'B0BN5NZCGH', 'Action': 'PAUSE ADS', 'Reason': 'Daily ROAS by month: 3.2x(Jan) > 2.5x(Feb) > 3.2x(Mar) > 1.9x(Apr). Consistently bad, trending down. Rs 31K total spent, Rs 13.8K wasted.', 'Expected_Monthly_Impact': 'Save Rs 4-5K/mo'},
    {'Priority': '2-THIS WEEK', 'Category': 'ALL', 'ASIN_or_Campaign': 'All SP campaigns', 'Action': 'Switch to Dynamic bids DOWN ONLY', 'Reason': 'Daily CPC: Rs 7.40(Jan/26d) > Rs 7.28(Feb/28d) > Rs 7.62(Mar/31d) > Rs 9.04(Apr/11d). +22% since Jan. Amazon auto-bidding inflating.', 'Expected_Monthly_Impact': 'Save Rs 8-12K/mo'},
    {'Priority': '2-THIS WEEK', 'Category': 'Storage', 'ASIN_or_Campaign': 'All Storage campaigns', 'Action': 'CUT spend 50%', 'Reason': 'ACoS by month: 32.9%(Jan) > 39.0%(Feb) > 27.8%(Mar) > 33.4%(Apr) vs 18% target. CPC: Rs 10.5 > 12.0 > 12.9 > 15.9. Never profitable.', 'Expected_Monthly_Impact': 'Save Rs 12-15K/mo'},
    {'Priority': '2-THIS WEEK', 'Category': 'Storage', 'ASIN_or_Campaign': 'B0G1YWZH29', 'Action': 'PAUSE ADS', 'Reason': '1.62x overall ROAS. Monthly: 3.52x(Mar) > 0.71x(Apr). Collapsing. Rs 6.4K wasted.', 'Expected_Monthly_Impact': 'Save Rs 2-3K/mo'},
    {'Priority': '2-THIS WEEK', 'Category': 'Storage', 'ASIN_or_Campaign': 'B0G25TVVSX', 'Action': 'PAUSE ADS', 'Reason': '1.81x ROAS. 55.3% ACoS. Product cannot convert profitably from ads.', 'Expected_Monthly_Impact': 'Save Rs 1-2K/mo'},
    {'Priority': '2-THIS WEEK', 'Category': 'EVA Kids', 'ASIN_or_Campaign': 'B0822GYVNX', 'Action': 'SCALE +20% BID', 'Reason': 'Monthly ROAS: 34.6x(Jan) > 14.3x(Feb) > 25.0x(Mar) > 27.3x(Apr). Stable 15-35x. Daily spend only Rs 131(Mar) > Rs 221(Apr). Massively underspent star.', 'Expected_Monthly_Impact': 'Gain Rs 8-15K/mo revenue'},
    {'Priority': '2-THIS WEEK', 'Category': 'EVA Kids', 'ASIN_or_Campaign': 'B0CRHST3YZ', 'Action': 'SCALE - DOUBLE BID', 'Reason': '37.23x ROAS = 2.7% ACoS over 4 months. Only Rs 1,501 total spend. Could 5x budget and still be under 10% target ACoS.', 'Expected_Monthly_Impact': 'Gain Rs 5-10K/mo revenue'},
    {'Priority': '2-THIS WEEK', 'Category': 'EVA Kids', 'ASIN_or_Campaign': 'B0CRHSF42W', 'Action': 'SCALE +20% BID', 'Reason': '21.02x ROAS = 4.8% ACoS. Rs 5.5K total spend across 4 months. Star ASIN starved of budget.', 'Expected_Monthly_Impact': 'Gain Rs 5-10K/mo revenue'},
    {'Priority': '2-THIS WEEK', 'Category': 'EVA Gym', 'ASIN_or_Campaign': 'B0C1431JNZ', 'Action': 'SCALE +20% BID', 'Reason': 'ROAS IMPROVING with scale: daily Rs 163(Mar) > Rs 379(Apr), ROAS 7.4x > 15.8x. Rare case where more spend = better ROAS.', 'Expected_Monthly_Impact': 'Gain Rs 10-15K/mo revenue'},
    {'Priority': '2-THIS WEEK', 'Category': 'EVA Gym', 'ASIN_or_Campaign': 'B08642G3SR', 'Action': 'SCALE +15% BID', 'Reason': 'ROAS improving: 8.5x(Mar) > 12.2x(Apr) while daily spend Rs 127 > Rs 179. Efficient scaling.', 'Expected_Monthly_Impact': 'Gain Rs 5-8K/mo revenue'},
    {'Priority': '2-THIS WEEK', 'Category': 'ALL SD', 'ASIN_or_Campaign': 'All SD campaigns', 'Action': 'Increase budget 30%', 'Reason': 'SD avg 9.13x ROAS vs SP 7.35x across all months (Feb-Apr). Only 4.1% of spend goes to SD. Consistently more efficient.', 'Expected_Monthly_Impact': 'Better ROAS per rupee'},
    {'Priority': '3-NEXT WEEK', 'Category': 'WTC', 'ASIN_or_Campaign': 'New campaign needed', 'Action': 'Launch SP Rs 200/day exact match', 'Reason': '12-month revenue Rs 5.2L with ZERO ads. 100% organic. Untapped. Even 10x ROAS adds Rs 50K+/mo.', 'Expected_Monthly_Impact': 'Gain Rs 15-25K/mo revenue'},
    {'Priority': '3-NEXT WEEK', 'Category': 'ASM', 'ASIN_or_Campaign': 'All ASM listings', 'Action': 'INVESTIGATE listings', 'Reason': 'Conv% by month: 8.9%(Jan) > 14.0%(Feb) > 10.4%(Mar) > 7.0%(Apr). Conversion HALVED from Feb peak. Not an ads problem - check pricing/reviews/Buy Box.', 'Expected_Monthly_Impact': 'Could double ASM ROAS'},
    {'Priority': '3-NEXT WEEK', 'Category': 'ALL', 'ASIN_or_Campaign': 'All SP-KT campaigns', 'Action': 'Search Term Report + negatives', 'Reason': 'CPC +22% since Jan but CTR flat. Broad match burning budget on irrelevant searches across all categories.', 'Expected_Monthly_Impact': 'Save Rs 5-10K/mo'},
    {'Priority': '3-NEXT WEEK', 'Category': 'Storage', 'ASIN_or_Campaign': 'All Storage SP-KT', 'Action': 'Switch to EXACT match only', 'Reason': 'CPC by month: Rs 10.5(Jan) > Rs 12.0(Feb) > Rs 12.9(Mar) > Rs 15.9(Apr). +51% in 3 months. Broad match finding expensive non-converting terms.', 'Expected_Monthly_Impact': 'Save Rs 5-8K/mo'},
    {'Priority': '3-NEXT WEEK', 'Category': 'EVA Kids', 'ASIN_or_Campaign': 'All EVA Kids listings', 'Action': 'Improve listing SEO + A+ content', 'Reason': 'Organic share 45.3% vs 60%+ for other categories. Too ads-dependent. Better listing = more free traffic.', 'Expected_Monthly_Impact': 'Long-term organic growth'},
    {'Priority': '3-NEXT WEEK', 'Category': 'BPM', 'ASIN_or_Campaign': 'B0GQ9H6BV3', 'Action': 'PAUSE ADS', 'Reason': 'Daily: Rs 20(Mar/31d) > Rs 178(Apr/11d) = +790%. ROAS: 4.0x(Mar) > 2.2x(Apr). 8x daily spend increase with declining ROAS.', 'Expected_Monthly_Impact': 'Save Rs 3-4K/mo'},
]

# ======================================================================
# SHEET 5: Overall Monthly Summary (prorated)
# ======================================================================
summary_rows = []
for m in months:
    sp_days = DAYS_SP[m]
    sd_days = DAYS_SD[m]
    sp_spend = sum(float(r.get('cost', 0)) for r in data[m].get('sp_campaigns', []))
    sd_spend = sum(float(r.get('cost', 0)) for r in data[m].get('sd_campaigns', []))
    sp_sales = sum(float(r.get('sales', 0)) for r in data[m].get('sp_advertised_product', []))
    sd_sales_key = 'sales1d' if data[m].get('sd_campaigns') and 'sales1d' in data[m]['sd_campaigns'][0] else 'sales'
    sd_sales = sum(float(r.get(sd_sales_key, 0)) for r in data[m].get('sd_campaigns', []))
    total_spend = sp_spend + sd_spend
    total_sales = sp_sales + sd_sales
    total_clicks = sum(int(r.get('clicks', 0)) for r in data[m].get('sp_campaigns', []))
    total_clicks += sum(int(r.get('clicks', 0)) for r in data[m].get('sd_campaigns', []))
    total_impr = sum(int(r.get('impressions', 0)) for r in data[m].get('sp_campaigns', []))
    total_impr += sum(int(r.get('impressions', 0)) for r in data[m].get('sd_campaigns', []))

    daily_spend = total_spend / sp_days if sp_days > 0 else 0
    daily_sales = total_sales / sp_days if sp_days > 0 else 0
    roas = total_sales / total_spend if total_spend > 0 else 0
    acos = total_spend / total_sales * 100 if total_sales > 0 else 0
    cpc = total_spend / total_clicks if total_clicks > 0 else 0
    ctr = total_clicks / total_impr * 100 if total_impr > 0 else 0

    summary_rows.append({
        'Month': m,
        'Days_in_Period': sp_days,
        'Raw_Total_Spend': round(total_spend, 0),
        'Raw_Total_Sales': round(total_sales, 0),
        'Daily_Spend': round(daily_spend, 0),
        'Daily_Ad_Sales': round(daily_sales, 0),
        'Proj_30d_Spend': round(daily_spend * 30, 0),
        'Proj_30d_Ad_Sales': round(daily_sales * 30, 0),
        'ROAS': round(roas, 2),
        'ACoS%': round(acos, 1),
        'Avg_CPC': round(cpc, 2),
        'CTR%': round(ctr, 2),
        'Total_Clicks': total_clicks,
        'Total_Impressions': total_impr,
        'SP_Spend': round(sp_spend, 0),
        'SD_Spend': round(sd_spend, 0),
        'SP%': round(sp_spend / total_spend * 100, 1) if total_spend > 0 else 0,
        'SD%': round(sd_spend / total_spend * 100, 1) if total_spend > 0 else 0,
    })

# ── Write all CSVs ──
def write_csv(filename, rows):
    if not rows:
        print(f"SKIP: {filename} (no data)")
        return
    fpath = os.path.join(OUT_DIR, filename)
    with open(fpath, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    print(f"Saved: {fpath} ({len(rows)} rows)")

write_csv('report_asin_performance.csv', asin_rows)
write_csv('report_campaign_performance.csv', camp_rows)
write_csv('report_category_trend.csv', cat_rows)
write_csv('report_action_items.csv', actions)
write_csv('report_monthly_summary.csv', summary_rows)

print(f"\nAll 5 CSV reports saved!")
print(f"\nProrating applied:")
print(f"  Jan SP: {DAYS_SP['2026-01']}d | Feb SP: {DAYS_SP['2026-02']}d | Mar: {DAYS_SP['2026-03']}d | Apr: {DAYS_SP['2026-04']}d")
print(f"  Jan SD: {DAYS_SD['2026-01']}d | Feb SD: {DAYS_SD['2026-02']}d | Mar: {DAYS_SD['2026-03']}d | Apr: {DAYS_SD['2026-04']}d")
print(f"  All 'Daily' columns = raw / actual days in period")
print(f"  All 'Proj_30d' columns = daily x 30")
print(f"  All % comparisons use daily averages, NOT raw totals")
