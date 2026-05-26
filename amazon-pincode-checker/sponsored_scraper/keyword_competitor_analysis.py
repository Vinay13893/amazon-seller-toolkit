#!/usr/bin/env python3
"""
Keyword Competitor & Sales Analysis
Scrapes Amazon.in search results for a keyword to find:
1. How many competitors are running sponsored ads
2. Sales indicators (BSR, ratings count, review count) for each product
"""
import csv
import re
import sys
import time
import os
from urllib.parse import urljoin
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

KEYWORD = "gym mats for floor"
MAX_PAGES = 5
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "output", f"competitor_analysis_{KEYWORD.replace(' ', '_')}.csv")
BASE_URL = "https://www.amazon.in"
HEADLESS = False
VISIT_PRODUCT_PAGES = True  # Visit each sponsored product to get BSR & sales

# Our own EVA Gym ASINs (LilToes / eHomekart)
OWN_ASINS = {
    "B0CRKV5XTR", "B0CRKV6Z84", "B0CRKV362W", "B0C1431JNZ", "B0C141W8X1",
    "B0C145JTP3", "B0C145GFJY", "B0C143T5D8", "B0C1471G4X", "B08642G3SR",
    "B086424GCB", "B0B5RVR7ZF", "B0D9HCMCCY", "B0D9HB8LTP", "B0D9HH4VYG",
    "B0D9HBVW5C", "B0D9HD43H9", "B0D9HDFSH3", "B0D9HBH1XQ", "B0F9X8LW1G",
    "B0DX25VNGF", "B0GL8BF4Z6", "B0F2TH8Z6S", "B0F2TLCK85", "B0B6VCW2VK",
}


def clean_text(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def safe_text(locator, timeout=1500):
    try:
        if locator.count() > 0:
            return clean_text(locator.first.inner_text(timeout=timeout))
    except:
        pass
    return ""


def safe_attr(locator, attr, timeout=1500):
    try:
        if locator.count() > 0:
            val = locator.first.get_attribute(attr, timeout=timeout)
            return (val or "").strip()
    except:
        pass
    return ""


def is_503_page(page):
    try:
        title = page.title().lower()
    except:
        title = ""
    try:
        body = clean_text(page.locator("body").inner_text(timeout=2000)).lower()
    except:
        body = ""
    return (
        "503" in title
        or "service unavailable" in title
        or "oops!" in body
        or "traffic is piling up" in body
    )


def wait_and_retry_home(page, tries=3):
    for attempt in range(1, tries + 1):
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)
        if not is_503_page(page):
            return True
        print(f"Amazon returned 503 on homepage. Retry {attempt}/{tries}...")
        page.wait_for_timeout(15000)
    return False


def is_sponsored(card):
    try:
        text = clean_text(card.inner_text(timeout=2000))
        if "Sponsored" in text:
            return True
        badge_selectors = [
            "span.puis-label-popover-default",
            "span.s-label-popover-default",
            "span[data-component-type='s-sponsored-label-info-icon']",
            "div[data-component-type='s-sponsored-label-info-icon']",
            "span[aria-label='Sponsored']",
            "div[aria-label='Sponsored']",
            ".a-color-secondary:has-text('Sponsored')",
            "span.a-size-base.a-color-secondary:has-text('Sponsored')",
        ]
        for selector in badge_selectors:
            if card.locator(selector).count() > 0:
                return True
        for attr in ["data-ad-feedback", "data-ad-details"]:
            val = safe_attr(card, attr)
            if val and ("sponsor" in val.lower() or "ad" in val.lower()):
                return True
        return False
    except:
        return False


def extract_title(card):
    for sel in ["h2 span", "[data-cy='title-recipe'] span", "h2 a span", "span.a-size-medium", "span.a-size-base-plus"]:
        txt = safe_text(card.locator(sel))
        if txt:
            return txt
    return ""


