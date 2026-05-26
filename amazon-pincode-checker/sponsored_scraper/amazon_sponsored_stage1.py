import csv
import re
import time
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright

KEYWORD = "glass air fryer"
MAX_PAGES = 3
OUTPUT_FILE = "glass_air_fryer_sponsored_analysis.csv"
BASE_URL = "https://www.amazon.in"
HEADLESS = False  # Set to False to see browser


def clean_text(text: str) -> str:
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
    """Enhanced sponsored detection using multiple methods"""
    try:
        # Method 1: Check for sponsored text in card
        text = clean_text(card.inner_text(timeout=2000))
        if "Sponsored" in text or "sponsored" in text or "Ad" in text or "ad" in text:
            return True

        # Method 2: Check for sponsored badge elements
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

        # Method 3: Check data attributes
        data_attrs = ["data-ad-feedback", "data-ad-details", "data-component-type"]
        for attr in data_attrs:
            val = safe_attr(card, attr)
            if val and ("sponsor" in val.lower() or "ad" in val.lower()):
                return True

        return False
    except:
        return False


def extract_title(card):
    selectors = [
        "h2 span",
        "[data-cy='title-recipe'] span",
        "h2 a span",
        "span.a-size-medium",
        "span.a-size-base-plus",
    ]
    for sel in selectors:
        txt = safe_text(card.locator(sel))
        if txt:
            return txt
    return ""


def extract_brand(card):
    """Extract brand information from product card"""
    selectors = [
        "span.a-size-base.a-color-secondary",
        "span.a-size-small.a-color-secondary",
        ".a-color-secondary",
        "[data-cy='byline-container'] span",
    ]
    for sel in selectors:
        txt = safe_text(card.locator(sel))
        if txt and len(txt) > 2 and not txt.startswith("₹") and "Sponsored" not in txt:
            return txt
    return ""


def extract_link(card):
    selectors = [
        "h2 a",
        "a.a-link-normal.s-no-outline",
        "a.a-link-normal",
        "a[href*='/dp/']",
    ]
    for sel in selectors:
        href = safe_attr(card.locator(sel), "href")
        if href:
            return urljoin(BASE_URL, href)
    return ""


def extract_price(card):
    selectors = [
        ".a-price .a-offscreen",
        "span.a-price > span.a-offscreen",
        ".a-price-whole",
        "span.a-price span.a-offscreen",
    ]
    for sel in selectors:
        txt = safe_text(card.locator(sel))
        if txt:
            return txt
    return ""


def extract_rating(card):
    selectors = [
        "span.a-icon-alt",
        "i.a-icon-star span",
        ".a-icon-star span",
    ]
    for sel in selectors:
        txt = safe_text(card.locator(sel))
        if txt and ("stars" in txt or "star" in txt):
            return txt
    return ""


def extract_asin_from_url(url):
    """Extract ASIN from product URL"""
    if not url:
        return ""
    match = re.search(r"/dp/([A-Z0-9]{10})", url)
    return match.group(1) if match else ""


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
    """Aggressively scroll the page to trigger lazy loading"""
    print(f"Scrolling page {page_no} to load all content...")

    # Initial scroll to bottom
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(1000)

    # Multiple scroll cycles to trigger lazy loading
    for scroll_cycle in range(3):
        page.mouse.wheel(0, 1500)
        page.wait_for_timeout(500)

        # Check if new content loaded
        current_height = page.evaluate("document.body.scrollHeight")
        page.evaluate(f"window.scrollTo(0, {current_height})")
        page.wait_for_timeout(500)

    print(f"Page {page_no} scrolling complete.")


