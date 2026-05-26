import os
import pandas as pd

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output')
asin = pd.read_csv(os.path.join(OUT_DIR, 'master_asin_report.csv'))
st = pd.read_csv(os.path.join(OUT_DIR, 'master_search_terms.csv'))

total_spend = asin['Ad_Spend_4m'].sum()
total_ad_sales = asin['Ad_Sales_4m'].sum()
total_revenue = asin['Revenue_90d'].sum()
print(f'Total Ad Spend (4m): Rs {total_spend:,.0f}')
print(f'Total Ad Sales (4m): Rs {total_ad_sales:,.0f}')
print(f'Total Actual Revenue (90d): Rs {total_revenue:,.0f}')
print(f'Overall Ad ROAS: {total_ad_sales/total_spend:.2f}x')
print(f'Overall Blended ROAS: {total_revenue/total_spend:.2f}x')

in10plus = len(asin[asin['Num_Campaigns']>=10])
in20plus = len(asin[asin['Num_Campaigns']>=20])
print(f'\nASINs in 10+ campaigns: {in10plus}')
print(f'ASINs in 20+ campaigns: {in20plus}')

negate = st[st['Action'].str.contains('NEGATE', na=False)]
dedup = st[st['Action'].str.contains('DEDUPLICATE', na=False)]
negate_spend = negate['Total_Spend'].sum()
dedup_spend = dedup['Total_Spend'].sum()
print(f'\nSearch terms to NEGATE: {len(negate)} (Rs {negate_spend:,.0f} waste)')
print(f'Search terms DUPLICATED: {len(dedup)} (Rs {dedup_spend:,.0f} self-competition)')

neg_margin = asin[(asin['Est_Margin%'] < 0) & (asin['Revenue_90d'] > 0)]
print(f'\nASINs with NEGATIVE margin after ads: {len(neg_margin)}')
for _, r in neg_margin.iterrows():
    rev = r['Revenue_90d']
    spend = r['Ad_Spend_4m']
    margin = r['Est_Margin%']
    a = r['ASIN']
    cat = r['Category']
    print(f'  {a} ({cat}): Revenue {rev:,.0f}, Ad Spend {spend:,.0f}, Margin {margin:.1f}%')
