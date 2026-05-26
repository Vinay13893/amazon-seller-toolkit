from playwright.sync_api import sync_playwright
import time, re
from bs4 import BeautifulSoup

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)

# ======== TEST 1: BSR - deep HTML analysis ========
print("=" * 60)
print("BSR DEEP ANALYSIS - B0F8HF1BLP")
print("=" * 60)
p = b.new_page(user_agent=UA)
url = "https://www.amazon.in/dp/B0F8HF1BLP"
resp = p.goto(url, wait_until="domcontentloaded", timeout=30000)
print(f"HTTP: {resp.status}")
time.sleep(2)
p.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
time.sleep(1.5)
p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
time.sleep(1.5)
html = p.content()

# Save full HTML for analysis
with open("/tmp/bsr_full.html", "w", encoding="utf-8") as f:
    f.write(html)
print("Full HTML saved to /tmp/bsr_full.html")

soup = BeautifulSoup(html, "lxml")
text = soup.get_text("\n", strip=True)

# Search for BSR section
print("\n--- Searching for BSR patterns ---")
patterns = [
    r"Best Sellers Rank",
    r"best.?seller",
    r"#[\d,]+\s+in\s+",
    r"productDetails_detailBullets_sections",
    r"detailBullets",
    r"prodDetTable",
]
for pat in patterns:
    matches = list(re.finditer(pat, text, re.I))
    if matches:
        for m in matches[:2]:
            start = max(0, m.start() - 30)
            end = min(len(text), m.end() + 200)
            print(f"\n  Pattern '{pat}' found:")
            print(f"  ...{text[start:end]}...")
    else:
        print(f"  Pattern '{pat}': NOT FOUND")

# Check specific BSR HTML elements
print("\n--- Checking BSR HTML elements ---")
bsr_selectors = [
    "#productDetails_detailBullets_sections1",
    "#detailBullets_feature_div",
    "#prodDetails",
    "#detailBulletsWrapper_feature_div",
    "table.prodDetTable",
    "#productDetails_techSpec_section_1",
    "#productDetails_db_sections",
    "th:contains('Best Sellers Rank')",
    "span:has-text('Best Sellers Rank')",
    "#SalesRank",
    "#detailBullets",
]
for sel in bsr_selectors:
    try:
        el = p.locator(sel)
        cnt = el.count()
        if cnt > 0:
            txt = el.first.inner_text(timeout=2000).strip()[:300]
            print(f"  {sel}: FOUND ({cnt}) -> {txt}")
        else:
            print(f"  {sel}: not found")
    except Exception as e:
        print(f"  {sel}: error - {type(e).__name__}")

# Try the raw HTML for BSR
print("\n--- Raw HTML search for ranking ---")
for pat in [r"Best Sellers Rank", r"#[\d,]+\s+in\s+", r"SalesRank", r"rankNumber"]:
    matches = list(re.finditer(pat, html, re.I))
    print(f"  '{pat}' in HTML: {len(matches)} matches")
    for m in matches[:2]:
        start = max(0, m.start() - 50)
        end = min(len(html), m.end() + 150)
        snippet = html[start:end].replace("\n", " ")[:200]
        print(f"    {snippet}")

p.close()

# ======== TEST 2: KEYWORD RANK - deep HTML analysis ========
print("\n" + "=" * 60)
print("KEYWORD RANK DEEP ANALYSIS - 'bathroom cleaner'")
print("=" * 60)
p = b.new_page(user_agent=UA)
search_url = "https://www.amazon.in/s?k=bathroom+cleaner"
resp = p.goto(search_url, wait_until="domcontentloaded", timeout=60000)
print(f"HTTP: {resp.status}")
time.sleep(2)
p.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
time.sleep(1)
p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
time.sleep(1)
html = p.content()

with open("/tmp/search_full.html", "w", encoding="utf-8") as f:
    f.write(html)
print("Full HTML saved to /tmp/search_full.html")

soup = BeautifulSoup(html, "lxml")

# Check for captcha
if "captcha" in html.lower():
    print("CAPTCHA DETECTED!")
    body_text = soup.get_text(" ", strip=True)[:500]
    print(f"Body: {body_text}")
else:
    # Check standard selectors
    print("\n--- Checking search result selectors ---")
    selectors = [
        'div[data-component-type="s-search-result"]',
        'div[data-asin]',
        'div.s-result-item',
        'div.sg-col-inner',
        'div[data-cel-widget*="search_result"]',
        'span[data-component-type="s-search-results"]',
        'div.s-main-slot',
    ]
    for sel in selectors:
        els = soup.select(sel)
        print(f"  {sel}: {len(els)} found")
        if els and "asin" in sel.lower():
            asins = []
            for el in els[:20]:
                a = (el.get("data-asin") or "").strip()
                if a and len(a) == 10:
                    asins.append(a)
            if asins:
                print(f"    ASINs: {asins[:5]}")

    # Try regex approach
    print("\n--- Regex ASIN search ---")
    asin_matches = re.findall(r'data-asin="([A-Z0-9]{10})"', html)
    unique = list(dict.fromkeys(asin_matches))
    print(f"  data-asin regex: {len(unique)} unique ASINs")
    if unique:
        print(f"    First 10: {unique[:10]}")

    # Check for different page layout
    print("\n--- Page structure check ---")
    text = soup.get_text(" ", strip=True)[:2000]
    if "No results" in text:
        print("  NO RESULTS page")
    elif "bathroom cleaner" in text.lower():
        print("  Search term present in page")
    print(f"  Page text (first 500): {text[:500]}")

p.close()
b.close()
pw.stop()
print("\nDone.")
