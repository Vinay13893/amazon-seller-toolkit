"""
SERP Competitor Audit — Who is winning each category on Amazon.in?
===================================================================
For each category and its key keywords:
  - Scrapes Amazon.in search results (3 pages)
  - Identifies EVERY sponsored product and their placement position
  - Identifies organic top-10 products
  - Marks OUR ASINs vs competitors
  - Extracts: price, rating, review count, "bought last month", BSR

Outputs:
  - competitor_intel/output/serp_detail_YYYY-MM-DD.csv   (every product × keyword)
  - competitor_intel/output/serp_summary_YYYY-MM-DD.csv  (competitor dominance summary)
  - Prints a human-readable report to console

Run:
    cd e:\\amazon-bsr-tracker\\amazon-pincode-checker
    & amazon_ads_tool\.venv\Scripts\Activate.ps1
    python competitor_intel/serp_audit.py

    # To audit specific categories only:
    python competitor_intel/serp_audit.py ASM Storage
"""

import csv
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from urllib.parse import urljoin, quote_plus

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

sys.path.insert(0, PARENT_DIR)
from competitor_intel.keywords_config import CATEGORY_KEYWORDS

TODAY = datetime.now().strftime("%Y-%m-%d")
DETAIL_CSV = os.path.join(OUTPUT_DIR, f"serp_detail_{TODAY}.csv")
SUMMARY_CSV = os.path.join(OUTPUT_DIR, f"serp_summary_{TODAY}.csv")

BASE_URL = "https://www.amazon.in"
PROFILE_DIR = os.path.join(PARENT_DIR, "amazon_search_profile")
HEADLESS = False
SCAN_PAGES = 3         # pages per keyword
DELAY_PAGE = 2.0       # seconds between pages
DELAY_KEYWORD = 3.0    # seconds between keywords


# ── Utility ─────────────────────────────────────────────────────────────────

def clean(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def safe_text(loc, timeout=1500):
    try:
        if loc.count() > 0:
            return clean(loc.first.inner_text(timeout=timeout))
    except Exception:
        pass
    return ""


def safe_attr(loc, attr, timeout=1500):
    try:
        if loc.count() > 0:
            return (loc.first.get_attribute(attr, timeout=timeout) or "").strip()
    except Exception:
        pass
    return ""


def is_blocked(page):
    try:
        title = page.title().lower()
        body = clean(page.locator("body").inner_text(timeout=2000)).lower()
    except Exception:
        return False
    return any(x in title or x in body for x in ["robot", "captcha", "service unavailable", "oops!", "traffic is piling"])


def build_search_url(keyword, page_num):
    q = quote_plus(keyword.strip())
    if page_num <= 1:
        return f"{BASE_URL}/s?k={q}"
    return f"{BASE_URL}/s?k={q}&page={page_num}"


def parse_bought(text):
    """Extract 'bought last month' count from text."""
    m = re.search(r"([\d,KkMm+]+)\+?\s*bought", text, re.IGNORECASE)
    if m:
        raw = m.group(1).replace(",", "").replace("+", "")
        raw = raw.upper()
        if "K" in raw:
            return int(float(raw.replace("K", "")) * 1000)
        if "M" in raw:
            return int(float(raw.replace("M", "")) * 1_000_000)
        try:
            return int(raw)
        except ValueError:
            pass
    return 0


# ── Core SERP scraper ────────────────────────────────────────────────────────

def scrape_serp_page(page, keyword, page_num, our_asins):
    """
    Scrape a single SERP page. Returns list of dicts.
    Each dict has: keyword, page_num, position_on_page, global_position,
    asin, title, brand, price, rating, review_count, bought_last_month,
    is_sponsored, is_ours, sponsored_slot (1-4 for above-fold banner)
    """
    url = build_search_url(keyword, page_num)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=25000)
        time.sleep(1.5)
    except Exception as e:
        print(f"    ⚠ Could not load page {page_num}: {e}")
        return []

    if is_blocked(page):
        print(f"    🚫 Blocked on page {page_num}, pausing 15s...")
        time.sleep(15)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
        except Exception:
            return []

    results = []
    # Amazon SERP result cards
    cards = page.locator("div[data-component-type='s-search-result']")
    count = cards.count()

    for i in range(count):
        card = cards.nth(i)
        try:
            asin = (card.get_attribute("data-asin", timeout=500) or "").strip().upper()
            if not asin:
                continue

            # Sponsored detection
            sponsored_badge = card.locator("span.s-label-popover-default, .puis-sponsored-label-text, span:has-text('Sponsored')")
            is_sponsored = sponsored_badge.count() > 0

            # Title
            title_loc = card.locator("h2 a span, h2 span")
            title = safe_text(title_loc)

            # Brand
            brand_loc = card.locator("span.a-size-base-plus, .s-line-clamp-1 span")
            brand = ""
            if brand_loc.count() > 0:
                candidate = clean(brand_loc.first.inner_text(timeout=500))
                # filter out "X bought in past month" noise
                if "bought" not in candidate.lower():
                    brand = candidate

            # Price
            price_loc = card.locator(".a-price .a-offscreen")
            price = safe_text(price_loc)

            # Rating
            rating_loc = card.locator("[aria-label*='out of 5 stars']")
            rating = ""
            if rating_loc.count() > 0:
                rating = (rating_loc.first.get_attribute("aria-label", timeout=500) or "").strip()

            # Review count
            review_loc = card.locator(".a-size-base[aria-label], span.a-size-base + span.a-size-base")
            review_count = ""
            if review_loc.count() > 0:
                rc_text = clean(review_loc.first.inner_text(timeout=500))
                if re.search(r"[\d,]+", rc_text):
                    review_count = rc_text

            # Bought last month
            bought_loc = card.locator("[aria-label*='bought in past month'], span:has-text('bought in past month')")
            bought_raw = safe_text(bought_loc)
            if not bought_raw:
                # fallback: scan card text for pattern
                try:
                    card_text = card.inner_text(timeout=500)
                    m = re.search(r"([\d,Kk]+\+?\s*bought in past month)", card_text)
                    if m:
                        bought_raw = m.group(1)
                except Exception:
                    pass
            bought_num = parse_bought(bought_raw)

            results.append({
                "asin": asin,
                "title": title[:80],
                "brand": brand[:40],
                "price": price,
                "rating": rating,
                "review_count": review_count,
                "bought_last_month_raw": bought_raw,
                "bought_last_month": bought_num,
                "is_sponsored": is_sponsored,
                "is_ours": asin in our_asins,
            })
        except Exception:
            continue

    return results


