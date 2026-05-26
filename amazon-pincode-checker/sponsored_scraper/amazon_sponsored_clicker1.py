#!/usr/bin/env python3
"""
Amazon Sponsored Products: Detect + Click + Extract
- Loads a product (ASIN) page to capture Sponsored carousels.
- Loads a search (listing) page, detects Sponsored results, "clicks" them,
  extracts product-page details, and returns.

DISCLAIMER:
- Use responsibly and in accordance with Amazon's Terms of Service and applicable laws.
- Amazon's markup changes; update selectors as needed.
"""

import argparse
import json
import re
import time
from typing import List, Dict, Any, Optional
from urllib.parse import quote_plus, urljoin

try:
    import pandas as pd
except Exception:
    pd = None

from playwright.sync_api import sync_playwright, Page, ElementHandle

ASIN_RE = re.compile(r"/dp/([A-Z0-9]{10})(?:[/?]|$)", re.IGNORECASE)

def normalize_marketplace(marketplace: str) -> str:
    mk = marketplace.strip().lower()
    if not mk.startswith("amazon."):
        mk = f"amazon.{mk}"
    return mk

def build_product_url(marketplace: str, asin: str) -> str:
    return f"https://{normalize_marketplace(marketplace)}/dp/{asin}"

def build_search_url(marketplace: str, query: str) -> str:
    return f"https://{normalize_marketplace(marketplace)}/s?k={quote_plus(query)}"

def safe_text(el: Optional[ElementHandle]) -> str:
    if not el:
        return ""
    try:
        return el.inner_text().strip()
    except Exception:
        return ""

def safe_attr(el: Optional[ElementHandle], name: str) -> str:
    if not el:
        return ""
    try:
        v = el.get_attribute(name)
        return v or ""
    except Exception:
        return ""

def extract_asin_from_url(url: str) -> Optional[str]:
    m = ASIN_RE.search(url or "")
    return m.group(1) if m else None

# ---------------- Product-page helpers ----------------

def get_product_title(page: Page) -> str:
    selectors = [
        "#productTitle",
        "h1#title span",
        "span[id='productTitle']",
    ]
    for sel in selectors:
        el = page.query_selector(sel)
        if el:
            t = safe_text(el)
            if t:
                return t
    return ""

def get_product_price(page: Page) -> str:
    sels = [
        "#corePrice_feature_div span.a-price span.a-offscreen",
        "#corePrice_feature_div span.a-price-whole",
        "span.a-price span.a-offscreen"
    ]
    for sel in sels:
        el = page.query_selector(sel)
        if el:
            t = safe_text(el)
            if t:
                return t
    return ""

def get_product_rating(page: Page) -> str:
    sels = [
        "#acrPopover .a-icon-alt",
        "span#acrPopover i.a-icon-star span",
    ]
    for sel in sels:
        el = page.query_selector(sel)
        if el:
            t = safe_text(el)
            if t:
                return t
    return ""

def scrape_product_page_sponsored_carousels(page: Page, base_url: str) -> List[Dict[str, Any]]:
    """Find 'Sponsored ...' carousels on the product page and extract items."""
    results = []
    headings = page.query_selector_all("h2, h3, h4")
    sponsored_headings = []
    for h in headings:
        txt = safe_text(h)
        if txt and "sponsor" in txt.lower():
            sponsored_headings.append(h)

    for h in sponsored_headings:
        section = h
        # ascend to a parent that contains carousel cards
        for _ in range(5):
            section = section.parent_element()
            if not section:
                break
            cards = section.query_selector_all(".a-carousel-card, li.a-carousel-card, .p13n-sc-uncoverable-faceout")
            if cards:
                heading_text = safe_text(h)
                for i, card in enumerate(cards, start=1):
                    link = (card.query_selector("a.a-link-normal[href*='/dp/']") or
                            card.query_selector("a[href*='/dp/']") or
                            card.query_selector("a.a-link-normal"))
                    href = safe_attr(link, "href")
                    url = urljoin(base_url, href) if href else ""
                    asin = extract_asin_from_url(url) or safe_attr(card, "data-asin") or ""

                    title_el = (card.query_selector("h2, h3, span.a-size-medium, span.a-size-base-plus") or
                                card.query_selector("img[alt]"))
                    title = safe_text(title_el) or safe_attr(title_el, "alt")
                    price = extract_price_from_item(card=None, page=None, scope=card)
                    rating = extract_rating_from_item(card=None, page=None, scope=card)

                    if asin or url or title:
                        results.append({
                            "source": "product_page_carousel",
                            "carousel_heading": heading_text,
                            "position_in_carousel": i,
                            "asin": asin,
                            "title": title,
                            "url": url,
                            "price": price,
                            "rating": rating,
                            "sponsored": True,
                            "badge_detected": "Sponsored (carousel)"
                        })
                break
    return results

