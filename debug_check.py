import re

with open(r"c:\amazon-bsr-tracker\debug_page.html", "r", encoding="utf-8") as f:
    html = f.read()

# Find all div IDs containing rank/detail/bullet
ids = re.findall(r'id="([^"]*(?:rank|detail|bullet)[^"]*)"', html, re.IGNORECASE)
for i in sorted(set(ids)):
    print("ID:", i)

print("---")

# Check if detailBullets exists as lazy-load target
if "detailBullets" in html:
    print("detailBullets found in HTML")
    # Find context around it
    for m in re.finditer(r'detailBullets[^"]{0,100}', html):
        print("  CTX:", m.group()[:120])

if "SalesRank" in html:
    print("SalesRank found!")
