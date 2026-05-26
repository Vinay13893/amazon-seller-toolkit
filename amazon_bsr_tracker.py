import csv
import re
import sys
from datetime import datetime, timezone
from typing import Optional, Tuple, List

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, Browser


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

# Change marketplace here if needed
MARKETPLACE = "IN"  # IN / US / etc.
BASE_URL = {
    "IN": "https://www.amazon.in/dp/{asin}",
    "US": "https://www.amazon.com/dp/{asin}",
}

# Module-level browser instance (reused across calls)
_playwright = None
_browser: Browser | None = None


def get_browser() -> Browser:
    """Return a shared Chromium browser instance."""
    global _playwright, _browser
    if _browser is None or not _browser.is_connected():
        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch(headless=True)
    return _browser


def fetch_html(url: str, timeout: int = 30) -> Tuple[int, str]:
    """Fetch a page with a headless browser so JS-rendered content loads."""
    browser = get_browser()
    page = browser.new_page(user_agent=USER_AGENT)
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
        status = resp.status if resp else 0
        # Scroll to trigger lazy-loaded product details
        page.wait_for_timeout(2000)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        page.wait_for_timeout(1500)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1500)
        html = page.content()
    finally:
        page.close()
    return status, html


def extract_bsr(html: str) -> Tuple[Optional[int], Optional[str], Optional[str], str]:
    """
    Extract multiple Best Sellers Rank entries.

    Returns:
      bsr_main (int|None),
      bsr_main_category (str|None),
      bsr_all (str|None)  -> "13170|Home & Kitchen;631|Small Kitchen Appliances"
      status (str)        -> OK_MULTI / CAPTCHA / NOT_FOUND / PARSE_FAIL
    """
    # Quick CAPTCHA detection
    if "captcha" in html.lower() and "Type the characters you see" in html:
        return None, None, None, "CAPTCHA"

    soup = BeautifulSoup(html, "lxml")

    # Use newline-separated text to help parsing across sections
    text = soup.get_text("\n", strip=True)

    # Capture all occurrences like: "#13,170 in Home & Kitchen"
    # This will also capture subcategory ranks like "#631 in Small Kitchen Appliances"
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]+)", text)

    if not matches:
        # If page is not a product page
        if "Sorry! We couldn't find that page" in html or "Page Not Found" in html:
            return None, None, None, "NOT_FOUND"
        return None, None, None, "PARSE_FAIL"

    ranks: List[Tuple[int, str]] = []
    for rank_raw, cat_raw in matches:
        rank_num = rank_raw.replace(",", "").strip()
        cat = cat_raw.strip()

        # Remove trailing fragments that sometimes appear
        cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
        cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()

        if rank_num.isdigit():
            ranks.append((int(rank_num), cat))

    if not ranks:
        return None, None, None, "PARSE_FAIL"

    # Usually the first is the main category rank
    bsr_main, bsr_main_cat = ranks[0]

    # Store all ranks compactly for CSV
    bsr_all = ";".join([f"{r}|{c}" for r, c in ranks])

    return bsr_main, bsr_main_cat, bsr_all, "OK_MULTI"


def append_csv(path: str, rows: List[List[str]]) -> None:
    file_exists = False
    try:
        with open(path, "r", encoding="utf-8") as _:
            file_exists = True
    except FileNotFoundError:
        file_exists = False

    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if not file_exists:
            w.writerow(
                [
                    "date_utc",
                    "asin",
                    "marketplace",
                    "bsr_main",
                    "bsr_main_category",
                    "bsr_all",
                    "url",
                    "status",
                ]
            )
        for row in rows:
            w.writerow(row)


def main(asins: List[str], out_csv: str = "bsr_history.csv") -> None:
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows: List[List[str]] = []
    for asin in asins:
        asin = asin.strip().upper()
        if not asin:
            continue

        url = BASE_URL[MARKETPLACE].format(asin=asin)
        try:
            status_code, html = fetch_html(url)
        except Exception as e:
            rows.append([now_utc, asin, MARKETPLACE, "", "", "", url, f"REQUEST_FAIL:{type(e).__name__}"])
            continue

        if status_code != 200:
            rows.append([now_utc, asin, MARKETPLACE, "", "", "", url, f"HTTP_{status_code}"])
            continue

        bsr_main, bsr_main_cat, bsr_all, status = extract_bsr(html)
        rows.append(
            [
                now_utc,
                asin,
                MARKETPLACE,
                str(bsr_main or ""),
                bsr_main_cat or "",
                bsr_all or "",
                url,
                status,
            ]
        )

    append_csv(out_csv, rows)
    print(f"Saved {len(rows)} rows to {out_csv}")


if __name__ == "__main__":
    # Usage:
    # python amazon_bsr_tracker.py B0XXXXXXX B0YYYYYYY
    if len(sys.argv) < 2:
        print("Usage: python amazon_bsr_tracker.py <ASIN1> <ASIN2> ...")
        sys.exit(1)

    main(sys.argv[1:])
