"""Quick 30-day analysis script for existing report data."""
import json
from collections import defaultdict

with open('reports/sp_campaigns_data.json') as f: sp = json.load(f)
with open('reports/sd_campaigns_data.json') as f: sd = json.load(f)
with open('reports/sp_targeting_data.json') as f: tgt = json.load(f)
with open('reports/sp_search_terms_data.json') as f: st = json.load(f)
with open('reports/sp_advertised_product_data.json') as f: prod = json.load(f)

# TOP 10 SP CAMPAIGNS BY SALES
print("===== TOP 10 SP CAMPAIGNS BY SALES =====")
sp_s = sorted(sp, key=lambda x: x.get('sales1d', 0), reverse=True)
for c in sp_s[:10]:
    s = c.get('sales1d', 0)
    co = c['cost']
    ac = (co / s * 100) if s > 0 else 999
    nm = c['campaignName']
    print(f"  Rs {s:>10,.0f} | Rs {co:>8,.0f} spend | ACoS {ac:>5.1f}% | {nm[:60]}")

# BLEEDING SP CAMPAIGNS
print("\n===== BLEEDING SP CAMPAIGNS (Spend>Rs200, 0 Sales) =====")
bleeders = [c for c in sp if c['cost'] > 200 and c.get('sales1d', 0) == 0]
bleeders.sort(key=lambda x: x['cost'], reverse=True)
for c in bleeders:
    nm = c['campaignName']
    print(f"  Rs {c['cost']:>8,.0f} wasted | {c['clicks']:>3} clicks | {nm[:55]}")
if not bleeders:
    print("  None!")

# HIGH ACoS
print("\n===== HIGH ACoS SP CAMPAIGNS (ACoS>30%, Spend>Rs500) =====")
high_acos = []
for c in sp:
    s = c.get('sales1d', 0)
    co = c['cost']
    if co > 500 and s > 0:
        ac = co / s * 100
        if ac > 30:
            high_acos.append((ac, c))
high_acos.sort(reverse=True)
for ac, c in high_acos[:10]:
    nm = c['campaignName']
    print(f"  ACoS {ac:>5.1f}% | Rs {c['cost']:>7,.0f} spend | Rs {c.get('sales1d', 0):>8,.0f} sales | {nm[:50]}")
if not high_acos:
    print("  None!")

# TOP 15 CONVERTING SEARCH TERMS
print("\n===== TOP 15 CONVERTING SEARCH TERMS =====")
st_s = sorted(st, key=lambda x: x.get('sales1d', 0), reverse=True)
for s in st_s[:15]:
    sa = s.get('sales1d', 0)
    co = s['cost']
    ac = (co / sa * 100) if sa > 0 else 0
    print(f"  Rs {sa:>8,.0f} | ACoS {ac:>5.1f}% | {s['searchTerm'][:50]}")

# TOP WASTED SEARCH TERMS
print("\n===== TOP 15 WASTED SEARCH TERMS (5+ clicks, 0 sales) =====")
wasted = [s for s in st if s['clicks'] >= 5 and s.get('sales1d', 0) == 0]
wasted.sort(key=lambda x: x['cost'], reverse=True)
for s in wasted[:15]:
    print(f"  Rs {s['cost']:>7,.0f} | {s['clicks']:>3} clicks | {s['searchTerm'][:45]}")
print(f"  ... Total wasted search terms (5+ clicks, 0 sales): {len(wasted)}")
total_wasted_cost = sum(s['cost'] for s in wasted)
print(f"  ... Total wasted spend on these: Rs {total_wasted_cost:,.0f}")

# TOP 10 PRODUCTS BY SALES
print("\n===== TOP 10 ADVERTISED PRODUCTS BY SALES =====")
asin_data = defaultdict(lambda: {'cost': 0, 'sales': 0, 'clicks': 0, 'imps': 0, 'orders': 0, 'sku': ''})
for p in prod:
    a = p['advertisedAsin']
    asin_data[a]['cost'] += p['cost']
    asin_data[a]['sales'] += p.get('sales1d', 0)
    asin_data[a]['clicks'] += p['clicks']
    asin_data[a]['imps'] += p['impressions']
    asin_data[a]['orders'] += p.get('purchases1d', 0)
    if p.get('advertisedSku'):
        asin_data[a]['sku'] = p['advertisedSku']

asin_list = sorted(asin_data.items(), key=lambda x: x[1]['sales'], reverse=True)
for a, d in asin_list[:10]:
    ac = (d['cost'] / d['sales'] * 100) if d['sales'] > 0 else 999
    cvr = (d['orders'] / d['clicks'] * 100) if d['clicks'] > 0 else 0
    print(f"  {a} | Rs {d['sales']:>9,.0f} sales | Rs {d['cost']:>7,.0f} spend | ACoS {ac:>5.1f}% | CVR {cvr:>4.1f}% | {d['sku'][:30]}")

# ASIN BLEEDERS
print("\n===== ASIN BLEEDERS (Spend>Rs100, 0 Sales) =====")
asin_bleed = [(a, d) for a, d in asin_data.items() if d['cost'] > 100 and d['sales'] == 0]
asin_bleed.sort(key=lambda x: x[1]['cost'], reverse=True)
for a, d in asin_bleed[:10]:
    print(f"  {a} | Rs {d['cost']:>7,.0f} wasted | {d['clicks']:>3} clicks | {d['sku'][:35]}")
total_asin_waste = sum(d['cost'] for _, d in asin_bleed)
print(f"  ... Total ASIN bleed: Rs {total_asin_waste:,.0f} across {len(asin_bleed)} ASINs")

# SD CAMPAIGNS DETAIL
print("\n===== SD CAMPAIGNS (ENABLED, by Sales) =====")
sd_en = [c for c in sd if c['campaignStatus'] == 'ENABLED']
sd_en.sort(key=lambda x: x.get('sales', 0), reverse=True)
for c in sd_en[:10]:
    s = c.get('sales', 0)
    co = c['cost']
    ac = (co / s * 100) if s > 0 else 999
    ac_s = f"{ac:.1f}%" if s > 0 else "NO SALES"
    nm = c['campaignName']
    print(f"  Rs {s:>9,.0f} sales | Rs {co:>7,.0f} spend | ACoS {ac_s:>8} | {nm[:50]}")

# TARGETING TYPE ANALYSIS
print("\n===== TARGETING TYPE PERFORMANCE =====")
tgt_types = defaultdict(lambda: {'cost': 0, 'sales': 0, 'clicks': 0, 'imps': 0, 'orders': 0, 'count': 0})
for t in tgt:
    mt = t.get('matchType', 'UNKNOWN')
    tgt_types[mt]['cost'] += t['cost']
    tgt_types[mt]['sales'] += t.get('sales1d', 0)
    tgt_types[mt]['clicks'] += t['clicks']
    tgt_types[mt]['imps'] += t['impressions']
    tgt_types[mt]['orders'] += t.get('purchases1d', 0)
    tgt_types[mt]['count'] += 1

for mt, d in sorted(tgt_types.items(), key=lambda x: x[1]['cost'], reverse=True):
    ac = (d['cost'] / d['sales'] * 100) if d['sales'] > 0 else 999
    ac_s = f"{ac:.1f}%" if d['sales'] > 0 else "N/A"
    print(f"  {mt:<25} | {d['count']:>4} targets | Rs {d['cost']:>8,.0f} spend | Rs {d['sales']:>9,.0f} sales | ACoS {ac_s}")
