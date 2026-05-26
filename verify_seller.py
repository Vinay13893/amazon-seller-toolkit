from playwright.sync_api import sync_playwright
import time, re
from bs4 import BeautifulSoup

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)
p = b.new_page(user_agent=UA)

asin = "B0F8H6VCNF"

# Test: product page seller extraction
print("Testing product page seller extraction...")
url = f"https://www.amazon.in/dp/{asin}"
p.goto(url, wait_until="domcontentloaded", timeout=30000)
time.sleep(2)
p.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
time.sleep(1)
html = p.content()
soup = BeautifulSoup(html, "lxml")
text = soup.get_text(" ", strip=True)

# Seller
for sel in ["#sellerProfileTriggerId", "#merchant-info a", "#tabular-buybox a[href*='seller=']"]:
    el = soup.select_one(sel)
    if el:
        print(f"  Seller ({sel}): {el.get_text(strip=True)[:60]}")
        href = el.get("href", "")
        m = re.search(r"seller=([A-Z0-9]{8,20})", href)
        if m:
            print(f"  Seller ID: {m.group(1)}")
        break
else:
    # Fallback
    m = re.search(r"Sold by\s+(.+?)(?:\s+and\s+Fulfilled|\s+Ships|\.|$)", text, re.I)
    if m:
        print(f"  Seller (text): {m.group(1).strip()[:60]}")
    else:
        print("  No seller found")
        # Print relevant area
        for kw in ["Sold by", "Ships from", "seller"]:
            idx = text.lower().find(kw.lower())
            if idx > -1:
                print(f"  Context near '{kw}': {text[max(0,idx-20):idx+100]}")
                break

# Price
price_el = soup.select_one("span.a-price span.a-offscreen") or soup.select_one("#priceblock_ourprice")
if price_el:
    print(f"  Price: {price_el.get_text(strip=True)}")
else:
    print("  No price found")

# Fulfillment
if re.search(r"Fulfilled by Amazon|Ships from Amazon", text, re.I):
    print("  Fulfillment: FBA")
else:
    print("  Fulfillment: FBM")

# Title
title_el = soup.select_one("span#productTitle")
if title_el:
    print(f"  Title: {title_el.get_text(strip=True)[:80]}")

p.close()
b.close()
pw.stop()
print("Done.")