def extract_brand(card):
    for sel in ["span.a-size-base.a-color-secondary", "span.a-size-small.a-color-secondary", ".a-color-secondary", "[data-cy='byline-container'] span"]:
        txt = safe_text(card.locator(sel))
        if txt and len(txt) > 2 and not txt.startswith("₹") and "Sponsored" not in txt:
            return txt
    return ""


def extract_link(card):
    for sel in ["h2 a", "a.a-link-normal.s-no-outline", "a.a-link-normal", "a[href*='/dp/']"]:
        href = safe_attr(card.locator(sel), "href")
        if href:
            return urljoin(BASE_URL, href)
    return ""


def extract_price(card):
    for sel in [".a-price .a-offscreen", "span.a-price > span.a-offscreen", ".a-price-whole", "span.a-price span.a-offscreen"]:
        txt = safe_text(card.locator(sel))
        if txt:
            return txt
    return ""


def extract_rating(card):
    for sel in ["span.a-icon-alt", "i.a-icon-star span", ".a-icon-star span"]:
        txt = safe_text(card.locator(sel))
        if txt and ("star" in txt.lower()):
            return txt
    return ""


def extract_review_count(card):
    """Extract number of ratings from search result card"""
    for sel in ["span.a-size-base.s-underline-text", "a span.a-size-base", "[aria-label*='ratings']"]:
        txt = safe_text(card.locator(sel))
        if txt:
            # Clean up and extract number
            num = re.sub(r"[^\d,]", "", txt)
            if num:
                return num
    return ""


def extract_asin_from_url(url):
    if not url:
        return ""
    match = re.search(r"/dp/([A-Z0-9]{10})", url)
    return match.group(1) if match else ""


def extract_bsr_from_product_page(page):
    """Extract BSR from a product detail page"""
    bsr_info = {"bsr_rank": "", "bsr_category": "", "monthly_sales_est": ""}
    try:
        # Method 1: Product information table
        detail_bullets = page.locator("#detailBulletsWrapper_feature_div, #productDetails_detailBullets_sections1, .a-section.a-spacing-small.a-spacing-top-small").first
        if detail_bullets.count() > 0:
            text = clean_text(detail_bullets.inner_text(timeout=3000))
            bsr_match = re.search(r'Best\s*Sellers?\s*Rank[:\s]*#?([\d,]+)\s+in\s+([^\(#\n]+)', text, re.IGNORECASE)
            if bsr_match:
                bsr_info["bsr_rank"] = bsr_match.group(1).replace(",", "")
                bsr_info["bsr_category"] = bsr_match.group(2).strip()

        # Method 2: Product details section
        if not bsr_info["bsr_rank"]:
            tables = page.locator("table.a-keyvalue.prodDetTable, #productDetails_techSpec_section_1, #productDetails_detailBullets_sections1")
            if tables.count() > 0:
                text = clean_text(tables.inner_text(timeout=3000))
                bsr_match = re.search(r'#?([\d,]+)\s+in\s+([^\(#\n]+)', text, re.IGNORECASE)
                if bsr_match:
                    bsr_info["bsr_rank"] = bsr_match.group(1).replace(",", "")
                    bsr_info["bsr_category"] = bsr_match.group(2).strip()

        # Method 3: Full page text search
        if not bsr_info["bsr_rank"]:
            body_text = page.locator("body").inner_text(timeout=5000)
            bsr_match = re.search(r'Best\s*Sellers?\s*Rank[:\s]*#?([\d,]+)\s+in\s+([^\(#\n]+)', body_text, re.IGNORECASE)
            if bsr_match:
                bsr_info["bsr_rank"] = bsr_match.group(1).replace(",", "")
                bsr_info["bsr_category"] = bsr_match.group(2).strip()

        # Estimate monthly sales from BSR (rough formula for Amazon India)
        if bsr_info["bsr_rank"]:
            rank = int(bsr_info["bsr_rank"])
            if rank <= 100:
                est = "3000+"
            elif rank <= 500:
                est = "1000-3000"
            elif rank <= 1000:
                est = "500-1000"
            elif rank <= 3000:
                est = "200-500"
            elif rank <= 5000:
                est = "100-200"
            elif rank <= 10000:
                est = "50-100"
            elif rank <= 30000:
                est = "20-50"
            elif rank <= 50000:
                est = "10-20"
            elif rank <= 100000:
                est = "5-10"
            else:
                est = "<5"
            bsr_info["monthly_sales_est"] = est

    except Exception as e:
        print(f"  BSR extraction error: {e}")

    return bsr_info


