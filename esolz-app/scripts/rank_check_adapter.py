#!/usr/bin/env python3
"""
rank_check_adapter.py

CLI adapter that wraps the core keyword rank-checking logic from
amazon-rank-tracker/rank_tracker_single.py for use as a child process.

Reuses the same scan algorithm (extract ASINs from search-result HTML,
detect sponsored placement near ASIN) — no new scraping logic.

Usage:
    python rank_check_adapter.py \
        --keyword "pure desi ghee 500ml" \
        --asin B0BN5NZCGH \
        --marketplace IN \
        [--pages 7]

Stdout: one JSON line
    {
      "keyword":       "pure desi ghee 500ml",
      "asin":          "B0BN5NZCGH",
      "organic_rank":  5,
      "page_number":   1,
      "pos_on_page":   5,
      "is_sponsored":  false,
      "sponsored_rank": null,
      "page_status":   "page_1",
      "scan_status":   "ok",
      "checked_at":    "2026-05-26T10:00:00+00:00"
    }
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote_plus

try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

# ─── Marketplace domain map ───────────────────────────────────────────────────

MARKETPLACE_DOMAINS: dict[str, str] = {
    'IN': 'www.amazon.in',
    'US': 'www.amazon.com',
    'UK': 'www.amazon.co.uk',
    'DE': 'www.amazon.de',
    'CA': 'www.amazon.ca',
    'AE': 'www.amazon.ae',
    'AU': 'www.amazon.com.au',
    'JP': 'www.amazon.co.jp',
}

SLEEP_BETWEEN_PAGES: float = 1.2
HEADLESS: bool = True


# ─── Core helpers (verbatim logic from rank_tracker_single.py) ────────────────

def build_search_url(domain: str, keyword: str, page_num: int) -> str:
    q = quote_plus(keyword.strip())
    if page_num <= 1:
        return f"https://{domain}/s?k={q}"
    return f"https://{domain}/s?k={q}&page={page_num}"


def extract_asins_from_html(html: str) -> list[str]:
    """Preserve order of first occurrence of each ASIN on the page."""
    asins: list[str] = []
    for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
        a = m.group(1).upper()
        if a and a not in asins:
            asins.append(a)
    return asins


def detect_sponsored_near_asin(html: str, asin: str) -> bool:
    """Best-effort: checks if 'Sponsored' appears near the ASIN block."""
    asin = asin.upper()
    idx = html.upper().find(f'DATA-ASIN="{asin}"')
    if idx == -1:
        return False
    window = html[max(0, idx - 2000): idx + 4000].lower()
    return 'sponsored' in window


def page_status(page_num: int, found: bool) -> str:
    if not found:
        return 'not_ranking'
    if page_num == 1:
        return 'page_1'
    if page_num == 2:
        return 'page_2'
    if page_num == 3:
        return 'page_3'
    return 'not_ranking'   # pages 4+ are effectively not ranking


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Amazon keyword rank adapter')
    parser.add_argument('--keyword',     required=True,       help='Keyword to search')
    parser.add_argument('--asin',        required=True,       help='ASIN to locate')
    parser.add_argument('--marketplace', default='IN',        help='Marketplace code (IN/US/UK/…)')
    parser.add_argument('--pages',       type=int, default=7, help='Max search result pages to scan')
    args = parser.parse_args()

    asin        = args.asin.strip().upper()
    keyword     = args.keyword.strip()
    marketplace = args.marketplace.strip().upper()
    domain      = MARKETPLACE_DOMAINS.get(marketplace, 'www.amazon.in')

    result: dict = {
        'keyword':        keyword,
        'asin':           asin,
        'organic_rank':   None,
        'page_number':    None,
        'pos_on_page':    None,
        'is_sponsored':   False,
        'sponsored_rank': None,
        'page_status':    'not_ranking',
        'scan_status':    'ok',
        'checked_at':     datetime.now(timezone.utc).isoformat(),
    }

    try:
        from playwright.sync_api import sync_playwright   # type: ignore

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=HEADLESS)
            pg      = browser.new_page()

            organic_counter  = 0
            sponsored_counter = 0

            for pnum in range(1, args.pages + 1):
                url = build_search_url(domain, keyword, pnum)
                try:
                    pg.goto(url, wait_until='domcontentloaded', timeout=60_000)
                    time.sleep(SLEEP_BETWEEN_PAGES)
                    html = pg.content()
                except Exception as e:
                    result['scan_status'] = f'page_error:{type(e).__name__}'
                    break

                asins_on_page = extract_asins_from_html(html)

                for pos_idx, found_asin in enumerate(asins_on_page):
                    is_sp = detect_sponsored_near_asin(html, found_asin)
                    if is_sp:
                        sponsored_counter += 1
                        if found_asin == asin and result['sponsored_rank'] is None:
                            result['sponsored_rank'] = sponsored_counter
                    else:
                        organic_counter += 1
                        if found_asin == asin and result['organic_rank'] is None:
                            result['organic_rank']  = organic_counter
                            result['page_number']   = pnum
                            result['pos_on_page']   = pos_idx + 1
                            result['is_sponsored']  = False
                            result['page_status']   = page_status(pnum, True)

                # Stop early once organic rank is found (sponsored may still be on earlier pages)
                if result['organic_rank'] is not None:
                    break

            browser.close()

    except Exception as e:
        result['scan_status'] = f'error:{type(e).__name__}:{str(e)[:200]}'

    try:
        print(json.dumps(result, ensure_ascii=False))
    except UnicodeEncodeError:
        print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
