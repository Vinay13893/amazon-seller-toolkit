import requests, re
from bs4 import BeautifulSoup

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
}

asin = "B0F8HF1BLP"
url = f"https://www.amazon.in/dp/{asin}"

print(f"Fetching {url} with requests...")
session = requests.Session()
resp = session.get(url, headers=headers, timeout=20)
print(f"HTTP: {resp.status_code}, Length: {len(resp.text)}")

html = resp.text
with open("/tmp/bsr_requests.html", "w", encoding="utf-8") as f:
    f.write(html)

# Check for captcha
if "captcha" in html.lower() and "Type the characters" in html:
    print("CAPTCHA!")
else:
    # BSR search
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=True)
    
    # Method 1: regex on text
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]{3,80})", text)
    if matches:
        print("\nBSR found via text regex:")
        for rank, cat in matches:
            cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
            cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
            print(f"  #{rank} in {cat}")
    else:
        print("\nNo BSR via text regex")
    
    # Method 2: check specific elements
    for sel in ["#productDetails_detailBullets_sections1", "#detailBulletsWrapper_feature_div", 
                "#prodDetails", "table.prodDetTable", "#SalesRank"]:
        els = soup.select(sel)
        if els:
            txt = els[0].get_text(" ", strip=True)[:300]
            print(f"\n{sel}: {txt}")
    
    # Method 3: raw HTML search
    bsr_in_html = "Best Sellers Rank" in html
    print(f"\n'Best Sellers Rank' in HTML: {bsr_in_html}")
    if bsr_in_html:
        idx = html.index("Best Sellers Rank")
        print(f"  Context: {html[idx:idx+500]}")

# Also try amazon.com for a random well-known ASIN
print("\n\n=== Trying amazon.com with B09V3KXJPB ===")
url2 = "https://www.amazon.com/dp/B09V3KXJPB"
resp2 = session.get(url2, headers=headers, timeout=20)
print(f"HTTP: {resp2.status_code}")
html2 = resp2.text
if "Best Sellers Rank" in html2:
    print("BSR FOUND in amazon.com HTML!")
    soup2 = BeautifulSoup(html2, "lxml")
    text2 = soup2.get_text("\n", strip=True)
    for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n#(]{3,80})", text2):
        print(f"  #{m.group(1)} in {m.group(2).strip()}")
else:
    print("No BSR in amazon.com either")
    if "captcha" in html2.lower():
        print("CAPTCHA on .com")

print("\nDone.")
