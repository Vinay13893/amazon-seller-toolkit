#!/usr/bin/env python3
"""
Single ASIN Buy Box checker for Sociomonkey integration.

Uses the same Playwright + offer-listing scraping approach as
saas-backend/app/tasks/tools.py (hijack_check) without Celery dependency.

Usage:
    python check_buybox.py --asin B0822GYVNX --marketplace IN

Output (stdout):
    {
      "asin": "B0822GYVNX",
      "marketplace": "IN",
      "buy_box_owner": "Seller Name",
      "buy_box_seller_id": "A1234567890",
      "buy_box_price": 2964.00,
      "buy_box_status": "active",
      "fulfillment_type": "FBA",
      "all_offers": [
        {"seller": "...", "seller_id": "...", "price": "₹2,964", "price_num": 2964.0, "fulfillment": "FBA", "delivery": "..."},
        ...
      ],
      "total_sellers": 3,
      "captcha_seen": false,
      "error": "",
      "checked_at": "2026-05-26T16:30:00+00:00"
    }
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

# ── Constants (same values as saas-backend/app/tasks/tools.py) ─────────────────

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

STEALTH_INIT_SCRIPT = """
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-IN', 'en-US', 'en']});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
"""

OFFERS_URL = {
    "IN": "https://www.amazon.in/gp/offer-listing/{asin}?condition=new",
    "US": "https://www.amazon.com/gp/offer-listing/{asin}?condition=new",
}


# ── Helpers (extracted from saas-backend/app/tasks/tools.py) ───────────────────

def _ns(s):
    return " ".join((s or "").split()).strip()


def _clean_seller(s):
    s = _ns(s)
    s = re.split(r"\s+Seller rating\s+is\s+", s, flags=re.I)[0]
    s = re.split(r"\s+See\s+less\s*$", s, flags=re.I)[0]
    return s.strip(" -|").strip()


def _price_num(p):
    if not p:
        return None
    p = p.replace(",", "").replace("\u20b9", "").replace("$", "").strip()
    try:
        v = float(p)
        # Guard against NaN/inf — not valid JSON
        if v != v or v == float('inf') or v == float('-inf'):
            return None
        return v
    except (ValueError, OverflowError):
        return None


def _extract_delivery(text: str) -> str:
    m = re.search(
        r"(?:Get it|Delivery|Arrives)\s+(?:by\s+)?([A-Z][a-z]+day,?\s+[A-Z][a-z]+\s+\d{1,2}|"
        r"[A-Z][a-z]+\s+\d{1,2}\s*-\s*[A-Z][a-z]+\s+\d{1,2}|[A-Z][a-z]{2}\s+\d{1,2}\s*-\s*\d{1,2})",
        text, re.I,
    )
    if m:
        return m.group(1).strip()
    m = re.search(r"(FREE delivery\s+[A-Z][a-z]+day,?\s+[A-Z][a-z]+\s+\d{1,2})", text, re.I)
    if m:
        return m.group(1).strip()
    return ""


def _extract_offers(html: str) -> list[dict]:
    """Parse all offers from the offer listing page HTML.
    
    Identical logic to _extract_offers() in saas-backend/app/tasks/tools.py.
    """
    soup = BeautifulSoup(html, "lxml")
    blocks = soup.select("div#aod-offer, div.aod-offer") or soup.select("div.olpOffer")
    offers = []
    seen: set = set()
    for b in blocks:
        t = _ns(b.get_text(" ", strip=True))
        if not t:
            continue
        a = b.select_one(
            "a[href*='/sp?seller='], a[href*='/gp/aag/main?seller='], a[href*='seller=']"
        )
        seller = seller_id = ""
        if a:
            seller = _clean_seller(a.get_text(strip=True))
            m = re.search(r"(?:seller=)([A-Z0-9]{8,20})", a.get("href", ""))
            if m:
                seller_id = m.group(1)
        if not seller:
            m = re.search(r"Sold by\s+(.+?)(?:\s+and\s+Fulfilled|\s+Ships|\s*$)", t, re.I)
            if m:
                seller = _clean_seller(m.group(1))
        p = (
            b.select_one("span.a-price span.a-offscreen")
            or b.select_one("span.olpOfferPrice")
        )
        price = _ns(p.get_text(strip=True)) if p else ""
        if not price:
            m = re.search(r"(\u20b9\s?[\d,]+(?:\.\d{1,2})?)", t)
            if m:
                price = m.group(1).replace(" ", "")
        fulf = (
            "FBA"
            if re.search(
                r"Fulfilled by Amazon|Ships from Amazon|Dispatched from and sold by Amazon",
                t, re.I,
            )
            else "FBM"
        )
        delivery = _extract_delivery(t)
        key = (seller_id or seller or "", price, fulf)
        if key in seen or not (seller or price):
            continue
        seen.add(key)
        offers.append(
            dict(
                seller=seller,
                seller_id=seller_id,
                price=price,
                price_num=_price_num(price),
                fulfillment=fulf,
                delivery=delivery,
            )
        )
        if len(offers) >= 30:
            break
    return offers


# ── Main check function ─────────────────────────────────────────────────────────

def run_buybox_check(asin: str, marketplace: str) -> dict:
    """Run Buy Box check using Playwright (same approach as hijack_check in tools.py)."""
    checked_at = datetime.now(timezone.utc).isoformat()

    if marketplace not in OFFERS_URL:
        return {
            "asin": asin, "marketplace": marketplace,
            "buy_box_owner": None, "buy_box_seller_id": None,
            "buy_box_price": None, "buy_box_status": "error",
            "fulfillment_type": None, "all_offers": [], "total_sellers": 0,
            "captcha_seen": False, "error": f"Unsupported marketplace: {marketplace}",
            "checked_at": checked_at,
        }

    offer_url = OFFERS_URL[marketplace].format(asin=asin)
    captcha_seen = False
    offers: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        ctx = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1920, "height": 1080},
            locale="en-IN",
            timezone_id="Asia/Kolkata",
        )
        page = ctx.new_page()
        page.add_init_script(STEALTH_INIT_SCRIPT)

        try:
            print(f"[check_buybox] Navigating to {offer_url}", file=sys.stderr)
            page.goto(offer_url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2.5)
            html = page.content()

            captcha_seen = bool(re.search(r"captcha|robot|automated", html, re.I))
            if captcha_seen:
                print("[check_buybox] CAPTCHA detected — skipping offer parse", file=sys.stderr)
            else:
                offers = _extract_offers(html)
                print(f"[check_buybox] Found {len(offers)} offers", file=sys.stderr)

        except Exception as exc:
            print(f"[check_buybox] Navigation error: {exc}", file=sys.stderr)
            return {
                "asin": asin, "marketplace": marketplace,
                "buy_box_owner": None, "buy_box_seller_id": None,
                "buy_box_price": None, "buy_box_status": "error",
                "fulfillment_type": None, "all_offers": [], "total_sellers": 0,
                "captcha_seen": captcha_seen,
                "error": f"{type(exc).__name__}: {exc}",
                "checked_at": checked_at,
            }
        finally:
            page.close()
            ctx.close()
            browser.close()

    if captcha_seen:
        return {
            "asin": asin, "marketplace": marketplace,
            "buy_box_owner": None, "buy_box_seller_id": None,
            "buy_box_price": None, "buy_box_status": "captcha",
            "fulfillment_type": None, "all_offers": [], "total_sellers": 0,
            "captcha_seen": True, "error": "CAPTCHA detected — Amazon is blocking the request",
            "checked_at": checked_at,
        }

    if not offers:
        return {
            "asin": asin, "marketplace": marketplace,
            "buy_box_owner": None, "buy_box_seller_id": None,
            "buy_box_price": None, "buy_box_status": "no_offers",
            "fulfillment_type": None, "all_offers": [], "total_sellers": 0,
            "captcha_seen": captcha_seen,
            "error": "No offers found on listing page",
            "checked_at": checked_at,
        }

    # First offer in Amazon's offer listing = Buy Box winner
    winner = offers[0]
    return {
        "asin": asin,
        "marketplace": marketplace,
        "buy_box_owner": winner["seller"] or None,
        "buy_box_seller_id": winner["seller_id"] or None,
        "buy_box_price": winner["price_num"],
        "buy_box_status": "active",
        "fulfillment_type": winner["fulfillment"],
        "all_offers": offers,
        "total_sellers": len(offers),
        "captcha_seen": captcha_seen,
        "error": "",
        "checked_at": checked_at,
    }


def main():
    parser = argparse.ArgumentParser(description="Amazon Buy Box checker")
    parser.add_argument("--asin", required=True, help="ASIN to check")
    parser.add_argument(
        "--marketplace", default="IN", choices=list(OFFERS_URL.keys()),
        help="Marketplace code (default: IN)"
    )
    args = parser.parse_args()

    asin = re.sub(r"[^A-Z0-9]", "", args.asin.strip().upper())
    if not asin:
        print(json.dumps({"error": "Invalid ASIN", "asin": args.asin, "marketplace": args.marketplace}))
        sys.exit(1)

    result = run_buybox_check(asin, args.marketplace)
    
    # Windows console encoding fix: ensure UTF-8 for stdout
    if sys.platform == 'win32':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass  # Fallback to ensure_ascii=True below
    
    try:
        print(json.dumps(result, ensure_ascii=False))
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        # Fallback: sanitise floats that aren't JSON-safe + use ASCII encoding
        import math
        def _sanitise(obj):
            if isinstance(obj, float):
                return None if (math.isnan(obj) or math.isinf(obj)) else obj
            if isinstance(obj, dict):
                return {k: _sanitise(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_sanitise(v) for v in obj]
            return obj
        print(json.dumps(_sanitise(result), ensure_ascii=True))  # ASCII-escape Unicode chars
        print(f"[check_buybox] WARNING: had to sanitise output: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