# --------------- Search-listing helpers ---------------

def is_item_sponsored(item_el: ElementHandle, page: Optional[Page] = None) -> bool:
    """
    Detect whether a search-result card is a Sponsored product.
    Uses multiple strategies because Amazon frequently changes markup.
    """

    # Strategy 1 – CSS selectors for known badge elements
    badge_selectors = [
        "span.puis-label-popover-default",
        "span.s-label-popover-default",
        "span[data-component-type='s-sponsored-label-info-icon']",
        "div[data-component-type='s-sponsored-label-info-icon']",
        "span[aria-label='Sponsored']",
        "div[aria-label='Sponsored']",
        ".a-color-secondary:has-text('Sponsored')",
        "span.a-size-base.a-color-secondary:has-text('Sponsored')",
        "span:has-text('Sponsored')",
    ]
    for sel in badge_selectors:
        try:
            el = item_el.query_selector(sel)
            if el:
                txt = safe_text(el)
                if txt and ("sponsor" in txt.lower() or txt.strip().lower() == "ad"):
                    return True
        except Exception:
            continue

    # Strategy 2 – Check data-* attributes on the item itself
    try:
        comp_type = safe_attr(item_el, "data-component-type") or ""
        if "sponsor" in comp_type.lower() or "ad" in comp_type.lower():
            return True
        ad_attr = safe_attr(item_el, "data-ad-feedback") or safe_attr(item_el, "data-ad-details")
        if ad_attr:
            return True
    except Exception:
        pass

    # Strategy 3 – JS innerHTML scan for the word 'Sponsored' in small labels
    if page:
        try:
            found = page.evaluate(
                """(el) => {
                    const spans = el.querySelectorAll('span');
                    for (const s of spans) {
                        const t = (s.textContent || '').trim();
                        if (t === 'Sponsored' || t === 'Ad') return true;
                    }
                    return false;
                }""",
                item_el,
            )
            if found:
                return True
        except Exception:
            pass

    # Strategy 4 – Fallback: search full inner text for standalone 'Sponsored'
    try:
        full_text = item_el.inner_text()
        # Look for 'Sponsored' appearing as its own word (not inside product titles)
        if re.search(r'(?<![\w])Sponsored(?![\w])', full_text):
            return True
    except Exception:
        pass

    return False

def extract_price_from_item(card: Optional[ElementHandle], page: Optional[Page], scope: Optional[ElementHandle] = None) -> str:
    root = scope or card
    if not root:
        return ""
    price_sels = [
        "span.a-price span.a-offscreen",
        "span.a-price .a-price-whole",
    ]
    for sel in price_sels:
        el = root.query_selector(sel)
        if el:
            t = safe_text(el)
            if t:
                return t
    return ""

def extract_rating_from_item(card: Optional[ElementHandle], page: Optional[Page], scope: Optional[ElementHandle] = None) -> str:
    root = scope or card
    if not root:
        return ""
    rating_sels = [
        "span.a-icon-alt",
        "i.a-icon-star-small span",
    ]
    for sel in rating_sels:
        el = root.query_selector(sel)
        if el:
            t = safe_text(el)
            if t:
                return t
    return ""

def extract_link_and_title(item_el: ElementHandle):
    a = (item_el.query_selector("h2 a.a-link-normal, h2 a.a-link-normal.a-text-normal, a.a-link-normal.a-text-normal")
         or item_el.query_selector("a.a-link-normal"))
    href = safe_attr(a, "href") if a else ""
    title = safe_text(a) if a else ""
    return a, href, title

