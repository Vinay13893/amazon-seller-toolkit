"""Quick analysis of saved placement JSON using corrected label mapping."""
import json, sys
sys.path.insert(0, r'e:\amazon-bsr-tracker\amazon-pincode-checker')
from collections import defaultdict
from competitor_intel.placement_audit import PLACEMENT_LABELS, normalize_placement

def calc_roas(sales, cost): return sales / cost if cost else 0.0
def calc_acos(cost, sales): return cost / sales * 100 if sales else 0.0
from category_analysis.categories import classify_campaign

RAW_FILE = r'e:\amazon-bsr-tracker\amazon-pincode-checker\competitor_intel\output\placement_raw_2026-05-22.json'

with open(RAW_FILE) as f:
    data = json.load(f)

cat_place = defaultdict(lambda: defaultdict(lambda: {'impressions':0,'clicks':0,'cost':0.0,'orders':0,'sales':0.0}))
for row in data:
    cat = classify_campaign(row.get('campaignName', ''))
    p = normalize_placement(row.get('placementClassification', ''))
    m = cat_place[cat][p]
    m['impressions'] += int(row.get('impressions', 0) or 0)
    m['clicks']      += int(row.get('clicks', 0) or 0)
    m['cost']        += float(row.get('cost', 0) or 0)
    m['orders']      += int(row.get('purchases1d', 0) or 0)
    m['sales']       += float(row.get('sales1d', 0) or 0)

ORDER = ['TOP of Search', 'Rest of Search', 'Product Pages']
CAT_NAMES = {
    'ASM': 'Anti-Slip Mats (ASM)',
    'BPM': 'Baby Play Mat (BPM)',
    'EVA_Gym': 'EVA Gym Mat',
    'EVA_Kids': 'EVA Kids Mat',
    'Storage': 'Storage Bags',
    'UNCATEGORIZED': 'Uncategorized',
}

SEP = '─' * 72

for cat in ['ASM', 'BPM', 'EVA_Gym', 'EVA_Kids', 'Storage', 'UNCATEGORIZED']:
    places = cat_place.get(cat, {})
    if not places:
        continue
    print()
    print(SEP)
    print(f'  {CAT_NAMES.get(cat, cat)}')
    print(SEP)
    hdr = f'  {"Placement":<24} {"Imps%":>6}  {"Spend%":>6}  {"Spend":>10}  {"Sales":>10}  {"ROAS":>6}  {"ACoS":>6}  {"CTR":>5}'
    print(hdr)
    print('  ' + '-' * 70)

    total = {k: 0 for k in ('impressions', 'clicks', 'cost', 'orders', 'sales')}
    for p in ORDER:
        if p in places:
            for k in total:
                total[k] += places[p][k]

    for p in ORDER:
        if p not in places:
            continue
        m = places[p]
        pct_imps  = m['impressions'] / max(total['impressions'], 1) * 100
        pct_spend = m['cost'] / max(total['cost'], 0.01) * 100
        roas = calc_roas(m['sales'], m['cost'])
        acos = calc_acos(m['cost'], m['sales'])
        ctr  = m['clicks'] / max(m['impressions'], 1) * 100
        print(f'  {p:<24} {pct_imps:5.1f}%  {pct_spend:5.1f}%  '
              f'{m["cost"]:>10,.0f}  {m["sales"]:>10,.0f}  '
              f'{roas:>5.1f}x  {acos:>5.0f}%  {ctr:>4.2f}%')

    roas = calc_roas(total['sales'], total['cost'])
    acos = calc_acos(total['cost'], total['sales'])
    ctr  = total['clicks'] / max(total['impressions'], 1) * 100
    print('  ' + '-' * 70)
    print(f'  {"TOTAL":<24} {"100%":>6}  {"100%":>6}  '
          f'{total["cost"]:>10,.0f}  {total["sales"]:>10,.0f}  '
          f'{roas:>5.1f}x  {acos:>5.0f}%  {ctr:>4.2f}%')
    print(f'  Impressions: TOS={places.get("TOP of Search",{}).get("impressions",0):,}  '
          f'ROS={places.get("Rest of Search",{}).get("impressions",0):,}  '
          f'PP={places.get("Product Pages",{}).get("impressions",0):,}')

# ── Overall summary ──────────────────────────────────────────────────────────
print()
print('=' * 72)
print('  OVERALL SUMMARY (All Categories Combined)')
print('=' * 72)
overall = defaultdict(lambda: {'impressions':0,'clicks':0,'cost':0.0,'orders':0,'sales':0.0})
for row in data:
    p = normalize_placement(row.get('placementClassification', ''))
    m = overall[p]
    m['impressions'] += int(row.get('impressions', 0) or 0)
    m['clicks']      += int(row.get('clicks', 0) or 0)
    m['cost']        += float(row.get('cost', 0) or 0)
    m['orders']      += int(row.get('purchases1d', 0) or 0)
    m['sales']       += float(row.get('sales1d', 0) or 0)

grand = {k: sum(overall[p][k] for p in overall) for k in ('impressions','clicks','cost','orders','sales')}
for p in ORDER:
    if p not in overall:
        continue
    m = overall[p]
    pct_imps  = m['impressions'] / max(grand['impressions'], 1) * 100
    pct_spend = m['cost'] / max(grand['cost'], 0.01) * 100
    roas = calc_roas(m['sales'], m['cost'])
    acos = calc_acos(m['cost'], m['sales'])
    print(f'  {p:<24}  {pct_imps:5.1f}% imps  {pct_spend:5.1f}% spend  '
          f'₹{m["cost"]:>9,.0f} spend  ₹{m["sales"]:>10,.0f} sales  ROAS {roas:.1f}x  ACoS {acos:.0f}%')
print('  ' + '-' * 70)
print(f'  {"TOTAL":<24}  {"100%":>6} imps  {"100%":>6} spend  '
      f'₹{grand["cost"]:>9,.0f} spend  ₹{grand["sales"]:>10,.0f} sales  '
      f'ROAS {calc_roas(grand["sales"],grand["cost"]):.1f}x  ACoS {calc_acos(grand["cost"],grand["sales"]):.0f}%')
