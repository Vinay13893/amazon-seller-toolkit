#!/usr/bin/env python3
"""
Standalone Amazon ASIN snapshot scraper for e-Solz.

Fetching strategy mirrors saas-backend/app/tasks/bsr.py:
  1. Fast path: plain HTTPS request (requests library)
  2. Slow-path fallback: headless Playwright if CAPTCHA / blocked

Extracts: BSR, price, rating, review_count, buy_box_owner, availability.

Usage:
    python scrape_bsr.py --asin B09XXXXX --marketplace IN

Outputs JSON to stdout:
    {
      "asin": "B09XXXXX",
      "marketplace": "IN",
      "bsr": 13170,
      "bsr_category": "Home & Kitchen",
      "price": 499.0,
      "rating": 4.2,
      "review_count": 1234,
      "buy_box_owner": "Seller Name",
      "buy_box_status": "won|lost|suppressed|unknown",
      "availability_score": 80,
      "checked_at": "2026-05-26T12:00:00+00:00",
      "scrape_status": "OK"
    }
"""
import argparse
import json
import re
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Optional, Tuple

import requests
from bs4 import BeautifulSoup

# ── Marketplace URL map (same as saas-backend) ──────────────────────────────
BASE_URL = {
    "IN": "https://www.amazon.in/dp/{asin}",
    "US": "https://www.amazon.com/dp/{asin}",
    "UK": "https://www.amazon.co.uk/dp/{asin}",
    "DE": "https://www.amazon.de/dp/{asin}",
}

# ── Rotating UA list (same as saas-backend/tasks/bsr.py) ────────────────────
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
]
_ua_idx = 0
_ua_lock = threading.Lock()


def _next_ua() -> str:
    global _ua_idx
    with _ua_lock:
        ua = _USER_AGENTS[_ua_idx % len(_USER_AGENTS)]
        _ua_idx += 1
    return ua


# ── Fetch helpers (mirrors saas-backend/tasks/bsr.py) ───────────────────────

def _fetch_requests(url: str) -> Tuple[int, str]:
    """Fast path — plain HTTPS request, ~1–3 s per ASIN."""
    s = requests.Session()
    s.headers.update({
        "User-Agent":              _next_ua(),
        "Accept":                  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language":         "en-IN,en;q=0.9",
        "Accept-Encoding":         "gzip, deflate, br",
        "Connection":              "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "DNT":                     "1",
    })
    resp = s.get(url, timeout=15, allow_redirects=True)
    return resp.status_code, resp.text


def _fetch_playwright(url: str) -> Tuple[int, str]:
    """Slow-path fallback — headless Chromium with stealth mode."""
    from playwright.sync_api import sync_playwright
    ua = _next_ua()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        ctx = browser.new_context(
            user_agent=ua,
            viewport={"width": 1366, "height": 768},
            locale="en-IN",
            timezone_id="Asia/Kolkata",
        )
        page = ctx.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            status = resp.status if resp else 0
            time.sleep(1.5)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
            time.sleep(1.0)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1.0)
            html = page.content()
        finally:
            page.close()
            browser.close()
    return status, html


# ── Field extractors ─────────────────────────────────────────────────────────

def _extract_bsr(soup: BeautifulSoup) -> Tuple[Optional[int], Optional[str]]:
    """Extract primary BSR and category (same regex as saas-backend)."""
    text = soup.get_text("\n", strip=True)
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]+)", text)
    print(f"[scrape_bsr] BSR regex matches: {matches}", file=sys.stderr)
    if not matches:
        print(f"[scrape_bsr] No BSR found in page", file=sys.stderr)
        return None, None
    ranks = []
    for rank_raw, cat_raw in matches:
        num = rank_raw.replace(",", "").strip()
        cat = re.sub(r"\s+See Top.*$", "", cat_raw.strip(), flags=re.IGNORECASE).strip()
        cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
        if num.isdigit():
            ranks.append((int(num), cat))
            print(f"[scrape_bsr] parsed rank: {int(num)} in {cat}", file=sys.stderr)
    if not ranks:
        print(f"[scrape_bsr] No valid ranks found after parsing", file=sys.stderr)
        return None, None
    print(f"[scrape_bsr] using first rank: {ranks[0]}", file=sys.stderr)
    return ranks[0]