def _find_sponsored_via_js(page: Page) -> List[Dict[str, Any]]:
    """
    Use JavaScript to walk the DOM from every 'Sponsored' leaf-text node
    upward, collecting product links + ASINs regardless of container type.
    This catches inline video ads, sponsored brand banners, etc.
    """
    try:
        return page.evaluate("""
            () => {
                const results = [];
                const seen = new Set();

                // Find all leaf spans whose trimmed text is exactly 'Sponsored'
                const spans = document.querySelectorAll('span');
                for (const sp of spans) {
                    if (sp.children.length > 0) continue;
                    const t = (sp.textContent || '').trim();
                    if (t !== 'Sponsored') continue;

                    // Walk up to find a container with a product link
                    let el = sp;
                    let link = null;
                    let asin = '';
                    for (let i = 0; i < 20 && el; i++) {
                        el = el.parentElement;
                        if (!el) break;

                        // Check for data-asin on any ancestor
                        if (!asin && el.dataset && el.dataset.asin) {
                            asin = el.dataset.asin;
                        }

                        // Look for a product link (contains /dp/)
                        if (!link) {
                            const a = el.querySelector('a[href*="/dp/"]');
                            if (a) link = a;
                        }

                        // If we have both, stop early
                        if (asin && link) break;
                    }

                    // Extract ASIN from the link if we didn't find data-asin
                    if (link && !asin) {
                        const m = (link.href || '').match(/\\/dp\\/([A-Z0-9]{10})/i);
                        if (m) asin = m[1];
                    }

                    if (!link && !asin) continue;
                    const key = asin || (link ? link.href : '');
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // Extract title from h2 or link text
                    let title = '';
                    if (link) {
                        const h2 = link.querySelector('h2, h2 span');
                        title = h2 ? h2.textContent.trim() : link.textContent.trim();
                    }

                    // Extract price
                    let price = '';
                    if (el) {
                        const priceEl = el.querySelector('span.a-price span.a-offscreen');
                        if (priceEl) price = priceEl.textContent.trim();
                    }

                    // Extract rating
                    let rating = '';
                    if (el) {
                        const ratingEl = el.querySelector('span.a-icon-alt');
                        if (ratingEl) rating = ratingEl.textContent.trim();
                    }

                    results.push({
                        asin: asin,
                        title: title.substring(0, 300),
                        url: link ? link.href : '',
                        price: price,
                        rating: rating,
                        sponsored: true,
                        badge_detected: 'Sponsored (JS-walk)',
                    });
                }
                return results;
            }
        """)
    except Exception:
        return []


def scrape_search_results(page: Page, base_url: str) -> List[Dict[str, Any]]:
    results = []
    seen_asins: set = set()

    # ---- Part A: standard search-result cards ----
    items = page.query_selector_all(
        "div.s-main-slot div[data-component-type='s-search-result'][data-asin]"
    )

    pos = 0
    for item in items:
        pos += 1
        asin = safe_attr(item, "data-asin")
        link_el, href, title = extract_link_and_title(item)
        url = urljoin(base_url, href) if href else ""
        price = extract_price_from_item(card=item, page=page)
        rating = extract_rating_from_item(card=item, page=page)
        sponsored = is_item_sponsored(item, page=page)

        if asin:
            seen_asins.add(asin)

        if asin or url or title:
            results.append({
                "source": "search_results",
                "position_in_search": pos,
                "asin": asin,
                "title": title,
                "url": url,
                "price": price,
                "rating": rating,
                "sponsored": sponsored,
                "badge_detected": "Sponsored" if sponsored else "",
                "link_clickable": bool(link_el)
            })

    # ---- Part B: JS-based walk to catch non-standard sponsored placements ----
    js_sponsored = _find_sponsored_via_js(page)
    for sp in js_sponsored:
        asin = sp.get("asin", "")
        if asin and asin in seen_asins:
            # Already captured in Part A – just make sure it's flagged
            for r in results:
                if r["asin"] == asin:
                    r["sponsored"] = True
                    r["badge_detected"] = r["badge_detected"] or "Sponsored"
            continue
        if asin:
            seen_asins.add(asin)
        pos += 1
        results.append({
            "source": "search_results_inline_ad",
            "position_in_search": pos,
            "asin": asin,
            "title": sp.get("title", ""),
            "url": sp.get("url", ""),
            "price": sp.get("price", ""),
            "rating": sp.get("rating", ""),
            "sponsored": True,
            "badge_detected": sp.get("badge_detected", "Sponsored"),
            "link_clickable": bool(sp.get("url"))
        })

    return results

