import re
with open('/tmp/bsr_mobile.html') as f:
    html = f.read()

for pat in ['Best Sellers', 'best-seller', 'bestseller', '#\\d']:
    idxs = [m.start() for m in re.finditer(pat, html, re.I)]
    print(f"'{pat}': {len(idxs)} matches")
    for i in idxs[:3]:
        snippet = html[max(0,i-50):i+200].replace('\n', ' ')[:250]
        print(f"  ...{snippet}...")
    print()

# Also search for "in Health" or "in Home" patterns
for pat in ['in Health', 'in Home', 'in Beauty', 'in Personal Care']:
    idxs = [m.start() for m in re.finditer(pat, html, re.I)]
    print(f"'{pat}': {len(idxs)} matches")
    for i in idxs[:2]:
        snippet = html[max(0,i-100):i+100].replace('\n', ' ')[:200]
        print(f"  ...{snippet}...")
    print()
