#!/usr/bin/env python3
"""Click on sponsored products and extract details from their product pages"""
import sys
import json
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

print("DEBUG: Script started", file=sys.stderr, flush=True)

marketplace = "amazon.in"  
search_query = "air fryer"
search_url = f"https://{marketplace}/s?k=air+fryer"

clicked_products = []

print("Starting sponsored product click extraction from amazon.in", flush=True)
print(f"Search URL: {search_url}", flush=True)

with sync_playwright() as pw:
    print("DEBUG: Playwright started", file=sys.stderr, flush=True)
    browser = pw.chromium.launch(headless=True, slow_mo=100)
    context = browser.new_context(
        viewport={"width": 1400, "height": 900},
        locale="en-US",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    )
    page = context.new_page()
    print("DEBUG: Page created", file=sys.stderr, flush=True)

    # Load search page
    print("DEBUG: Loading search page...", file=sys.stderr, flush=True)
    page.goto(search_url, wait_until="load", timeout=75000)
    print("Search page loaded successfully!", flush=True)
    page.wait_for_timeout(1500)

    # Scroll to trigger lazy loading
    print("DEBUG: Starting scroll...", file=sys.stderr, flush=True)
    for i in range(4):
        page.mouse.wheel(0, 1500)
        page.wait_for_timeout(600)
    print("DEBUG: Scroll complete", file=sys.stderr, flush=True)

    # Find all search results
    items = page.query_selector_all("div.s-main-slot div[data-component-type='s-search-result'][data-asin]")
    print(f"Found {len(items)} search results on the page", flush=True)

    # Identify sponsored results and collect their URLs
    sponsored_items = []
    for idx, item in enumerate(items):
        try:
            asin_val = item.get_attribute("data-asin") or ""
            
            # Check if sponsored
            sponsored_badge = False
            badge_el = item.query_selector("span:has-text('Sponsored'), span[aria-label='Sponsored']")
            if badge_el:
                sponsored_badge = True
            
            if sponsored_badge and asin_val:
                # Get the product link
                link_el = item.query_selector("h2 a.a-link-normal, a.a-link-normal")
                if link_el:
                    href = link_el.get_attribute("href") or ""
                    url = f"https://amazon.in{href}" if not href.startswith("http") else href
                    sponsored_items.append({
                        "asin": asin_val,
                        "position": idx + 1,
                        "url": url
                    })
                    print(f"Found sponsored product at position {idx+1}: {asin_val}", flush=True)
        except Exception as e:
            print(f"Error checking item {idx+1}: {e}", file=sys.stderr, flush=True)

    print(f"\nTotal sponsored products found: {len(sponsored_items)}", flush=True)
    
    # Visit each sponsored product's page via new page (to avoid navigation issues)
    for idx, item in enumerate(sponsored_items):
        try:
            asin_val = item["asin"]
            url = item["url"]
            pos = item["position"]
            
            print(f"\n--- Extracting Sponsored Product {idx+1}/{len(sponsored_items)}: {asin_val} ---", flush=True)
            
            # Open product page in new page
            product_page = context.new_page()
            print(f"Opening URL...", flush=True)
            product_page.goto(url, wait_until="load", timeout=75000)
            product_page.wait_for_timeout(1200)
            
            # Extract product details
            product_details = {
                "asin": asin_val,
                "position_in_search": pos,
                "search_url": url,
                "sponsored": True
            }
            
            # Get current URL (might be different after redirect)
            product_details["current_url"] = product_page.url
            
            # Get title
            try:
                title_el = product_page.query_selector("#productTitle, span#productTitle")
                if title_el:
                    product_details["title"] = title_el.inner_text().strip()
                    print(f"  Title: {product_details['title'][:60]}", flush=True)
            except Exception as e:
                print(f"  Error getting title: {e}", file=sys.stderr, flush=True)
            
            # Get price
            try:
                price_el = product_page.query_selector("#corePrice_feature_div span.a-price span.a-offscreen")
                if not price_el:
                    price_el = product_page.query_selector("span.a-price span.a-offscreen")
                if price_el:
                    product_details["price"] = price_el.inner_text().strip()
                    print(f"  Price: {product_details['price']}", flush=True)
            except Exception as e:
                print(f"  Error getting price: {e}", file=sys.stderr, flush=True)
            
            # Get rating
            try:
                rating_el = product_page.query_selector("#acrPopover .a-icon-alt")
                if rating_el:
                    product_details["rating"] = rating_el.inner_text().strip()
                    print(f"  Rating: {product_details['rating']}", flush=True)
            except Exception as e:
                print(f"  Error getting rating: {e}", file=sys.stderr, flush=True)
            
            # Get availability
            try:
                avail_el = product_page.query_selector("#availability span")
                if avail_el:
                    product_details["availability"] = avail_el.inner_text().strip()
                    print(f"  Availability: {product_details['availability'][:40]}", flush=True)
            except Exception as e:
                print(f"  Error getting availability: {e}", file=sys.stderr, flush=True)
            
            # Get description/features
            try:
                features = []
                feature_els = product_page.query_selector_all("ul li span, #feature-bullets li span")
                for feat in feature_els[:3]:  # First 3 features
                    text = feat.inner_text().strip()
                    if text:
                        features.append(text)
                if features:
                    product_details["features"] = features
                    print(f"  Features: {len(features)} found", flush=True)
            except Exception as e:
                print(f"  Error getting features: {e}", file=sys.stderr, flush=True)
            
            clicked_products.append(product_details)
            product_page.close()
            print(f"Product page closed", flush=True)
            
        except Exception as e:
            print(f"ERROR extracting product {idx+1} ({asin_val}): {e}", file=sys.stderr, flush=True)
            try:
                product_page.close()
            except:
                pass

    browser.close()

print(f"\n\n{'='*60}", flush=True)
print(f"COMPLETED: Clicked and extracted {len(clicked_products)} sponsored products", flush=True)
print(f"{'='*60}\n", flush=True)

print("Outputting JSON results:")
print(json.dumps(clicked_products, indent=2, ensure_ascii=False))

# Also save to file
with open("clicked_products.json", "w", encoding="utf-8") as f:
    json.dump(clicked_products, f, indent=2, ensure_ascii=False)
print(f"\nResults saved to clicked_products.json", flush=True)