# ── Main ─────────────────────────────────────────────────────────────────────

def run_category(playwright, category_key, cat_config):
    our_asins = set(cat_config["our_asins"])
    keywords = cat_config["keywords"]

    browser = playwright.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=HEADLESS,
        args=["--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 800},
    )
    page = browser.pages[0] if browser.pages else browser.new_page()

    all_rows = []      # raw detail rows
    keyword_summaries = []

    for kw_idx, keyword in enumerate(keywords, 1):
        print(f"\n  [{kw_idx}/{len(keywords)}] '{keyword}'")
        kw_results = []

        for pg in range(1, SCAN_PAGES + 1):
            items = scrape_serp_page(page, keyword, pg, our_asins)
            # Assign positions
            base_pos = (pg - 1) * 48  # ~48 results per page
            for j, item in enumerate(items):
                item["keyword"] = keyword
                item["page_num"] = pg
                item["position_on_page"] = j + 1
                item["global_position"] = base_pos + j + 1
                item["category"] = category_key
            kw_results.extend(items)
            print(f"    page {pg}: {len(items)} products")
            if pg < SCAN_PAGES:
                time.sleep(DELAY_PAGE)

        all_rows.extend(kw_results)

        # Keyword summary
        sponsored = [r for r in kw_results if r["is_sponsored"]]
        organic = [r for r in kw_results if not r["is_sponsored"]]
        our_sponsored = [r for r in sponsored if r["is_ours"]]
        our_organic = [r for r in organic if r["is_ours"]]

        top5_sponsored_asins = [r["asin"] for r in sorted(sponsored, key=lambda x: x["global_position"])[:5]]
        top10_organic_asins = [r["asin"] for r in sorted(organic, key=lambda x: x["global_position"])[:10]]

        our_best_sponsored_pos = min((r["global_position"] for r in our_sponsored), default=None)
        our_best_organic_pos = min((r["global_position"] for r in our_organic), default=None)

        # Top competitor bought counts
        top_bought = sorted(
            [(r["asin"], r["bought_last_month"], r.get("brand",""), r.get("title","")[:40])
             for r in kw_results if not r["is_ours"] and r["bought_last_month"] > 0],
            key=lambda x: -x[1]
        )[:3]

        flag = ""
        if our_best_sponsored_pos is None and our_best_organic_pos is None:
            flag = "🚨 NOT VISIBLE"
        elif our_best_sponsored_pos and our_best_sponsored_pos <= 6:
            flag = "✅ GOOD sponsored pos"
        elif our_best_organic_pos and our_best_organic_pos <= 10:
            flag = "✅ GOOD organic pos"
        else:
            flag = "⚠️ LOW visibility"

        print(f"    → Sponsored: {len(sponsored)} total | Our pos: {our_best_sponsored_pos or 'N/A'} | "
              f"Organic: {len(organic)} | Our pos: {our_best_organic_pos or 'N/A'}  {flag}")
        if top_bought:
            for asin, bought, brand, title in top_bought:
                print(f"      🏆 Competitor {asin} ({brand or title}): {bought:,}/mo bought")

        keyword_summaries.append({
            "category": category_key,
            "keyword": keyword,
            "total_results": len(kw_results),
            "sponsored_count": len(sponsored),
            "organic_count": len(organic),
            "our_sponsored_pos": our_best_sponsored_pos,
            "our_organic_pos": our_best_organic_pos,
            "our_visibility": flag,
            "top5_sponsored": ",".join(top5_sponsored_asins),
            "top10_organic": ",".join(top10_organic_asins),
            "top_competitor_asin": top_bought[0][0] if top_bought else "",
            "top_competitor_bought": top_bought[0][1] if top_bought else 0,
            "top_competitor_brand": top_bought[0][2] if top_bought else "",
        })

        time.sleep(DELAY_KEYWORD)

    browser.close()
    return all_rows, keyword_summaries