def _extract_price(soup: BeautifulSoup) -> Optional[float]:
    for sel in [
        "span.a-price span.a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "span#price_inside_buybox",
        ".a-price .a-offscreen",
    ]:
        el = soup.select_one(sel)
        if el:
            cleaned = re.sub(r"[₹$£€,\s]", "", el.get_text(strip=True))
            try:
                return float(cleaned)
            except ValueError:
                continue
    return None


def _extract_rating(soup: BeautifulSoup) -> Optional[float]:
    for sel in [
        "span[data-hook='rating-out-of-text']",
        "#acrPopover span.a-size-base",
        "span.a-icon-alt",
        "#averageCustomerReviews_feature_div span.a-size-base",
    ]:
        el = soup.select_one(sel)
        if el:
            m = re.search(r"([\d.]+)\s+out\s+of", el.get_text(strip=True))
            if m:
                try:
                    return float(m.group(1))
                except ValueError:
                    continue
    return None


def _extract_review_count(soup: BeautifulSoup) -> Optional[int]:
    for sel in [
        "#acrCustomerReviewText",
        "span[data-hook='total-review-count']",
    ]:
        el = soup.select_one(sel)
        if el:
            m = re.search(r"([\d,]+)", el.get_text(strip=True))
            if m:
                try:
                    return int(m.group(1).replace(",", ""))
                except ValueError:
                    continue
    return None


def _extract_buy_box(soup: BeautifulSoup) -> Tuple[Optional[str], str]:
    """
    Returns (seller_name, status).
    status: 'suppressed' | 'lost' | 'unknown'
    (We can't determine 'won' without knowing the user's own seller ID.)
    """
    # Check suppressed / unavailable first
    avail_el = soup.select_one("#availability span")
    if avail_el:
        avail_text = avail_el.get_text(strip=True).lower()
        if "currently unavailable" in avail_text or "out of stock" in avail_text:
            return None, "suppressed"

    # Try to get Buy Box seller name
    for sel in [
        "#sellerProfileTriggerId",
        "#merchant-info a",
        "#tabular-buybox-text a[href*='seller=']",
        "#exports_desktop_qualifiedBuybox_tlc_feature_div a[href*='seller=']",
    ]:
        el = soup.select_one(sel)
        if el:
            name = el.get_text(strip=True)[:100]
            if name:
                return name, "lost"

    # Amazon fulfilment?
    merchant_el = soup.select_one("#merchant-info")
    if merchant_el:
        mt = merchant_el.get_text(strip=True)
        if re.search(r"Ships from Amazon|Dispatched from and Sold by Amazon|Sold by Amazon", mt, re.I):
            return "Amazon", "lost"

    return None, "unknown"


def _extract_availability_score(soup: BeautifulSoup) -> Optional[int]:
    avail_el = soup.select_one("#availability span")
    if avail_el:
        text = avail_el.get_text(strip=True).lower()
        if "in stock" in text or "available" in text:
            return 90
        only_m = re.search(r"only (\d+) left", text)
        if only_m:
            return max(20, min(60, int(only_m.group(1)) * 10))
        if "currently unavailable" in text or "out of stock" in text:
            return 0
    # Fallback: add-to-cart button implies available
    if soup.select_one("#add-to-cart-button"):
        return 75
    if soup.select_one("#buy-now-button"):
        return 80
    return None


# ── Main scrape function ─────────────────────────────────────────────────────