def click_and_extract_sponsored(
    page: Page,
    context,
    listing_results: List[Dict[str, Any]],
    max_clicks: int = 10,
    simulate_click: bool = False,
    per_click_wait_ms: int = 1200,
    target_brands: List[str] = None,
    target_asin: str = None
) -> List[Dict[str, Any]]:
    """
    For Sponsored items on the listing page, open each product page and extract details.
    """
    clicked_details = []
    clicks = 0

    if target_brands is None:
        target_brands = []

    for rec in listing_results:
        if not rec.get("sponsored"):
            continue
        if not rec.get("url"):
            continue

        # Filter by target ASIN if specified
        if target_asin:
            asin_val = rec.get("asin", "").upper()
            if asin_val != target_asin.upper():
                continue

        if target_brands:
            # Check if any of the target brands exist in the title
            title = rec.get("title", "").lower()
            if not any(brand.lower() in title for brand in target_brands):
                continue

        clicks += 1
        if clicks > max_clicks:
            break

        url = rec["url"]

        # Strategy A: true DOM click, relying on the element (may be brittle)
        if simulate_click and rec.get("link_clickable"):
            try:
                # find the element again via its position to click it
                sel = f"div.s-main-slot div[data-component-type='s-search-result'][data-asin='{rec.get('asin','')}'] h2 a.a-link-normal"
                link = page.query_selector(sel)
                if link:
                    with page.expect_navigation(timeout=60000):
                        link.click()
                    # now extract in the same page, then go back
                    details = extract_product_page_details(page, url)
                    details.update({
                        "source": "sponsored_click",
                        "click_method": "dom_click"
                    })
                    clicked_details.append(details)
                    page.go_back(wait_until="domcontentloaded")
                    page.wait_for_timeout(per_click_wait_ms)
                    continue
            except Exception:
                # Fallback to new-page navigation
                pass

        # Strategy B: open in a new page and extract
        try:
            newp = context.new_page()
            newp.goto(url, wait_until="domcontentloaded", timeout=90000)
            newp.wait_for_timeout(800)
            details = extract_product_page_details(newp, url)
            details.update({
                "source": "sponsored_click",
                "click_method": "new_page_goto"
            })
            clicked_details.append(details)
            newp.close()
            page.wait_for_timeout(per_click_wait_ms)
        except Exception:
            try:
                newp.close()
            except Exception:
                pass

    return clicked_details

def extract_product_page_details(page: Page, base_url: str) -> Dict[str, Any]:
    asin = extract_asin_from_url(base_url) or ""
    title = get_product_title(page)
    price = get_product_price(page)
    rating = get_product_rating(page)

    # occasionally Amazon shows a small "Sponsored" near title on the PDP if reached via ad
    sponsored_hint = ""
    try:
        badge = page.query_selector("span:has-text('Sponsored'), span[aria-label='Sponsored']")
        if badge:
            sponsored_hint = safe_text(badge) or "Sponsored"
    except Exception:
        pass

    return {
        "asin": asin,
        "title": title,
        "url": base_url,
        "price": price,
        "rating": rating,
        "sponsored_hint_on_pdp": sponsored_hint
    }

# --------------------------- Main ---------------------------