def extract_product_page_details(page):
    """Extract additional details from product detail page"""
    details = {
        "bsr_rank": "",
        "bsr_category": "",
        "monthly_sales_est": "",
        "total_ratings": "",
        "bought_last_month": "",
    }

    try:
        # BSR
        bsr = extract_bsr_from_product_page(page)
        details.update(bsr)

        # Total ratings from product page
        rating_loc = page.locator("#acrCustomerReviewText, span[data-hook='total-review-count']").first
        if rating_loc.count() > 0:
            txt = clean_text(rating_loc.inner_text(timeout=2000))
            num = re.sub(r"[^\d,]", "", txt)
            if num:
                details["total_ratings"] = num

        # "X bought in past month" badge
        bought_loc = page.locator("#social-proofing-faceout-title-tk_bought span, .social-proofing-faceout-title span").first
        if bought_loc.count() > 0:
            txt = clean_text(bought_loc.inner_text(timeout=2000))
            if txt:
                num_match = re.search(r'([\d,K+]+)', txt)
                if num_match:
                    details["bought_last_month"] = num_match.group(1)

        # Fallback: check full page for "bought in past month"
        if not details["bought_last_month"]:
            try:
                body = page.locator("body").inner_text(timeout=5000)
                bought_match = re.search(r'([\d,K+]+)\s*bought\s+in\s+past\s+month', body, re.IGNORECASE)
                if bought_match:
                    details["bought_last_month"] = bought_match.group(1)
            except:
                pass

    except Exception as e:
        print(f"  Product page extraction error: {e}")

    return details


