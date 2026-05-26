import re
from bs4 import BeautifulSoup

with open(r"c:\amazon-bsr-tracker\debug_page.html", "r", encoding="utf-8") as f:
    html = f.read()

soup = BeautifulSoup(html, "lxml")

# Check detailBulletsWithExceptions
div = soup.find("div", id="detailBulletsWithExceptions_feature_div")
if div:
    print("=== detailBulletsWithExceptions ===")
    print(div.get_text("\n", strip=True)[:3000])
else:
    print("detailBulletsWithExceptions NOT found as element")

# Check for productDetails table (sometimes uses different IDs)
for table_id in ["productDetails_techSpec_section_1", "productDetails_detailBullets_sections1", "prodDetails"]:
    el = soup.find(id=table_id)
    if el:
        print(f"\n=== {table_id} ===")
        print(el.get_text("\n", strip=True)[:2000])

# Check for any #NUMBER in CATEGORY pattern
text = soup.get_text(" ", strip=True)
matches = re.findall(r"#[\d,]+\s+in\s+\w[\w &]+", text)
print(f"\n=== # X in Category matches: {len(matches)} ===")
for m in matches[:10]:
    print(m)

# Check prodDetails section
pd = soup.find("div", id="prodDetails")
if pd:
    print("\n=== prodDetails div ===")
    print(pd.get_text("\n", strip=True)[:3000])

# Check if there's a rank feature div
rank_div = soup.find("div", id="dpx-btf-rank_feature_div")
if rank_div:
    print("\n=== rank_feature_div ===")
    print(rank_div.get_text("\n", strip=True)[:1000])
else:
    # Maybe empty placeholder for lazy load
    for d in soup.find_all("div"):
        did = d.get("id", "")
        if "rank" in did.lower():
            print(f"\nRank div: id={did}, content length={len(d.get_text())}")