def main():
    import sys
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Click Sponsored products on Amazon listing pages and extract details.")
    ap.add_argument("--asin", required=True, help="ASIN for the product page to open first.")
    ap.add_argument("--marketplace", default="amazon.com", help="e.g., amazon.com, amazon.in, amazon.co.uk")
    ap.add_argument("--search", default="", help="Optional search query for the listing page.")
    ap.add_argument("--target-asin", default="", help="Specific ASIN to click when found as sponsored (if not specified, will click all sponsored items).")
    ap.add_argument("--target-brands", default="", help="Comma-separated list of brands to exclusively click on.")
    ap.add_argument("--max-sponsored", type=int, default=10, help="Max sponsored results to click from the listing page.")
    ap.add_argument("--simulate-click", action="store_true", help="Use real DOM click instead of new-page navigation.")
    ap.add_argument("--per-click-wait-ms", type=int, default=1200, help="Wait time after each click/nav.")
    ap.add_argument("--csv", default="", help="Optional CSV output path.")
    ap.add_argument("--headful", action="store_true", help="Run browser in headed mode.")
    ap.add_argument("--slowmo", type=int, default=0, help="Slow motion ms to reduce bot detection.")
    ap.add_argument("--debug-html", default="", help="Save the search-page HTML to this file for debugging selectors.")
    args = ap.parse_args()

    product_url = build_product_url(args.marketplace, args.asin)
    search_url = build_search_url(args.marketplace, args.search) if args.search else ""

    all_rows: List[Dict[str, Any]] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headful, slow_mo=args.slowmo)
        context = browser.new_context(
            viewport={"width": 1400, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        # 1) Product page: capture Sponsored carousels (if any)
        page.goto(product_url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(1200)

        # try accepting cookies
        try:
            cookie_btn = page.query_selector("input#sp-cc-accept, input[name='accept'], span:has-text('Accept Cookies')")
            if cookie_btn:
                cookie_btn.click()
                page.wait_for_timeout(400)
        except Exception:
            pass

        car_results = scrape_product_page_sponsored_carousels(page, product_url)
        all_rows.extend(car_results)

        # 2) Search page: list + click Sponsored
        if search_url:
            page.goto(search_url, wait_until="domcontentloaded", timeout=90000)
            page.wait_for_timeout(2000)

            # Scroll aggressively to trigger lazy-loaded content & sponsored slots
            for _ in range(6):
                page.mouse.wheel(0, 2000)
                time.sleep(0.8)

            # --- Debug: dump page HTML if requested ---
            if args.debug_html:
                html = page.content()
                with open(args.debug_html, "w", encoding="utf-8") as fh:
                    fh.write(html)
                print(f"[DEBUG] Saved search-page HTML to {args.debug_html}")

            # --- Debug: page-level scan for ANY 'Sponsored' text ---
            try:
                sp_info = page.evaluate("""
                    () => {
                        const all = document.querySelectorAll('*');
                        const hits = [];
                        for (const el of all) {
                            if (el.children.length === 0) {
                                const t = (el.textContent || '').trim();
                                if (t === 'Sponsored' || t === 'Ad') {
                                    hits.push({
                                        tag: el.tagName,
                                        classes: el.className,
                                        text: t,
                                        parentClasses: el.parentElement ? el.parentElement.className : '',
                                        asin: (el.closest('[data-asin]') || {}).dataset?.asin || ''
                                    });
                                }
                            }
                        }
                        return hits;
                    }
                """)
                if sp_info:
                    print(f"[DEBUG] Found {len(sp_info)} 'Sponsored' leaf elements on page:")
                    for h in sp_info:
                        print(f"  <{h['tag']} class='{h['classes']}'> text='{h['text']}' asin={h['asin']} parentClass='{h['parentClasses']}'")
                else:
                    print("[DEBUG] No leaf elements with text 'Sponsored' or 'Ad' found on the page.")
            except Exception as e:
                print(f"[DEBUG] JS scan error: {e}")

            listing = scrape_search_results(page, search_url)
            all_rows.extend(listing)

            # click sponsored items and extract PDP details
            target_brands_list = [b.strip() for b in args.target_brands.split(",")] if args.target_brands else []
            clicked = click_and_extract_sponsored(
                page=page,
                context=context,
                listing_results=listing,
                max_clicks=args.max_sponsored,
                simulate_click=args.simulate_click,
                per_click_wait_ms=args.per_click_wait_ms,
                target_brands=target_brands_list,
                target_asin=args.target_asin
            )
            # label them explicitly
            for row in clicked:
                row["sponsored"] = True
            all_rows.extend(clicked)

        browser.close()

    # Summary
    sponsored_count = sum(1 for r in all_rows if r.get("sponsored"))
    total_search = sum(1 for r in all_rows if r.get("source") == "search_results")
    print(f"\n{'='*60}")
    print(f"SUMMARY  keyword: {args.search!r}  |  ASIN: {args.asin}")
    print(f"  Total search results scraped : {total_search}")
    print(f"  Sponsored results detected   : {sponsored_count}")
    print(f"  Non-sponsored results        : {total_search - sponsored_count}")
    if sponsored_count:
        print(f"\n  Sponsored products:")
        for r in all_rows:
            if r.get("sponsored") and r.get("source") == "search_results":
                print(f"    #{r['position_in_search']:>2}  ASIN: {r['asin']}  {r['title'][:70]}")
    print(f"{'='*60}\n")

    # Emit JSON
    print(json.dumps(all_rows, indent=2, ensure_ascii=False))

    # Optional CSV
    if args.csv:
        if pd is None:
            print("\n[WARN] pandas not installed; cannot write CSV. Install with: pip install pandas\n")
        else:
            pd.DataFrame(all_rows).to_csv(args.csv, index=False)
            print(f"\nSaved {len(all_rows)} rows to {args.csv}\n")

if __name__ == "__main__":
    main()