def search_keyword_from_home(page, keyword):
    search_box_selectors = [
        "#twotabsearchtextbox",
        "input[name='field-keywords']",
        "input[placeholder*='Search']",
    ]
    search_box = None
    for sel in search_box_selectors:
        loc = page.locator(sel).first
        if loc.count() > 0:
            search_box = loc
            break
    if search_box is None:
        raise Exception("Search box not found on Amazon homepage.")

    search_box.click()
    page.wait_for_timeout(1000)
    search_box.fill("")
    page.wait_for_timeout(500)
    search_box.type(keyword, delay=120)
    page.wait_for_timeout(1000)
    search_box.press("Enter")
    page.wait_for_load_state("domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)

    if is_503_page(page):
        raise Exception("Amazon returned 503 after search.")


def scroll_and_load_page(page, page_no):
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(1000)
    for _ in range(3):
        page.mouse.wheel(0, 1500)
        page.wait_for_timeout(500)
        current_height = page.evaluate("document.body.scrollHeight")
        page.evaluate(f"window.scrollTo(0, {current_height})")
        page.wait_for_timeout(500)


def main():
    rows = []
    all_products = []
    total_products = 0

    # ensure output directory exists
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

    print(f"\n{'='*80}")
    print(f"KEYWORD COMPETITOR & SALES ANALYSIS")
    print(f"{'='*80}")
    print(f"Keyword: '{KEYWORD}'")
    print(f"Pages to analyze: {MAX_PAGES}")
    print(f"Visit product pages for BSR: {VISIT_PRODUCT_PAGES}")
    print(f"Output: {OUTPUT_FILE}")
    print(f"{'='*80}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=HEADLESS,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )
        context = browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        ok = wait_and_retry_home(page, tries=3)
        if not ok:
            print("Amazon homepage is still showing 503. Please try later.")
            browser.close()
            return

        print("Amazon homepage opened successfully.")

        # Accept cookies
        try:
            cookie_btn = page.locator("input#sp-cc-accept, span:has-text('Accept Cookies')").first
            if cookie_btn.count() > 0:
                cookie_btn.click()
                page.wait_for_timeout(500)
        except:
            pass

        try:
            search_keyword_from_home(page, KEYWORD)
            print(f"Search completed for: '{KEYWORD}'\n")
        except Exception as e:
            print(f"Search failed: {e}")
            browser.close()
            return

        # ── Phase 1: Scrape search results across pages ──
        for page_no in range(1, MAX_PAGES + 1):
            print(f"\n--- Page {page_no} ---")

            if is_503_page(page):
                print("503 error on results page. Stopping.")
                break

            scroll_and_load_page(page, page_no)

            cards = page.locator("div.s-result-item[data-asin], div[data-component-type='s-search-result'][data-asin]")
            count = cards.count()
            print(f"Found {count} product cards")

            position = 0
            sponsored_on_page = 0

            for i in range(count):
                card = cards.nth(i)
                asin = (card.get_attribute("data-asin") or "").strip()
                if not asin:
                    continue

                title = extract_title(card)
                if not title:
                    continue

                total_products += 1
                position += 1
                sponsored = is_sponsored(card)

                if sponsored:
                    sponsored_on_page += 1

                brand = extract_brand(card)
                link = extract_link(card)
                price = extract_price(card)
                rating = extract_rating(card)
                review_count = extract_review_count(card)

                is_own = asin in OWN_ASINS
                row = {
                    "keyword": KEYWORD,
                    "page_no": page_no,
                    "position_on_page": position,
                    "overall_position": total_products,
                    "asin": asin,
                    "title": title[:120],
                    "brand": brand,
                    "price": price,
                    "rating": rating,
                    "review_count": review_count,
                    "sponsored": sponsored,
                    "is_own": is_own,
                    "link": link,
                    "bsr_rank": "",
                    "bsr_category": "",
                    "monthly_sales_est": "",
                    "total_ratings_page": "",
                    "bought_last_month": "",
                }
                all_products.append(row)

                tag = "[OWN]" if is_own else "[AD]" if sponsored else "     "
                if sponsored or is_own:
                    print(f"  {tag} Pos {position} | {asin} | {brand or '?'} | {price} | {review_count} reviews")

            print(f"Page {page_no}: {sponsored_on_page} sponsored / {position} total products")

            # Navigate to next page
            if page_no < MAX_PAGES:
                next_btn = page.locator("a.s-pagination-next").first
                if next_btn.count() > 0:
                    try:
                        page.wait_for_timeout(2000)
                        next_btn.click()
                        page.wait_for_load_state("domcontentloaded", timeout=20000)
                        page.wait_for_timeout(3000)
                    except Exception as e:
                        print(f"Failed to navigate to next page: {e}")
                        break
                else:
                    print("No more pages available")
                    break

        # ── Phase 2: Visit sponsored product pages for BSR & sales data ──
        sponsored_products = [r for r in all_products if r["sponsored"]]

        if VISIT_PRODUCT_PAGES and sponsored_products:
            print(f"\n{'='*80}")
            print(f"PHASE 2: Visiting {len(sponsored_products)} sponsored product pages for sales data...")
            print(f"{'='*80}\n")

            for idx, prod in enumerate(sponsored_products):
                if not prod["link"]:
                    continue
                print(f"  [{idx+1}/{len(sponsored_products)}] Visiting {prod['asin']}...", end=" ", flush=True)
                try:
                    product_page = context.new_page()
                    product_page.goto(prod["link"], wait_until="domcontentloaded", timeout=30000)
                    product_page.wait_for_timeout(2000)

                    # Scroll down to load BSR section
                    product_page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                    product_page.wait_for_timeout(1000)
                    product_page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    product_page.wait_for_timeout(1000)

                    details = extract_product_page_details(product_page)
                    prod["bsr_rank"] = details["bsr_rank"]
                    prod["bsr_category"] = details["bsr_category"]
                    prod["monthly_sales_est"] = details["monthly_sales_est"]
                    prod["total_ratings_page"] = details["total_ratings"]
                    prod["bought_last_month"] = details["bought_last_month"]

                    bsr_str = f"BSR #{prod['bsr_rank']}" if prod['bsr_rank'] else "No BSR"
                    bought_str = f"Bought: {prod['bought_last_month']}/mo" if prod['bought_last_month'] else ""
                    print(f"{bsr_str} | Est: {prod['monthly_sales_est']}/mo | {bought_str}")

                    product_page.close()
                    time.sleep(1)  # Be respectful
                except Exception as e:
                    print(f"Error: {e}")
                    try:
                        product_page.close()
                    except:
                        pass

        # Also visit top organic products for comparison
        organic_products = [r for r in all_products if not r["sponsored"]][:10]
        if VISIT_PRODUCT_PAGES and organic_products:
            print(f"\nVisiting top {len(organic_products)} organic products for sales comparison...")
            for idx, prod in enumerate(organic_products):
                if not prod["link"]:
                    continue
                print(f"  [{idx+1}/{len(organic_products)}] Visiting {prod['asin']}...", end=" ", flush=True)
                try:
                    product_page = context.new_page()
                    product_page.goto(prod["link"], wait_until="domcontentloaded", timeout=30000)
                    product_page.wait_for_timeout(2000)
                    product_page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                    product_page.wait_for_timeout(1000)
                    product_page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    product_page.wait_for_timeout(1000)

                    details = extract_product_page_details(product_page)
                    prod["bsr_rank"] = details["bsr_rank"]
                    prod["bsr_category"] = details["bsr_category"]
                    prod["monthly_sales_est"] = details["monthly_sales_est"]
                    prod["total_ratings_page"] = details["total_ratings"]
                    prod["bought_last_month"] = details["bought_last_month"]

                    bsr_str = f"BSR #{prod['bsr_rank']}" if prod['bsr_rank'] else "No BSR"
                    bought_str = f"Bought: {prod['bought_last_month']}/mo" if prod['bought_last_month'] else ""
                    print(f"{bsr_str} | Est: {prod['monthly_sales_est']}/mo | {bought_str}")

                    product_page.close()
                    time.sleep(1)
                except Exception as e:
                    print(f"Error: {e}")
                    try:
                        product_page.close()
                    except:
                        pass

        browser.close()

    # ── Save CSV ──
    fieldnames = [
        "keyword", "page_no", "position_on_page", "overall_position",
        "asin", "title", "brand", "price", "rating", "review_count",
        "sponsored", "is_own", "bsr_rank", "bsr_category", "monthly_sales_est",
        "total_ratings_page", "bought_last_month", "link",
    ]
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_products)

    # ── FINAL REPORT ──
    sponsored_products = [r for r in all_products if r["sponsored"]]
    organic_products = [r for r in all_products if not r["sponsored"]]

    print(f"\n{'='*80}")
    print(f"KEYWORD COMPETITOR ANALYSIS REPORT")
    print(f"{'='*80}")
    print(f"Keyword: '{KEYWORD}'")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M')}")
    print(f"Pages analyzed: {MAX_PAGES}")
    print(f"{'='*80}")

    print(f"\n--- OVERVIEW ---")
    print(f"Total products found: {len(all_products)}")
    print(f"Sponsored (ads): {len(sponsored_products)}")
    print(f"Organic: {len(organic_products)}")
    print(f"Ad saturation: {len(sponsored_products)/max(len(all_products),1)*100:.1f}%")

    # Unique advertiser brands
    ad_brands = {}
    for r in sponsored_products:
        brand = r.get("brand") or "Unknown"
        if brand not in ad_brands:
            ad_brands[brand] = {"count": 0, "asins": [], "positions": []}
        ad_brands[brand]["count"] += 1
        ad_brands[brand]["asins"].append(r["asin"])
        ad_brands[brand]["positions"].append(f"P{r['page_no']}-{r['position_on_page']}")

    print(f"Unique brands running ads: {len(ad_brands)}")

    print(f"\n--- SPONSORED ADVERTISERS (by # of ad slots) ---")
    for brand, data in sorted(ad_brands.items(), key=lambda x: x[1]["count"], reverse=True):
        print(f"  {brand}: {data['count']} ads | ASINs: {', '.join(data['asins'][:3])} | Positions: {', '.join(data['positions'][:5])}")

    # Sales data for sponsored products
    print(f"\n--- SALES DATA (Sponsored Products) ---")
    print(f"{'ASIN':<12} {'Brand':<25} {'Price':<12} {'BSR':<10} {'Est Sales/mo':<14} {'Bought/mo':<12} {'Ratings'}")
    print("-" * 110)
    for r in sorted(sponsored_products, key=lambda x: int(x["bsr_rank"]) if x["bsr_rank"] else 999999):
        bsr = f"#{r['bsr_rank']}" if r["bsr_rank"] else "-"
        print(f"{r['asin']:<12} {(r['brand'] or '?')[:24]:<25} {r['price'][:11]:<12} {bsr:<10} {r['monthly_sales_est'] or '-':<14} {r['bought_last_month'] or '-':<12} {r['total_ratings_page'] or r['review_count'] or '-'}")

    # Sales data for top organic
    organic_with_bsr = [r for r in organic_products if r["bsr_rank"]]
    if organic_with_bsr:
        print(f"\n--- SALES DATA (Top Organic Products) ---")
        print(f"{'ASIN':<12} {'Brand':<25} {'Price':<12} {'BSR':<10} {'Est Sales/mo':<14} {'Bought/mo':<12} {'Ratings'}")
        print("-" * 110)
        for r in sorted(organic_with_bsr, key=lambda x: int(x["bsr_rank"]) if x["bsr_rank"] else 999999):
            bsr = f"#{r['bsr_rank']}" if r["bsr_rank"] else "-"
            print(f"{r['asin']:<12} {(r['brand'] or '?')[:24]:<25} {r['price'][:11]:<12} {bsr:<10} {r['monthly_sales_est'] or '-':<14} {r['bought_last_month'] or '-':<12} {r['total_ratings_page'] or r['review_count'] or '-'}")

    # OWN PRODUCTS POSITIONING
    own_products = [r for r in all_products if r.get("is_own")]
    print(f"\n--- YOUR PRODUCTS (LilToes/eHomekart) ---")
    if own_products:
        print(f"Found {len(own_products)} of your products in results:")
        print(f"{'ASIN':<12} {'Page':<6} {'Pos':<6} {'Spons':<7} {'Price':<12} {'BSR':<10} {'Est Sales/mo':<14} {'Bought/mo':<12} {'Ratings'}")
        print("-" * 110)
        for r in own_products:
            bsr = f"#{r['bsr_rank']}" if r["bsr_rank"] else "-"
            spons = "YES" if r["sponsored"] else "no"
            print(f"{r['asin']:<12} {r['page_no']:<6} {r['position_on_page']:<6} {spons:<7} {r['price'][:11]:<12} {bsr:<10} {r['monthly_sales_est'] or '-':<14} {r['bought_last_month'] or '-':<12} {r['total_ratings_page'] or r['review_count'] or '-'}")
    else:
        print("  NONE of your EVA Gym ASINs found in the first 5 pages!")

    print(f"\n--- AD PLACEMENT DISTRIBUTION ---")
    for pg in range(1, MAX_PAGES + 1):
        page_ads = [r for r in sponsored_products if r["page_no"] == pg]
        page_total = [r for r in all_products if r["page_no"] == pg]
        if page_total:
            print(f"  Page {pg}: {len(page_ads)} ads / {len(page_total)} products ({len(page_ads)/len(page_total)*100:.0f}%)")

    print(f"\n{'='*80}")
    print(f"CSV saved: {OUTPUT_FILE}")
    print(f"{'='*80}\n")


if __name__ == "__main__":
    main()