def scrape(asin: str, marketplace: str) -> dict:
    url = BASE_URL.get(marketplace, BASE_URL["IN"]).format(asin=asin)

    # Fast path
    html = ""
    http_status = 0
    try:
        http_status, html = _fetch_requests(url)
    except Exception as exc:
        print(f"[scrape_bsr] requests failed: {exc}", file=sys.stderr)

    captcha = bool(html and "captcha" in html.lower() and "Type the characters" in html)
    # Real Amazon product pages are >200 KB; stubs / login-walls are <50 KB
    blocked = http_status not in (200,) or (http_status == 200 and len(html) < 50_000)

    # Slow-path fallback
    if captcha or blocked or not html:
        print(
            f"[scrape_bsr] falling back to Playwright (captcha={captcha} blocked={blocked})",
            file=sys.stderr,
        )
        try:
            http_status, html = _fetch_playwright(url)
        except Exception as exc:
            return _empty(asin, marketplace, f"PLAYWRIGHT_FAIL:{type(exc).__name__}")

    if http_status != 200:
        return _empty(asin, marketplace, f"HTTP_{http_status}")

    soup = BeautifulSoup(html, "lxml")

    captcha_final = bool("captcha" in html.lower() and "Type the characters" in html)
    if captcha_final:
        return _empty(asin, marketplace, "CAPTCHA")

    bsr, bsr_cat         = _extract_bsr(soup)
    price                = _extract_price(soup)
    rating               = _extract_rating(soup)
    review_count         = _extract_review_count(soup)
    buy_box_owner, bb_st = _extract_buy_box(soup)
    availability_score   = _extract_availability_score(soup)

    # If BSR not found in static HTML but page otherwise loaded fine (price/rating present),
    # retry with Playwright — BSR block is sometimes JS-rendered.
    if bsr is None and (price is not None or rating is not None) and not captcha and not blocked:
        print(
            f"[scrape_bsr] BSR null but page OK (price={price}), retrying with Playwright",
            file=sys.stderr,
        )
        try:
            _, html2 = _fetch_playwright(url)
            soup2 = BeautifulSoup(html2, "lxml")
            bsr2, bsr_cat2 = _extract_bsr(soup2)
            if bsr2 is not None:
                print(f"[scrape_bsr] Playwright retry found BSR={bsr2}", file=sys.stderr)
                bsr, bsr_cat = bsr2, bsr_cat2
            else:
                print(f"[scrape_bsr] Playwright retry also returned null BSR", file=sys.stderr)
        except Exception as exc:
            print(f"[scrape_bsr] Playwright retry failed: {exc}", file=sys.stderr)

    status = "OK" if bsr is not None else "PARSE_FAIL"
    
    print(f"[scrape_bsr] final extract: bsr={bsr} price={price} rating={rating} reviews={review_count} status={status}", file=sys.stderr)

    return {
        "asin":               asin,
        "marketplace":        marketplace,
        "bsr":                bsr,
        "bsr_category":       bsr_cat,
        "price":              price,
        "rating":             rating,
        "review_count":       review_count,
        "buy_box_owner":      buy_box_owner,
        "buy_box_status":     bb_st,
        "availability_score": availability_score,
        "checked_at":         datetime.now(timezone.utc).isoformat(),
        "scrape_status":      status,
    }


def _empty(asin: str, marketplace: str, status: str) -> dict:
    return {
        "asin": asin, "marketplace": marketplace,
        "bsr": None, "bsr_category": None, "price": None, "rating": None,
        "review_count": None, "buy_box_owner": None, "buy_box_status": "unknown",
        "availability_score": None,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "scrape_status": status,
    }


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Amazon ASIN snapshot scraper")
    parser.add_argument("--asin",        required=True,  help="Amazon ASIN (10 chars)")
    parser.add_argument("--marketplace", default="IN",   help="IN / US / UK / DE")
    args = parser.parse_args()

    result = scrape(args.asin.strip().upper(), args.marketplace.strip().upper())
    print(json.dumps(result))
