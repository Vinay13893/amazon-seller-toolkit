"""Debug: see what ASINs Amazon returns for 'handwash' search on .in"""
import re
from playwright.sync_api import sync_playwright

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

TARGET = "B0F8J275QC"

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(user_agent=UA)

    for pnum in range(1, 8):
        if pnum == 1:
            url = f"https://www.amazon.in/s?k=handwash"
        else:
            url = f"https://www.amazon.in/s?k=handwash&page={pnum}"

        print(f"\n--- Page {pnum} ---")
        print(f"URL: {url}")
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)
        html = page.content()

        # Method 1: data-asin
        asins_data = []
        for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
            a = m.group(1).upper()
            if a and a not in asins_data:
                asins_data.append(a)

        print(f"  data-asin ASINs found: {len(asins_data)}")
        if TARGET in asins_data:
            idx = asins_data.index(TARGET) + 1
            print(f"  >>> FOUND {TARGET} at position {idx} <<<")
        else:
            print(f"  {TARGET} NOT found on this page")

        # Show first 5 ASINs
        print(f"  First 5: {asins_data[:5]}")

        # Also check for ASIN in URL patterns
        url_asins = re.findall(r'/dp/([A-Z0-9]{10})', html, re.I)
        url_asins_unique = list(dict.fromkeys([a.upper() for a in url_asins]))
        if TARGET in url_asins_unique and TARGET not in asins_data:
            print(f"  >>> FOUND {TARGET} in /dp/ links but NOT in data-asin! <<<")

    # Also check if the ASIN exists at all
    print(f"\n--- Direct check: https://www.amazon.in/dp/{TARGET} ---")
    page.goto(f"https://www.amazon.in/dp/{TARGET}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2000)
    title_el = page.query_selector("#productTitle")
    if title_el:
        print(f"  Product title: {title_el.inner_text().strip()[:100]}")
    else:
        print("  Could not find product title - ASIN may not exist")

    page.close()
    browser.close()