def build_competitor_summary(all_rows, our_asins_all):
    """Aggregate competitor ASIN appearances and bought counts."""
    competitor_data = defaultdict(lambda: {
        "appearances": 0, "sponsored_appearances": 0, "organic_appearances": 0,
        "bought_last_month": 0, "brand": "", "title": "", "price": "",
        "rating": "", "review_count": "", "categories": set(), "keywords": set(),
    })

    for row in all_rows:
        asin = row["asin"]
        if asin in our_asins_all:
            continue
        cd = competitor_data[asin]
        cd["appearances"] += 1
        if row["is_sponsored"]:
            cd["sponsored_appearances"] += 1
        else:
            cd["organic_appearances"] += 1
        if row["bought_last_month"] > cd["bought_last_month"]:
            cd["bought_last_month"] = row["bought_last_month"]
        if row.get("brand") and not cd["brand"]:
            cd["brand"] = row["brand"]
        if row.get("title") and not cd["title"]:
            cd["title"] = row["title"]
        if row.get("price") and not cd["price"]:
            cd["price"] = row["price"]
        if row.get("rating") and not cd["rating"]:
            cd["rating"] = row["rating"]
        cd["categories"].add(row["category"])
        cd["keywords"].add(row["keyword"])

    # Convert sets to strings for CSV
    result = []
    for asin, cd in competitor_data.items():
        cd["categories"] = "|".join(sorted(cd["categories"]))
        cd["keywords"] = "|".join(sorted(cd["keywords"]))
        result.append({"asin": asin, **cd})

    return sorted(result, key=lambda x: -x["bought_last_month"])


