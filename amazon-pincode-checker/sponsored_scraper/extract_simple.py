#!/usr/bin/env python3
"""Improved: Click on sponsored products with better error handling"""
import sys
import json
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

marketplace = "amazon.in"  
search_url = f"https://{marketplace}/s?k=air+fryer"

clicked_products = []

print("Starting sponsored product extraction from amazon.in", flush=True)

try:
    with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, slow_mo=80)
    context = browser.new_context(
        viewport={"width": 1400, "height": 900},
        locale="en-US",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    )
    page = context.new_page()

    # Load search page
    page.goto(search_url, wait_until="load", timeout=60000)
    page.wait_for_timeout(1500)

    # Scroll to trigger lazy loading
    for i in range(4):
        page.mouse.wheel(0, 1500)
        page.wait_for_timeout(600)

    # Find all search results
    items = page.query_selector_all("div.s-main-slot div[data-component-type='s-search-result'][data-asin]")
    print(f"Found {len(items)} search results", flush=True)

    # Identify sponsored results
    sponsored_items = []
    for idx, item in enumerate(items):
        try:
            asin_val = item.get_attribute("data-asin") or ""
            badge_el = item.query_selector("span:has-text('Sponsored'), span[aria-label='Sponsored']")
            
            if badge_el and asin_val:
                link_el = item.query_selector("h2 a.a-link-normal, a.a-link-normal")
                if link_el:
                    href = link_el.get_attribute("href") or ""
                    url = f"https://amazon.in{href}" if not href.startswith("http") else href
                    sponsored_items.append({"asin": asin_val, "position": idx + 1, "url": url})
                    print(f"Found sponsored: {asin_val}", flush=True)
        except Exception as e:
            pass

    print(f"Total sponsored products found: {len(sponsored_items)}\n", flush=True)
    
    # Visit each sponsored product
    for idx, item in enumerate(sponsored_items):
        asin_val = item["asin"]
        url = item["url"]
        pos = item["position"]
        
        print(f"[{idx+1}/{len(sponsored_items)}] Extracting {asin_val}...", flush=True)
        
        try:
            product_page = context.new_page()
            product_page.goto(url, wait_until="domcontentloaded", timeout=50000)
            
            product_details = {
                "asin": asin_val,
                "position_in_search": pos,
                "url": product_page.url,
                "sponsored": True
            }
            
            # Get title
            title_el = product_page.query_selector("#productTitle, span#productTitle")
            if title_el:
                product_details["title"] = title_el.inner_text().strip()
            
            # Get price
            price_el = product_page.query_selector("#corePrice_feature_div span.a-price span.a-offscreen")
            if price_el:
                product_details["price"] = price_el.inner_text().strip()
            
            # Get rating
            rating_el = product_page.query_selector("#acrPopover .a-icon-alt")
            if rating_el:
                product_details["rating"] = rating_el.inner_text().strip()
            
            # Get availability
            avail_el = product_page.query_selector("#availability span")
            if avail_el:
                product_details["availability"] = avail_el.inner_text().strip()
            
            clicked_products.append(product_details)
            product_page.close()
            
            print(f"  ✓ {product_details.get('title', 'N/A')[:50]}", flush=True)
            print(f"    Price: {product_details.get('price', 'N/A')} | Rating: {product_details.get('rating', 'N/A')[:10]}", flush=True)
            
        except Exception as e:
            print(f"  ✗ ERROR: {e}", flush=True)
            try:
                product_page.close()
            except:
                pass

    browser.close()

# Save results
with open("clicked_products.json", "w", encoding="utf-8") as f:
    json.dump(clicked_products, f, indent=2, ensure_ascii=False)

print(f"\n{'='*60}")
print(f"COMPLETED: Extracted {len(clicked_products)}/{len(sponsored_items)} sponsored products")
print(f"{'='*60}")
print("\nJSON Results:")
print(json.dumps(clicked_products, indent=2, ensure_ascii=False))
