from playwright.sync_api import sync_playwright
import time, re
from bs4 import BeautifulSoup

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)

# ======== TEST 1: BSR Lookup ========
print("=" * 60)
print("TEST 1: BSR LOOKUP - B0F8H75R4M")
print("=" * 60)
p = b.new_page(user_agent=UA)
url = "https://www.amazon.in/dp/B0F8H75R4M"
resp = p.goto(url, wait_until="domcontentloaded", timeout=30000)
print(f"HTTP: {resp.status if resp else 'None'}")
time.sleep(1)
p.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
time.sleep(0.8)
p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
time.sleep(0.7)
html = p.content()

if "captcha" in html.lower() and "Type the characters" in html:
    print("CAPTCHA detected!")
else:
    text = BeautifulSoup(html, "lxml").get_text("\n", strip=True)
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]+)", text)
    if matches:
        for rank_raw, cat_raw in matches:
            rank = rank_raw.replace(",", "").strip()
            cat = cat_raw.strip()
            cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
            cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
            print(f"  BSR #{rank} in {cat}")
    else:
        print("  No BSR found!")
        # Check if product page loaded
        title = ""
        try:
            te = BeautifulSoup(html, "lxml").select_one("#productTitle")
            if te:
                title = te.get_text(strip=True)[:80]
        except:
            pass
        if title:
            print(f"  Title found: {title}")
            print("  BSR section might not be visible - checking raw text...")
            idx = text.lower().find("best seller")
            if idx > -1:
                print(f"  Context: {text[max(0,idx-20):idx+200]}")
            else:
                print("  'Best Seller' not found in page text")
        else:
            print("  Product page may not have loaded properly")
            if "Page Not Found" in html or "Sorry" in html:
                print("  NOT_FOUND page")
p.close()

# ======== TEST 2: Keyword Rank ========
print("\n" + "=" * 60)
print("TEST 2: KEYWORD RANK - 'bathroom cleaner' for B0F8H75R4M")
print("=" * 60)
p = b.new_page(user_agent=UA)
asin = "B0F8H75R4M"
keyword = "bathroom cleaner"
found = False

for page_num in range(1, 4):  # Check first 3 pages only for speed
    if page_num == 1:
        search_url = f"https://www.amazon.in/s?k={keyword.replace(' ', '+')}"
    else:
        search_url = f"https://www.amazon.in/s?k={keyword.replace(' ', '+')}&page={page_num}"
    
    print(f"  Page {page_num}: {search_url}")
    try:
        p.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        time.sleep(1.0)
        p.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        time.sleep(0.8)
        p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(0.8)
        html = p.content()
        
        # Check for captcha
        if "captcha" in html.lower():
            print("    CAPTCHA!")
            break
        
        # Extract ASINs
        soup = BeautifulSoup(html, "lxml")
        asins = []
        for div in soup.select('div[data-component-type="s-search-result"]'):
            a = (div.get("data-asin") or "").upper().strip()
            if a and len(a) == 10 and a not in asins:
                asins.append(a)
        
        print(f"    Found {len(asins)} ASINs")
        if asin in asins:
            pos = asins.index(asin) + 1
            print(f"    FOUND! {asin} at position {pos} on page {page_num}")
            
            # Check if sponsored
            idx = html.upper().find(f'DATA-ASIN="{asin}"')
            if idx > -1:
                window = html[max(0, idx-2000):idx+4000].lower()
                is_sp = "sponsored" in window
                print(f"    Sponsored: {is_sp}")
            found = True
            break
        else:
            if asins:
                print(f"    First 5 ASINs: {asins[:5]}")
    except Exception as e:
        print(f"    Error: {e}")
        break

if not found:
    print(f"  {asin} not found in first 3 pages")

p.close()
b.close()
pw.stop()
print("\nDone.")