def main():
    # Determine which categories to run (case-insensitive match)
    _upper_map = {k.upper(): k for k in CATEGORY_KEYWORDS}
    if len(sys.argv) > 1:
        categories_to_run = [_upper_map[c.upper()] for c in sys.argv[1:] if c.upper() in _upper_map]
    else:
        categories_to_run = list(CATEGORY_KEYWORDS.keys())
    if not categories_to_run:
        print(f"Unknown category. Valid: {list(CATEGORY_KEYWORDS.keys())}")
        sys.exit(1)

    print("=" * 70)
    print("  EMOUNT VENTURES — SERP COMPETITOR AUDIT")
    print(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} IST")
    print(f"  Categories: {', '.join(categories_to_run)}")
    print(f"  Pages per keyword: {SCAN_PAGES}  |  Browser: {'headless' if HEADLESS else 'visible'}")
    print("=" * 70)

    all_detail_rows = []
    all_summaries = []

    # Collect all our ASINs across selected categories
    our_asins_all = set()
    for cat_key in categories_to_run:
        our_asins_all.update(CATEGORY_KEYWORDS[cat_key]["our_asins"])

    with sync_playwright() as pw:
        for cat_key in categories_to_run:
            cat_config = CATEGORY_KEYWORDS[cat_key]
            print(f"\n{'=' * 70}")
            print(f"  CATEGORY: {cat_config['display_name']}  ({len(cat_config['keywords'])} keywords)")
            print("=" * 70)

            detail_rows, summaries = run_category(pw, cat_key, cat_config)
            all_detail_rows.extend(detail_rows)
            all_summaries.extend(summaries)

    # ── Save detail CSV ──────────────────────────────────────────────────────
    detail_fields = [
        "category", "keyword", "page_num", "position_on_page", "global_position",
        "asin", "title", "brand", "price", "rating", "review_count",
        "bought_last_month", "bought_last_month_raw", "is_sponsored", "is_ours",
    ]
    with open(DETAIL_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=detail_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(all_detail_rows)
    print(f"\n✅ Detail CSV saved: {DETAIL_CSV}")

    # ── Save summary CSV ─────────────────────────────────────────────────────
    summary_fields = [
        "category", "keyword", "total_results", "sponsored_count", "organic_count",
        "our_sponsored_pos", "our_organic_pos", "our_visibility",
        "top5_sponsored", "top10_organic",
        "top_competitor_asin", "top_competitor_bought", "top_competitor_brand",
    ]
    with open(SUMMARY_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=summary_fields)
        writer.writeheader()
        writer.writerows(all_summaries)
    print(f"✅ Summary CSV saved: {SUMMARY_CSV}")

    # ── Competitor dominance report ──────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print("  TOP COMPETITORS ACROSS ALL SCANNED CATEGORIES")
    print(f"{'=' * 70}")
    competitor_report = build_competitor_summary(all_detail_rows, our_asins_all)
    print(f"\n  {'ASIN':<14} {'Brand':<22} {'Appears':>7} {'Spon':>5} {'Organic':>7} {'Bought/mo':>10} {'Price':>8}")
    print(f"  {'-'*14} {'-'*22} {'-'*7} {'-'*5} {'-'*7} {'-'*10} {'-'*8}")
    for comp in competitor_report[:20]:
        print(f"  {comp['asin']:<14} {comp['brand'][:22]:<22} "
              f"{comp['appearances']:>7} {comp['sponsored_appearances']:>5} "
              f"{comp['organic_appearances']:>7} {comp['bought_last_month']:>10,} "
              f"{comp['price']:>8}")

    # Save competitor dominance CSV
    comp_csv = os.path.join(OUTPUT_DIR, f"competitor_dominance_{TODAY}.csv")
    if competitor_report:
        fields = list(competitor_report[0].keys())
        with open(comp_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(competitor_report)
        print(f"\n✅ Competitor dominance CSV saved: {comp_csv}")

    # ── Visibility gap report ────────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print("  OUR VISIBILITY GAPS (keywords where we are NOT visible)")
    print(f"{'=' * 70}")
    not_visible = [s for s in all_summaries if "NOT VISIBLE" in s.get("our_visibility", "")]
    low_vis = [s for s in all_summaries if "LOW" in s.get("our_visibility", "")]

    if not_visible:
        print(f"\n  🚨 {len(not_visible)} keyword(s) with ZERO visibility:")
        for s in not_visible:
            print(f"     [{s['category']}] '{s['keyword']}'  "
                  f"— top competitor: {s['top_competitor_brand']} ({s['top_competitor_bought']:,}/mo)")
    if low_vis:
        print(f"\n  ⚠️  {len(low_vis)} keyword(s) with LOW visibility:")
        for s in low_vis:
            print(f"     [{s['category']}] '{s['keyword']}'  "
                  f"sponsored_pos={s['our_sponsored_pos'] or 'none'}, "
                  f"organic_pos={s['our_organic_pos'] or 'none'}")

    print(f"\n{'=' * 70}")
    print(f"  DONE — {len(all_detail_rows)} total results across {len(all_summaries)} keywords")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