def main():
    rows = []
    sponsored_brands = {}
    total_products = 0

    print(f"🔍 Starting sponsored analysis for keyword: '{KEYWORD}'")
    print(f"📄 Will analyze {MAX_PAGES} pages")
    print(f"💾 Results will be saved to: {OUTPUT_FILE}")
    print(f"🌐 Headless mode: {HEADLESS}")
    print("-" * 60)

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
            print("❌ Amazon homepage is still showing 503. Please try later.")
            browser.close()
            return

        print("✅ Amazon homepage opened successfully.")

        # Accept cookies if prompted
        try:
            cookie_btn = page.locator("input#sp-cc-accept, span:has-text('Accept Cookies')").first
            if cookie_btn.count() > 0:
                cookie_btn.click()
                page.wait_for_timeout(500)
                print("🍪 Accepted cookies")
        except:
            pass

        try:
            search_keyword_from_home(page, KEYWORD)
            print(f"✅ Search completed for: '{KEYWORD}'")
        except Exception as e:
            print(f"❌ Search failed: {e}")
            browser.close()
            return

        for page_no in range(1, MAX_PAGES + 1):
            print(f"\n📄 Analyzing page {page_no}...")

            if is_503_page(page):
                print("❌ 503 error on results page. Stopping analysis.")
                break

            # Scroll to load all content
            scroll_and_load_page(page, page_no)

            # Find all product cards
            cards = page.locator("div.s-result-item[data-asin], div[data-component-type='s-search-result'][data-asin]")
            count = cards.count()
            print(f"📦 Found {count} product cards on page {page_no}")

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
                    link = extract_link(card)
                    price = extract_price(card)
                    rating = extract_rating(card)
                    brand = extract_brand(card)

                    # Track brand statistics
                    if brand:
                        if brand not in sponsored_brands:
                            sponsored_brands[brand] = []
                        sponsored_brands[brand].append({
                            'page': page_no,
                            'position': position,
                            'asin': asin
                        })

                    print(f"🎯 Sponsored | Page {page_no} | Pos {position} | ASIN {asin} | Brand: {brand or 'Unknown'}")

                    rows.append({
                        "keyword": KEYWORD,
                        "page_no": page_no,
                        "position_on_page": position,
                        "overall_position": total_products,
                        "asin": asin,
                        "title": title,
                        "brand": brand,
                        "link": link,
                        "price": price,
                        "rating": rating,
                        "sponsored": True,
                    })
                else:
                    # Still record organic products for completeness
                    rows.append({
                        "keyword": KEYWORD,
                        "page_no": page_no,
                        "position_on_page": position,
                        "overall_position": total_products,
                        "asin": asin,
                        "title": title,
                        "brand": extract_brand(card),
                        "link": extract_link(card),
                        "price": extract_price(card),
                        "rating": extract_rating(card),
                        "sponsored": False,
                    })

            print(f"📊 Page {page_no} summary: {sponsored_on_page} sponsored, {count - sponsored_on_page} organic")

            # Navigate to next page
            if page_no < MAX_PAGES:
                next_btn = page.locator("a.s-pagination-next, a.s-pagination-item:not(.s-pagination-previous):not(.s-pagination-next)").last
                if next_btn.count() > 0:
                    try:
                        page.wait_for_timeout(2000)
                        next_btn.click()
                        page.wait_for_load_state("domcontentloaded", timeout=20000)
                        page.wait_for_timeout(3000)
                        print(f"➡️ Navigated to page {page_no + 1}")
                    except Exception as e:
                        print(f"❌ Failed to navigate to next page: {e}")
                        break
                else:
                    print("ℹ️ No more pages available")
                    break

        browser.close()

    # Save to CSV
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "keyword",
                "page_no",
                "position_on_page",
                "overall_position",
                "asin",
                "title",
                "brand",
                "link",
                "price",
                "rating",
                "sponsored",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    # Generate comprehensive report
    print("\n" + "="*80)
    print("📊 COMPREHENSIVE SPONSORED ANALYSIS REPORT")
    print("="*80)
    print(f"🔍 Keyword: '{KEYWORD}'")
    print(f"📄 Pages analyzed: {MAX_PAGES}")
    print(f"📦 Total products found: {total_products}")
    print(f"🎯 Sponsored products: {len([r for r in rows if r['sponsored']])}")
    print(f"📈 Sponsored percentage: {len([r for r in rows if r['sponsored']]) / total_products * 100:.1f}%")

    print(f"\n💾 Results saved to: {OUTPUT_FILE}")

    # Brand analysis
    print(f"\n🏷️ SPONSORED BRANDS ANALYSIS:")
    print("-" * 40)

    sponsored_rows = [r for r in rows if r['sponsored']]
    brand_stats = {}
    for row in sponsored_rows:
        brand = row.get('brand', 'Unknown') or 'Unknown'
        if brand not in brand_stats:
            brand_stats[brand] = []
        brand_stats[brand].append(row)

    for brand, products in sorted(brand_stats.items(), key=lambda x: len(x[1]), reverse=True):
        positions = [str(p['position_on_page']) for p in products]
        pages = list(set(str(p['page_no']) for p in products))
        print(f"🏷️ {brand}: {len(products)} ads (Pages: {', '.join(pages)} | Positions: {', '.join(positions)})")

    print(f"\n✅ Analysis complete! Check {OUTPUT_FILE} for detailed data.")
    print("="*80)


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()