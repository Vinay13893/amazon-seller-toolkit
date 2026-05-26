"""Debug: compare data-asin (all) vs s-search-result (actual results only)"""
import re
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

TARGET = "B0F8J275QC"

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(user_agent=UA)

    for pnum in range(1, 4):  # just check first 3 pages
        if pnum == 1:
            url = f"https://www.amazon.in/s?k=handwash"
        else:
            url = f"https://www.amazon.in/s?k=handwash&page={pnum}"

        print(f"\n{'='*60}")
        print(f"PAGE {pnum}: {url}")
        print(f"{'='*60}")
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2000)
        html = page.content()

        # Method 1: ALL data-asin (current approach)
        all_asins = []
        for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
            a = m.group(1).upper()
            if a and a not in all_asins:
                all_asins.append(a)

        # Method 2: Only s-search-result divs (proper approach)
        soup = BeautifulSoup(html, "lxml")
        result_divs = soup.select('div[data-component-type="s-search-result"]')
        search_asins = []
        for div in result_divs:
            a = div.get("data-asin", "").upper().strip()
            if a and len(a) == 10 and a not in search_asins:
                search_asins.append(a)

        print(f"  Method 1 (all data-asin):     {len(all_asins)} unique ASINs")
        print(f"  Method 2 (search-result only): {len(search_asins)} unique ASINs")

        target_in_all = TARGET in all_asins
        target_in_search = TARGET in search_asins
        print(f"  Target in all:    {target_in_all}")
        print(f"  Target in search: {target_in_search}")

        if target_in_search:
            idx = search_asins.index(TARGET) + 1
            print(f"  >>> POSITION: {idx} <<<")

        # Show search result ASINs
        print(f"  Search result ASINs: {search_asins[:10]}...")

        # Check if we see pagination info
        pagination = soup.select('.s-pagination-item')
        page_nums = [p.get_text(strip=True) for p in pagination if p.get_text(strip=True).isdigit()]
        print(f"  Pagination numbers visible: {page_nums}")

        # Check for no-results message
        noresult = soup.select_one('.s-no-results-header')
        if noresult:
            print(f"  NO RESULTS MESSAGE: {noresult.get_text(strip=True)[:100]}")

    page.close()
    browser.close()
