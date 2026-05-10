import csv
import io
import random
import re
import time
import threading
import queue
from datetime import datetime, timezone
from urllib.parse import quote_plus

from flask import Flask, render_template, request, Response
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

try:
    import openpyxl
except ImportError:
    openpyxl = None

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB upload limit


def parse_upload_file(file_storage):
    """Parse an uploaded CSV or Excel file and return rows as list of lists."""
    if not file_storage or not file_storage.filename:
        return []
    fname = file_storage.filename.lower()
    if fname.endswith(('.xlsx', '.xls')):
        if openpyxl is None:
            return []
        wb = openpyxl.load_workbook(io.BytesIO(file_storage.read()), read_only=True)
        ws = wb.active
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(c).strip() if c is not None else '' for c in row]
            if any(cells):
                rows.append(cells)
        wb.close()
        return rows
    else:  # CSV / TXT
        text = file_storage.read().decode('utf-8-sig', errors='ignore')
        rows = []
        for line in csv.reader(io.StringIO(text)):
            cells = [c.strip() for c in line]
            if any(cells):
                rows.append(cells)
        return rows


def extract_asins_from_upload(rows):
    """Extract ASINs from uploaded rows (first column)."""
    asins = []
    for row in rows:
        val = row[0].upper().strip() if row else ''
        val = re.sub(r'[^A-Z0-9]', '', val)
        if val and len(val) == 10 and val not in asins:
            asins.append(val)
    return asins


def extract_pairs_from_upload(rows):
    """Extract keyword,ASIN pairs from uploaded rows (col1=keyword, col2=ASIN)."""
    pairs = []
    for row in rows:
        if len(row) >= 2 and row[0] and row[1]:
            pairs.append(dict(keyword=row[0].strip(), asin=row[1].strip().upper()))
    return pairs


def extract_hijack_items_from_upload(rows):
    """Extract ASIN[, authorized_seller] from uploaded rows."""
    items = []
    for row in rows:
        asin = row[0].strip().upper() if row else ''
        auth = row[1].strip() if len(row) > 1 else ''
        if asin:
            items.append(dict(asin=asin, authorized_seller=auth))
    return items

# ---------------------------------------------------------------------------
# Playwright runs in its own dedicated thread to avoid greenlet/thread issues.
# All browser work is sent to this thread via a job queue.
# ---------------------------------------------------------------------------
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

_job_queue: queue.Queue = queue.Queue()


STEALTH_INIT_SCRIPT = """
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-IN', 'en-US', 'en']});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
"""


def _playwright_worker():
    """Runs in a dedicated thread — owns the Playwright instance."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        )
        while True:
            func, args, result_q = _job_queue.get()
            if func is None:  # shutdown sentinel
                break
            try:
                result = func(browser, *args)
                result_q.put(("ok", result))
            except Exception as e:
                result_q.put(("err", e))


_worker_thread = threading.Thread(target=_playwright_worker, daemon=True)
_worker_thread.start()


def run_in_browser(func, *args):
    """Submit work to the Playwright thread and wait for the result."""
    result_q: queue.Queue = queue.Queue()
    _job_queue.put((func, args, result_q))
    status, value = result_q.get()
    if status == "err":
        raise value
    return value


# ---------------------------------------------------------------------------
# Marketplace helpers
# ---------------------------------------------------------------------------
MARKETPLACES = ["IN", "US"]
MARKETPLACE_DOMAINS = {"IN": "www.amazon.in", "US": "www.amazon.com"}
BSR_URL = {"IN": "https://www.amazon.in/dp/{asin}", "US": "https://www.amazon.com/dp/{asin}"}
OFFERS_URL = {"IN": "https://www.amazon.in/gp/offer-listing/{asin}?condition=new",
              "US": "https://www.amazon.com/gp/offer-listing/{asin}?condition=new"}


# ===================================================================
# TOOL 1 — BSR LOOKUP
# ===================================================================
def _fetch_bsr_page(browser, url: str) -> tuple[int, str]:
    ctx = browser.new_context(
        user_agent=USER_AGENT,
        viewport={'width': 1920, 'height': 1080},
        locale='en-IN',
        timezone_id='Asia/Kolkata',
    )
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        # Visit homepage first to build session/cookies
        domain = 'www.amazon.in' if 'amazon.in' in url else 'www.amazon.com'
        page.goto(f'https://{domain}', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(1500)
        # Navigate to product page
        resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        status = resp.status if resp else 0
        page.wait_for_timeout(2000)
        # Scroll slowly to trigger lazy-loaded product details
        height = page.evaluate("document.body.scrollHeight")
        for y in range(0, height, 400):
            page.evaluate(f"window.scrollTo(0, {y})")
            page.wait_for_timeout(100)
        page.wait_for_timeout(2000)
        # Scroll back to product details area
        page.evaluate(f"window.scrollTo(0, {int(height * 0.65)})")
        page.wait_for_timeout(1500)
        html = page.content()
    finally:
        page.close()
        ctx.close()
    return status, html


def extract_bsr(html: str):
    if "captcha" in html.lower() and "Type the characters you see" in html:
        return None, None, None, "CAPTCHA"
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=True)
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]+)", text)
    if not matches:
        if "Sorry! We couldn't find that page" in html or "Page Not Found" in html:
            return None, None, None, "NOT_FOUND"
        return None, None, None, "PARSE_FAIL"
    ranks = []
    seen = set()
    for rank_raw, cat_raw in matches:
        rank_num = rank_raw.replace(",", "").strip()
        cat = cat_raw.strip()
        cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
        cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
        if rank_num.isdigit():
            key = (int(rank_num), cat)
            if key not in seen:
                seen.add(key)
                ranks.append(key)
    if not ranks:
        return None, None, None, "PARSE_FAIL"
    bsr_main, bsr_main_cat = ranks[0]
    bsr_all = ";".join(f"{r}|{c}" for r, c in ranks)
    return bsr_main, bsr_main_cat, bsr_all, "OK"


def _lookup_bsr_worker(browser, asins: list[str], marketplace: str) -> list[dict]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    results = []
    for asin in asins:
        asin = asin.strip().upper()
        if not asin:
            continue
        url = BSR_URL[marketplace].format(asin=asin)
        try:
            code, html = _fetch_bsr_page(browser, url)
        except Exception as e:
            results.append(dict(date=now, asin=asin, marketplace=marketplace,
                                bsr_main="", bsr_main_category="", bsr_all="",
                                url=url, status=f"REQUEST_FAIL:{type(e).__name__}"))
            continue
        if code != 200:
            results.append(dict(date=now, asin=asin, marketplace=marketplace,
                                bsr_main="", bsr_main_category="", bsr_all="",
                                url=url, status=f"HTTP_{code}"))
            continue
        bsr_main, bsr_main_cat, bsr_all, status = extract_bsr(html)
        results.append(dict(date=now, asin=asin, marketplace=marketplace,
                            bsr_main=bsr_main or "", bsr_main_category=bsr_main_cat or "",
                            bsr_all=bsr_all or "", url=url, status=status))
    return results


def lookup_bsr(asins, marketplace):
    return run_in_browser(_lookup_bsr_worker, asins, marketplace)


# ===================================================================
# TOOL 2 — KEYWORD RANK TRACKER
# ===================================================================
RANK_SCAN_PAGES = 7


def build_search_url(domain: str, keyword: str, page_num: int) -> str:
    q = quote_plus(keyword.strip())
    if page_num <= 1:
        return f"https://{domain}/s?k={q}"
    return f"https://{domain}/s?k={q}&page={page_num}"


def extract_asins_from_html(html: str) -> list[str]:
    """Extract ASINs from actual search result items only (not carousels/widgets)."""
    soup = BeautifulSoup(html, "lxml")
    asins = []
    for div in soup.select('div[data-component-type="s-search-result"]'):
        a = (div.get("data-asin") or "").upper().strip()
        if a and len(a) == 10 and a not in asins:
            asins.append(a)
    # Fallback to regex if selector finds nothing (different page layout)
    if not asins:
        for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
            a = m.group(1).upper()
            if a and a not in asins:
                asins.append(a)
    return asins


def detect_sponsored(html: str, asin: str) -> bool:
    idx = html.upper().find(f'DATA-ASIN="{asin.upper()}"')
    if idx == -1:
        return False
    window = html[max(0, idx - 2000): idx + 4000].lower()
    return "sponsored" in window


def _track_keyword_ranks_worker(browser, pairs: list[dict], marketplace: str) -> list[dict]:
    domain = MARKETPLACE_DOMAINS[marketplace]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    results = []
    ctx = browser.new_context(
        user_agent=USER_AGENT,
        viewport={'width': 1920, 'height': 1080},
        locale='en-IN',
        timezone_id='Asia/Kolkata',
    )
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        for pair in pairs:
            kw = pair["keyword"].strip()
            asin = re.sub(r"[^A-Z0-9]", "", pair["asin"].strip().upper())
            if not kw or not asin:
                continue
            found_page = ""
            pos = ""
            sponsored = False
            scan_status = "ok"
            for pnum in range(1, RANK_SCAN_PAGES + 1):
                try:
                    url = build_search_url(domain, kw, pnum)
                    page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    time.sleep(1.0)
                    # Scroll down to trigger lazy-loaded search results
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                    time.sleep(0.8)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    time.sleep(0.8)
                    html = page.content()
                    page_asins = extract_asins_from_html(html)
                    if asin in page_asins:
                        found_page = pnum
                        pos = page_asins.index(asin) + 1
                        sponsored = detect_sponsored(html, asin)
                        break
                except Exception as e:
                    scan_status = f"error:{type(e).__name__}"
            results.append(dict(
                tracked_at=now, marketplace=marketplace, keyword=kw, asin=asin,
                scan_status=scan_status, pages_scanned=RANK_SCAN_PAGES,
                found=bool(found_page), page=found_page, position=pos,
                is_sponsored=sponsored,
            ))
    finally:
        page.close()
        ctx.close()
    return results


def track_keyword_ranks(pairs, marketplace):
    return run_in_browser(_track_keyword_ranks_worker, pairs, marketplace)


# ===================================================================
# TOOL 3 — HIJACKER / OFFER CHECKER
# ===================================================================
def ns(s):
    return " ".join((s or "").split()).strip()


def clean_seller(s):
    s = ns(s)
    s = re.split(r"\s+Seller rating\s+is\s+", s, flags=re.I)[0]
    s = re.split(r"\s+See\s+less\s*$", s, flags=re.I)[0]
    return s.strip(" -|").strip()


def price_num(p):
    if not p:
        return ""
    p = p.replace(",", "").replace("\u20b9", "").replace("$", "").strip()
    try:
        return float(p)
    except ValueError:
        return ""


def extract_delivery(block_text: str) -> str:
    """Extract delivery estimate from an offer block's text."""
    # Patterns like "Get it by Wednesday, April 16", "Delivery by Apr 12", "FREE delivery"
    m = re.search(r"(?:Get it|Delivery|Arrives)\s+(?:by\s+)?([A-Z][a-z]+day,?\s+[A-Z][a-z]+\s+\d{1,2}|[A-Z][a-z]+\s+\d{1,2}\s*-\s*[A-Z][a-z]+\s+\d{1,2}|[A-Z][a-z]{2}\s+\d{1,2}\s*-\s*\d{1,2})", block_text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"(FREE delivery\s+[A-Z][a-z]+day,?\s+[A-Z][a-z]+\s+\d{1,2})", block_text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"(Fastest delivery\s+[A-Z][a-z]+day,?\s+[A-Z][a-z]+\s+\d{1,2})", block_text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"(FREE delivery[^.]*?\d{1,2}\s+[A-Z][a-z]+)", block_text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"(delivery.{0,40}?\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*)", block_text, re.I)
    if m:
        return m.group(1).strip()
    return ""


def extract_offers(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    blocks = soup.select("div#aod-offer, div.aod-offer")
    if not blocks:
        blocks = soup.select("div.olpOffer")
    offers = []
    seen = set()
    for b in blocks:
        t = ns(b.get_text(" ", strip=True))
        if not t:
            continue
        a = b.select_one("a[href*='/sp?seller='], a[href*='/gp/aag/main?seller='], a[href*='seller=']")
        seller = seller_id = ""
        if a:
            seller = clean_seller(a.get_text(strip=True))
            href = a.get("href", "") or ""
            m = re.search(r"(?:seller=)([A-Z0-9]{8,20})", href)
            if m:
                seller_id = m.group(1)
        if not seller:
            m = re.search(r"Sold by\s+(.+?)(?:\s+and\s+Fulfilled|\s+Ships|\s*$)", t, re.I)
            if m:
                seller = clean_seller(m.group(1))
        p = b.select_one("span.a-price span.a-offscreen") or b.select_one("span.olpOfferPrice")
        price = ns(p.get_text(strip=True)) if p else ""
        if not price:
            m = re.search(r"(\u20b9\s?[\d,]+(?:\.\d{1,2})?)", t)
            if m:
                price = m.group(1).replace(" ", "")
        fulf = "FBA" if re.search(r"Fulfilled by Amazon|Ships from Amazon|Dispatched from and sold by Amazon", t, re.I) else "FBM"
        delivery = extract_delivery(t)
        key = (seller_id or seller or "", price, fulf)
        if key in seen:
            continue
        seen.add(key)
        if not (seller or price):
            continue
        offers.append(dict(seller=seller, seller_id=seller_id, price=price,
                           price_num=price_num(price), fulfillment=fulf,
                           delivery=delivery))
        if len(offers) >= 30:
            break
    return offers


def _try_continue_shopping(page):
    """Handle Amazon bot-detection 'Continue shopping' redirect."""
    try:
        html = page.content()
        if "Continue shopping" in html or "continue shopping" in html:
            for sel in ["a:has-text('Continue shopping')", "a:has-text('Continue Shopping')",
                        "input[type=submit]", "button:has-text('Continue')"]:
                try:
                    btn = page.locator(sel).first
                    if btn.count() > 0 and btn.is_visible():
                        btn.click(timeout=5000)
                        time.sleep(2.0)
                        return True
                except Exception:
                    continue
    except Exception:
        pass
    return False


def _extract_offers_from_product_page(page, asin: str, marketplace: str) -> list[dict]:
    """Fallback: extract seller info directly from the product page buybox."""
    domain = MARKETPLACE_DOMAINS[marketplace]
    url = f"https://{domain}/dp/{asin}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2.0)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        time.sleep(1.0)
        html = page.content()
        soup = BeautifulSoup(html, "lxml")
        text = soup.get_text(" ", strip=True)

        offers = []
        # Extract from merchant-info / buybox
        seller = ""
        seller_id = ""
        price = ""
        fulf = "FBM"

        # Seller name
        for sel in ["#sellerProfileTriggerId", "#merchant-info a", "#tabular-buybox a[href*='seller=']"]:
            el = soup.select_one(sel)
            if el:
                seller = clean_seller(el.get_text(strip=True))
                href = el.get("href", "")
                m = re.search(r"seller=([A-Z0-9]{8,20})", href)
                if m:
                    seller_id = m.group(1)
                break

        # If no link-based seller, try text
        if not seller:
            m = re.search(r"Sold by\s+(.+?)(?:\s+and\s+Fulfilled|\s+Ships|\.|$)", text, re.I)
            if m:
                seller = clean_seller(m.group(1))

        # Price
        price_el = soup.select_one("span.a-price span.a-offscreen") or soup.select_one("#priceblock_ourprice") or soup.select_one("#price_inside_buybox")
        if price_el:
            price = ns(price_el.get_text(strip=True))

        # Fulfillment
        if re.search(r"Fulfilled by Amazon|Ships from Amazon|Dispatched from and sold by Amazon", text, re.I):
            fulf = "FBA"

        delivery = extract_delivery(text)

        if seller or price:
            offers.append(dict(seller=seller, seller_id=seller_id, price=price,
                               price_num=price_num(price), fulfillment=fulf,
                               delivery=delivery))
        return offers
    except Exception:
        return []


def _check_hijackers_worker(browser, items: list[dict], marketplace: str) -> list[dict]:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    results = []
    ctx = browser.new_context(
        user_agent=USER_AGENT,
        viewport={'width': 1920, 'height': 1080},
        locale='en-IN',
        timezone_id='Asia/Kolkata',
    )
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        for item in items:
            asin = item["asin"].strip().upper()
            auth = clean_seller(item.get("authorized_seller", ""))
            if not asin:
                continue
            offer_url = OFFERS_URL[marketplace].format(asin=asin)
            offers = []
            try:
                page.goto(offer_url, wait_until="domcontentloaded", timeout=30000)
                time.sleep(2.5)
                # Handle bot-detection redirect
                _try_continue_shopping(page)
                time.sleep(1.0)
                html = page.content()
                offers = extract_offers(html)
            except Exception as e:
                results.append(dict(scan_time=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status=f"ERROR:{type(e).__name__}"))
                continue

            # Fallback: if offer-listing page returned nothing, try product page
            if not offers:
                offers = _extract_offers_from_product_page(page, asin, marketplace)
            if not offers:
                results.append(dict(scan_time=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status="NO_OFFERS_FOUND"))
                continue
            auth_lower = auth.lower() if auth else ""
            auth_found = any(o["seller"].lower() == auth_lower for o in offers) if auth_lower else False
            for o in offers:
                if auth and o["seller"] and o["seller"].lower() != auth_lower:
                    st = "UNAUTHORIZED"
                elif auth and not o["seller"]:
                    st = "UNKNOWN_SELLER"
                else:
                    st = "OK"
                results.append(dict(scan_time=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller=o["seller"],
                                    seller_id=o["seller_id"], price=o["price"],
                                    fulfillment=o["fulfillment"], delivery=o.get("delivery", ""),
                                    status=st))
            if auth and not auth_found:
                results.append(dict(scan_time=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status="YOU_NOT_PRESENT"))
    finally:
        page.close()
        ctx.close()
    return results


def check_hijackers(items, marketplace):
    return run_in_browser(_check_hijackers_worker, items, marketplace)


# ===================================================================
# TOOL 4 — PINCODE AVAILABILITY CHECKER  (Amazon.in only)
# ===================================================================
PINCODE_INPUT_SELECTORS = [
    "#GLUXZipUpdateInput",
    "input[aria-label*='pincode' i]",
    "input[placeholder*='PIN' i]",
    "input[placeholder*='pincode' i]",
]

PINCODE_APPLY_SELECTORS = [
    "#GLUXZipUpdate",
    "input.a-button-input[type='submit']",
    "button:has-text('Apply')",
    "button:has-text('Update')",
]

LOCATION_OPEN_SELECTORS = [
    "#glow-ingress-block",
    "#nav-global-location-popover-link",
    "#contextualIngressPtLabel_deliveryShortLine",
    "#contextualIngressPtPin",
    "span:has-text('Deliver to')",
]

DELIVERY_TEXT_SELECTORS = [
    "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
    "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span",
    "#ddmDeliveryMessage",
    "#deliveryBlockMessage",
    "#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE",
    "#delivery-message",
    "[data-cy='delivery-recipe']",
]

UNAVAILABLE_SELECTORS_PIN = [
    "#availability span",
    "#outOfStock span",
    "span.a-color-price:has-text('Currently unavailable')",
    "span:has-text('Currently unavailable')",
]

AMAZON_FULFILLED_SELECTORS = [
    "#merchant-info",
    "#tabular-buybox-text",
    "#usedBuyBox",
    "#exports_desktop_qualifiedBuybox_tlc_feature_div",
    "#shipsFromSoldBy_feature_div",
]

DELIVERY_CLASSIFIERS = [
    (re.compile(r"same[ -]?day|today by|today,", re.I), "same_day"),
    (re.compile(r"one[ -]?day|tomorrow by|tomorrow,|overnight", re.I), "next_day"),
    (re.compile(r"two[ -]?day|day after tomorrow", re.I), "two_day"),
]


def _pin_first_visible(page, selectors, timeout_ms=4000):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for selector in selectors:
            try:
                loc = page.locator(selector).first
                if loc.count() > 0 and loc.is_visible():
                    return loc
            except Exception:
                continue
        time.sleep(0.15)
    return None


def _pin_safe_text(page, selectors):
    texts = []
    for selector in selectors:
        try:
            loc = page.locator(selector)
            count = min(loc.count(), 4)
            for i in range(count):
                txt = (loc.nth(i).inner_text(timeout=1500) or "").strip()
                if txt:
                    texts.append(txt)
        except Exception:
            continue
    joined = " | ".join(dict.fromkeys(texts))
    return re.sub(r"\s+", " ", joined).strip()


def _pin_looks_like_captcha(page):
    try:
        text = page.locator("body").inner_text(timeout=2500)[:5000]
    except Exception:
        return False
    patterns = [
        r"Enter the characters you see below",
        r"Type the characters you see in this image",
        r"Sorry, we just need to make sure you're not a robot",
    ]
    return any(re.search(p, text, re.I) for p in patterns)


def _pin_classify_delivery(delivery_text, buyable):
    if not buyable:
        return "unavailable"
    cleaned = delivery_text.strip()
    if not cleaned:
        return "unknown"
    for pattern, label in DELIVERY_CLASSIFIERS:
        if pattern.search(cleaned):
            return label
    return "other"


def _pin_set_pincode(page, pincode):
    page.goto("https://www.amazon.in", wait_until="domcontentloaded", timeout=60000)
    time.sleep(1.5 + random.random() * 0.5)

    # Try multiple methods to open the location popup
    input_box = None
    js_click_selectors = [
        "#nav-global-location-popover-link",
        "#glow-ingress-block",
        "#contextualIngressPtLabel_deliveryShortLine",
    ]
    for sel in js_click_selectors:
        try:
            el = page.locator(sel)
            if el.count() > 0:
                page.evaluate(f'document.querySelector("{sel}").click()')
                time.sleep(2.0 + random.random() * 0.5)
                input_box = _pin_first_visible(page, PINCODE_INPUT_SELECTORS, timeout_ms=3000)
                if input_box:
                    break
        except Exception:
            continue

    if not input_box:
        # Last resort: try normal click
        loc = _pin_first_visible(page, LOCATION_OPEN_SELECTORS, timeout_ms=4000)
        if loc:
            try:
                loc.click(no_wait_after=True, timeout=3000)
                time.sleep(2.0 + random.random() * 0.5)
            except Exception:
                pass
        input_box = _pin_first_visible(page, PINCODE_INPUT_SELECTORS, timeout_ms=5000)

    if not input_box:
        return False
    try:
        input_box.click(timeout=2000)
        input_box.fill("")
        input_box.type(pincode, delay=80)
    except Exception:
        return False

    apply_btn = _pin_first_visible(page, PINCODE_APPLY_SELECTORS, timeout_ms=5000)
    if not apply_btn:
        return False
    try:
        apply_btn.click(force=True, no_wait_after=True, timeout=3000)
    except Exception:
        return False

    time.sleep(2.0 + random.random() * 1.0)

    # Handle extra continue/done button
    for text in ["Continue", "Done", "Apply", "Confirm"]:
        try:
            btn = page.get_by_role("button", name=re.compile(text, re.I)).first
            if btn.count() > 0 and btn.is_visible():
                btn.click(timeout=2000)
                time.sleep(1.0 + random.random() * 0.6)
                break
        except Exception:
            pass
    return True


def _pin_check_asin(page, asin, pincode):
    url = f"https://www.amazon.in/dp/{asin}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        time.sleep(1.8 + random.random() * 1.0)
    except Exception as exc:
        return dict(asin=asin, pincode=pincode, title="", is_buyable=False,
                    availability_text="", amazon_fulfilled=False, delivery_type="error",
                    delivery_text="", status=f"NAV_ERROR:{type(exc).__name__}")

    captcha = _pin_looks_like_captcha(page)
    if captcha:
        return dict(asin=asin, pincode=pincode, title="", is_buyable=False,
                    availability_text="", amazon_fulfilled=False, delivery_type="",
                    delivery_text="", status="CAPTCHA")

    # Title
    try:
        title = re.sub(r"\s+", " ", page.locator("#productTitle").inner_text(timeout=3000).strip())
    except Exception:
        title = ""

    # Availability
    avail_text = _pin_safe_text(page, UNAVAILABLE_SELECTORS_PIN + ["#availability", "#outOfStock", "#availabilityInsideBuyBox_feature_div"])
    lowered = avail_text.lower()
    neg = ["currently unavailable", "temporarily out of stock", "not deliverable",
           "cannot be delivered", "this item cannot be dispatched"]
    buyable = not any(p in lowered for p in neg)

    # Body text
    try:
        body_text = page.locator("body").inner_text(timeout=2500)
    except Exception:
        body_text = ""

    # Merchant / FBA
    merchant_text = _pin_safe_text(page, AMAZON_FULFILLED_SELECTORS)
    haystack = f"{merchant_text}\n{body_text}".lower()
    amazon_fulfilled = any(p in haystack for p in [
        "fulfilled by amazon", "ships from amazon",
        "dispatched from amazon", "amazon fulfilled",
    ])

    # Delivery text
    delivery_text = _pin_safe_text(page, DELIVERY_TEXT_SELECTORS)
    if not delivery_text:
        matches = []
        patterns = [
            r"(?:FREE )?(?:Same-Day|One-Day|Two-Day) Delivery",
            r"Today by [^\n\.]{1,40}", r"Tomorrow by [^\n\.]{1,40}",
            r"FREE delivery [^\n\.]{1,80}", r"Fastest delivery [^\n\.]{1,80}",
        ]
        for pat in patterns:
            for m in re.finditer(pat, body_text, re.I):
                matches.append(m.group(0).strip())
        delivery_text = " | ".join(dict.fromkeys(matches))[:500]

    delivery_type = _pin_classify_delivery(delivery_text, buyable)

    # Secondary guard
    if re.search(r"currently unavailable|temporarily out of stock", body_text, re.I):
        buyable = False
        if not avail_text:
            avail_text = "Currently unavailable"
        delivery_type = "unavailable"

    return dict(asin=asin, pincode=pincode, title=title[:80], is_buyable=buyable,
                availability_text=avail_text[:120], amazon_fulfilled=amazon_fulfilled,
                delivery_type=delivery_type, delivery_text=delivery_text[:120],
                status="OK")


def _check_pincode_worker(browser, asins, pincodes):
    results = []
    ctx = browser.new_context(
        user_agent=USER_AGENT,
        viewport={'width': 1920, 'height': 1080},
        locale='en-IN',
        timezone_id='Asia/Kolkata',
    )
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        for pincode in pincodes:
            pincode = pincode.strip()
            if not pincode:
                continue
            ok = _pin_set_pincode(page, pincode)
            if not ok:
                for asin in asins:
                    results.append(dict(asin=asin.strip().upper(), pincode=pincode, title="",
                                        is_buyable=False, availability_text="",
                                        amazon_fulfilled=False, delivery_type="",
                                        delivery_text="", status="PINCODE_SET_FAIL"))
                continue
            time.sleep(1.5 + random.random())
            for asin in asins:
                asin = asin.strip().upper()
                if not asin:
                    continue
                result = _pin_check_asin(page, asin, pincode)
                results.append(result)
                time.sleep(1.0 + random.random() * 0.8)
    finally:
        page.close()
        ctx.close()
    return results


def check_pincode(asins, pincodes):
    return run_in_browser(_check_pincode_worker, asins, pincodes)


# ===================================================================
# CSV helper
# ===================================================================
def to_csv(rows: list[dict]) -> str:
    if not rows:
        return ""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


# ===================================================================
# RESULT CACHE — download serves cached results instead of re-scraping
# ===================================================================
_result_cache: dict[str, list[dict]] = {}
_cache_lock = threading.Lock()


def cache_put(key: str, results: list[dict]):
    with _cache_lock:
        _result_cache[key] = results


def cache_get(key: str) -> list[dict] | None:
    with _cache_lock:
        return _result_cache.get(key, None)


# ===================================================================
# ROUTES
# ===================================================================
@app.route("/")
def index():
    return render_template("index.html", tab="bsr", marketplaces=MARKETPLACES)


@app.route("/bsr", methods=["GET", "POST"])
def bsr():
    results = None
    asins_input = ""
    marketplace = "IN"
    if request.method == "POST":
        asins_input = request.form.get("asins", "")
        marketplace = request.form.get("marketplace", "IN")
        if marketplace not in MARKETPLACES:
            marketplace = "IN"
        # Parse text input
        raw = asins_input.replace(",", "\n").replace(" ", "\n")
        asins = [a.strip() for a in raw.splitlines() if a.strip()]
        # Parse file upload
        f = request.files.get("file")
        if f and f.filename:
            rows = parse_upload_file(f)
            file_asins = extract_asins_from_upload(rows)
            asins.extend(a for a in file_asins if a not in asins)
            if not asins_input:
                asins_input = "\n".join(asins)
        if asins:
            results = lookup_bsr(asins, marketplace)
            cache_put("bsr", results)
    return render_template("index.html", tab="bsr", results=results,
                           asins_input=asins_input, marketplace=marketplace,
                           marketplaces=MARKETPLACES)


@app.route("/bsr/download", methods=["POST"])
def bsr_download():
    results = cache_get("bsr")
    if not results:
        return "No results to download. Run a lookup first.", 400
    return Response(to_csv(results), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=bsr_results.csv"})


@app.route("/rank", methods=["GET", "POST"])
def rank():
    results = None
    pairs_input = ""
    marketplace = "IN"
    if request.method == "POST":
        pairs_input = request.form.get("pairs", "")
        marketplace = request.form.get("marketplace", "IN")
        if marketplace not in MARKETPLACES:
            marketplace = "IN"
        pairs = []
        for line in pairs_input.strip().splitlines():
            parts = [p.strip() for p in line.split(",", 1)]
            if len(parts) == 2 and parts[0] and parts[1]:
                pairs.append(dict(keyword=parts[0], asin=parts[1]))
        # Parse file upload
        f = request.files.get("file")
        if f and f.filename:
            rows = parse_upload_file(f)
            file_pairs = extract_pairs_from_upload(rows)
            pairs.extend(file_pairs)
            if not pairs_input:
                pairs_input = "\n".join(f"{p['keyword']}, {p['asin']}" for p in pairs)
        if pairs:
            results = track_keyword_ranks(pairs, marketplace)
            cache_put("rank", results)
    return render_template("index.html", tab="rank", results=results,
                           pairs_input=pairs_input, marketplace=marketplace,
                           marketplaces=MARKETPLACES)


@app.route("/rank/download", methods=["POST"])
def rank_download():
    results = cache_get("rank")
    if not results:
        return "No results to download. Run a lookup first.", 400
    return Response(to_csv(results), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=rank_results.csv"})


@app.route("/hijack", methods=["GET", "POST"])
def hijack():
    results = None
    items_input = ""
    marketplace = "IN"
    if request.method == "POST":
        items_input = request.form.get("items", "")
        marketplace = request.form.get("marketplace", "IN")
        if marketplace not in MARKETPLACES:
            marketplace = "IN"
        items = []
        for line in items_input.strip().splitlines():
            parts = [p.strip() for p in line.split(",", 1)]
            if parts:
                asin = parts[0]
                auth = parts[1] if len(parts) > 1 else ""
                if asin:
                    items.append(dict(asin=asin, authorized_seller=auth))
        # Parse file upload
        f = request.files.get("file")
        if f and f.filename:
            rows = parse_upload_file(f)
            file_items = extract_hijack_items_from_upload(rows)
            items.extend(file_items)
            if not items_input:
                items_input = "\n".join(f"{i['asin']}, {i['authorized_seller']}" if i['authorized_seller'] else i['asin'] for i in items)
        if items:
            results = check_hijackers(items, marketplace)
            cache_put("hijack", results)
    return render_template("index.html", tab="hijack", results=results,
                           items_input=items_input, marketplace=marketplace,
                           marketplaces=MARKETPLACES)


@app.route("/hijack/download", methods=["POST"])
def hijack_download():
    results = cache_get("hijack")
    if not results:
        return "No results to download. Run a lookup first.", 400
    return Response(to_csv(results), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=hijack_results.csv"})


@app.route("/pincode", methods=["GET", "POST"])
def pincode():
    results = None
    asins_input = ""
    pincodes_input = ""
    if request.method == "POST":
        asins_input = request.form.get("asins", "")
        pincodes_input = request.form.get("pincodes", "")
        raw_asins = asins_input.replace(",", "\n").replace(" ", "\n")
        asins = [a.strip() for a in raw_asins.splitlines() if a.strip()]
        raw_pins = pincodes_input.replace(",", "\n").replace(" ", "\n")
        pincodes_list = [p.strip() for p in raw_pins.splitlines() if p.strip()]
        # Parse file upload (col1=ASIN, col2=pincode)
        f = request.files.get("file")
        if f and f.filename:
            rows = parse_upload_file(f)
            for row in rows:
                asin = (row[0].upper().strip() if row else '')
                asin = re.sub(r'[^A-Z0-9]', '', asin)
                pin = row[1].strip() if len(row) > 1 else ''
                if asin and len(asin) == 10 and asin not in asins:
                    asins.append(asin)
                if pin and pin not in pincodes_list:
                    pincodes_list.append(pin)
            if not asins_input:
                asins_input = "\n".join(asins)
            if not pincodes_input:
                pincodes_input = "\n".join(pincodes_list)
        if asins and pincodes_list:
            results = check_pincode(asins, pincodes_list)
            cache_put("pincode", results)
    return render_template("index.html", tab="pincode", results=results,
                           asins_input=asins_input, pincodes_input=pincodes_input,
                           marketplaces=MARKETPLACES)


@app.route("/pincode/download", methods=["POST"])
def pincode_download():
    results = cache_get("pincode")
    if not results:
        return "No results to download. Run a lookup first.", 400
    return Response(to_csv(results), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=pincode_results.csv"})


# ===================================================================
# DAILY DASHBOARD
# ===================================================================
@app.route("/dashboard")
def dashboard():
    import os
    import pandas as pd
    from datetime import timedelta
    from flask import request as req

    DASH_DIR = os.path.join(os.path.dirname(__file__), "amazon-pincode-checker", "daily_dashboard")
    BANK_DIR = os.path.join(DASH_DIR, "data_bank")
    ADS_REPORTS = os.path.join(os.path.dirname(__file__), "amazon-pincode-checker", "amazon_ads_tool", "reports")

    # ── Date range from query params ──
    today = datetime.now()
    default_end = (today - timedelta(days=1)).date()
    default_start = default_end  # single day default
    try:
        start_param = req.args.get('start', '')
        end_param = req.args.get('end', '')
        # Handle preset shortcuts: 7d, 30d
        if start_param.endswith('d') and start_param[:-1].isdigit():
            range_end = datetime.strptime(end_param, '%Y-%m-%d').date() if end_param else default_end
            range_start = range_end - timedelta(days=int(start_param[:-1]) - 1)
        else:
            range_start = datetime.strptime(start_param, '%Y-%m-%d').date() if start_param else default_start
            range_end = datetime.strptime(end_param, '%Y-%m-%d').date() if end_param else default_end
    except ValueError:
        range_start, range_end = default_start, default_end
    # Clamp to sane range
    if range_start > range_end:
        range_start, range_end = range_end, range_start
    range_days = (range_end - range_start).days + 1
    is_single_day = range_days == 1

    # Load data
    def _load_csv(name):
        p = os.path.join(BANK_DIR, f"{name}.csv")
        return pd.read_csv(p) if os.path.exists(p) and os.path.getsize(p) > 0 else pd.DataFrame()

    def _load_json(path):
        import json as _json
        if os.path.exists(path) and os.path.getsize(path) > 10:
            with open(path) as f:
                return _json.load(f)
        return []

    orders = _load_csv('orders')
    inventory = _load_csv('fba_inventory')
    inventory_fc = _load_csv('inventory_by_fc')
    fc_ledger = _load_csv('fc_ledger')
    ads_daily_df = _load_csv('ads_campaigns_daily')

    # Load ads from cached JSONs (summary — fallback when daily isn't available)
    sp_camps = _load_json(os.path.join(ADS_REPORTS, "sp_campaigns_data.json"))
    sd_camps = _load_json(os.path.join(ADS_REPORTS, "sd_campaigns_data.json"))
    # Also check monthly for fresher data
    import glob
    month_str = datetime.now(timezone.utc).strftime('%Y-%m')
    for pattern, target in [
        (f"sp_campaigns_{month_str}.json", "sp"),
        (f"sd_campaigns_{month_str}.json", "sd"),
    ]:
        monthly_path = os.path.join(ADS_REPORTS, "monthly", pattern)
        if os.path.exists(monthly_path):
            default_path = os.path.join(ADS_REPORTS, f"{'sp' if target == 'sp' else 'sd'}_campaigns_data.json")
            if not os.path.exists(default_path) or os.path.getmtime(monthly_path) > os.path.getmtime(default_path):
                if target == "sp":
                    sp_camps = _load_json(monthly_path)
                else:
                    sd_camps = _load_json(monthly_path)

    # Normalize SD columns
    for row in sd_camps:
        if 'purchases' in row and 'purchases1d' not in row:
            row['purchases1d'] = row['purchases']
        if 'sales' in row and 'sales1d' not in row:
            row['sales1d'] = row['sales']
        if 'unitsSoldClicks' in row and 'unitsSoldClicks1d' not in row:
            row['unitsSoldClicks1d'] = row['unitsSoldClicks']

    all_camps = sp_camps + sd_camps
    ads_summary_df = pd.DataFrame(all_camps) if all_camps else pd.DataFrame()
    for col in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d']:
        if not ads_summary_df.empty and col in ads_summary_df.columns:
            ads_summary_df[col] = pd.to_numeric(ads_summary_df[col], errors='coerce').fillna(0)

    # Use daily ads data filtered by date range when available; fall back to summary
    ads_df = ads_summary_df  # default fallback
    has_daily_ads = False
    if not ads_daily_df.empty and 'date' in ads_daily_df.columns:
        for col in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d']:
            if col in ads_daily_df.columns:
                ads_daily_df[col] = pd.to_numeric(ads_daily_df[col], errors='coerce').fillna(0)
        ads_daily_df['_date'] = pd.to_datetime(ads_daily_df['date'], errors='coerce').dt.date
        range_ads = ads_daily_df[(ads_daily_df['_date'] >= range_start) & (ads_daily_df['_date'] <= range_end)]
        if not range_ads.empty:
            has_daily_ads = True
            # Aggregate daily rows by campaign for the selected range
            agg_cols = {c: 'sum' for c in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d'] if c in range_ads.columns}
            keep_cols = ['campaignName', 'campaignId']
            keep_cols = [c for c in keep_cols if c in range_ads.columns]
            if keep_cols:
                ads_df = range_ads.groupby(keep_cols, as_index=False).agg(agg_cols)
            else:
                ads_df = pd.DataFrame({'cost': [range_ads['cost'].sum()], 'sales1d': [range_ads['sales1d'].sum()]})

    yesterday = range_end  # use the selected end date

    # ── Build KPIs ──
    kpi = {}
    if not orders.empty and 'order_date' in orders.columns:
        orders['date'] = pd.to_datetime(orders['order_date'], errors='coerce').dt.date
        active = orders[~orders.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled', 'Unfulfillable'])] if 'item_status' in orders.columns else orders

        range_data = active[(active['date'] >= range_start) & (active['date'] <= range_end)]
        range_rev = range_data['item_price'].sum() if 'item_price' in range_data.columns else 0
        range_units = int(range_data['quantity'].sum()) if 'quantity' in range_data.columns else len(range_data)

        week_ago = range_end - timedelta(days=6)
        week = active[(active['date'] >= week_ago) & (active['date'] <= range_end)]
        week_daily_rev = week['item_price'].sum() / 7 if 'item_price' in week.columns else 0
        week_daily_units = week['quantity'].sum() / 7 if 'quantity' in week.columns else 0

        daily_avg_rev = range_rev / max(range_days, 1)
        rev_delta = ((daily_avg_rev / max(week_daily_rev, 1)) - 1) * 100 if week_daily_rev > 0 else 0
        daily_avg_units = range_units / max(range_days, 1)
        unit_delta = ((daily_avg_units / max(week_daily_units, 1)) - 1) * 100 if week_daily_units > 0 else 0

        month_ago = range_end - timedelta(days=29)
        month_data = active[(active['date'] >= month_ago) & (active['date'] <= range_end)]
        month_rev = month_data['item_price'].sum() if not month_data.empty else 0
        month_units = int(month_data['quantity'].sum()) if not month_data.empty else 0

        kpi['revenue'] = f"₹{range_rev:,.0f}"
        kpi['units'] = f"{range_units:,}"
        kpi['rev_delta'] = rev_delta
        kpi['rev_delta_abs'] = f"{abs(rev_delta):.0f}"
        kpi['unit_delta'] = unit_delta
        kpi['unit_delta_abs'] = f"{abs(unit_delta):.0f}"
        kpi['month_revenue'] = f"₹{month_rev:,.0f}"
        kpi['month_units'] = f"{month_units:,}"
    else:
        kpi = {k: '—' for k in ['revenue', 'units', 'rev_delta_abs', 'unit_delta_abs', 'month_revenue', 'month_units']}
        kpi['rev_delta'] = 0
        kpi['unit_delta'] = 0

    if not ads_df.empty:
        total_spend = ads_df['cost'].sum()
        total_sales = ads_df['sales1d'].sum()
        kpi['ad_spend'] = f"₹{total_spend:,.0f}"
        kpi['ad_sales'] = f"₹{total_sales:,.0f}"
        kpi['roas'] = f"{total_sales / max(total_spend, 1):.1f}"
        kpi['acos'] = f"{(total_spend / max(total_sales, 1)) * 100:.1f}"
    else:
        kpi.update({'ad_spend': '—', 'ad_sales': '—', 'roas': '—', 'acos': '—'})

    if not inventory.empty and 'fba_available' in inventory.columns:
        kpi['fba_available'] = f"{int(inventory['fba_available'].sum()):,}"
        kpi['oos_count'] = int((inventory['fba_available'] == 0).sum())
    else:
        kpi['fba_available'] = '—'
        kpi['oos_count'] = 0

    # ── Top ASINs ──
    top_asins = []
    if not orders.empty and 'date' in orders.columns:
        yday_active = orders[(orders['date'] >= range_start) & (orders['date'] <= range_end) & (~orders.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled']))] if 'item_status' in orders.columns else orders[(orders['date'] >= range_start) & (orders['date'] <= range_end)]
        if not yday_active.empty:
            top = yday_active.groupby(['asin', 'sku']).agg(revenue=('item_price', 'sum'), units=('quantity', 'sum')).sort_values('revenue', ascending=False).head(10)
            for (asin, sku), row in top.iterrows():
                top_asins.append({'asin': asin, 'sku': sku[:35], 'revenue': f"{row['revenue']:,.0f}", 'units': int(row['units'])})

    # ── Top Campaigns ──
    top_campaigns = []
    if not ads_df.empty and 'sales1d' in ads_df.columns:
        for _, row in ads_df.nlargest(5, 'sales1d').iterrows():
            r = row['sales1d'] / max(row['cost'], 1)
            a = (row['cost'] / max(row['sales1d'], 1)) * 100
            top_campaigns.append({
                'name': str(row.get('campaignName', ''))[:40],
                'spend': f"{row['cost']:,.0f}",
                'sales': f"{row['sales1d']:,.0f}",
                'roas': f"{r:.1f}",
                'acos': f"{a:.1f}",
                'acos_val': a,
            })

    # ── Bleeding Campaigns ──
    bleeding_campaigns = []
    if not ads_df.empty:
        bleeders = ads_df[(ads_df['cost'] > 500) & (ads_df['sales1d'] > 0)].copy()
        if not bleeders.empty:
            bleeders['acos'] = (bleeders['cost'] / bleeders['sales1d']) * 100
            bleeders = bleeders[bleeders['acos'] > 30].sort_values('acos', ascending=False)
            for _, row in bleeders.head(8).iterrows():
                bleeding_campaigns.append({
                    'name': str(row.get('campaignName', ''))[:42],
                    'acos': f"{row['acos']:.1f}",
                    'spend': f"{row['cost']:,.0f}",
                })

    # ── Zero Sales ──
    zero_sales_campaigns = []
    if not ads_df.empty:
        zero = ads_df[(ads_df['cost'] > 200) & (ads_df['sales1d'] == 0)]
        for _, row in zero.nlargest(8, 'cost').iterrows():
            zero_sales_campaigns.append({
                'name': str(row.get('campaignName', ''))[:45],
                'spend': f"{row['cost']:,.0f}",
                'clicks': int(row.get('clicks', 0)),
            })

    # ── Categories ──
    categories = []
    try:
        import sys as _sys
        _sys.path.insert(0, os.path.join(os.path.dirname(__file__), "amazon-pincode-checker"))
        from category_analysis.categories import CATEGORIES
        if CATEGORIES and not orders.empty and 'date' in orders.columns:
            yday_active = orders[(orders['date'] >= range_start) & (orders['date'] <= range_end) & (~orders.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled']))] if 'item_status' in orders.columns else orders[(orders['date'] >= range_start) & (orders['date'] <= range_end)]
            if not yday_active.empty:
                def _cat(row):
                    sku_l = str(row.get('sku', '')).lower()
                    asin = str(row.get('asin', ''))
                    for k, c in CATEGORIES.items():
                        if asin in c.get('asins', []):
                            return k
                        for p in c.get('sku_patterns', []):
                            if p.lower() in sku_l:
                                return k
                    return "Other"
                yday_active = yday_active.copy()
                yday_active['cat'] = yday_active.apply(_cat, axis=1)
                cat_sum = yday_active.groupby('cat').agg(revenue=('item_price', 'sum'), units=('quantity', 'sum'), orders=('quantity', 'size')).sort_values('revenue', ascending=False)
                for cat, row in cat_sum.iterrows():
                    categories.append({'name': cat, 'revenue': f"{row['revenue']:,.0f}", 'units': int(row['units']), 'orders': int(row['orders'])})
    except ImportError:
        pass

    # ── Low Stock ──
    low_stock = []
    if not inventory.empty and 'fba_available' in inventory.columns:
        ls = inventory[(inventory['fba_available'] > 0) & (inventory['fba_available'] <= 10)].sort_values('fba_available')
        for _, row in ls.head(15).iterrows():
            low_stock.append({
                'sku': str(row.get('sku', ''))[:28],
                'qty': int(row['fba_available']),
                'name': str(row.get('product_name', ''))[:40],
            })

    # ── Out of Stock ──
    oos_items = []
    if not inventory.empty and 'fba_available' in inventory.columns:
        oos = inventory[inventory['fba_available'] == 0]
        for _, row in oos.iterrows():
            inbound = int(row.get('fba_inbound_shipped', 0)) + int(row.get('fba_inbound_working', 0))
            oos_items.append({
                'sku': str(row.get('sku', ''))[:28],
                'name': str(row.get('product_name', ''))[:42],
                'inbound': inbound,
            })

    # ── Order Status ──
    order_status = []
    if not orders.empty and 'item_status' in orders.columns and 'date' in orders.columns:
        yday_all = orders[(orders['date'] >= range_start) & (orders['date'] <= range_end)]
        status_counts = yday_all.groupby('item_status').agg(count=('quantity', 'size'), revenue=('item_price', 'sum')).sort_values('revenue', ascending=False)
        for status, row in status_counts.iterrows():
            order_status.append({'status': status, 'count': int(row['count']), 'revenue': f"{row['revenue']:,.0f}"})

    # ── Ads vs Organic Split ──
    ads_organic = {}
    if not orders.empty and not ads_df.empty and 'date' in orders.columns:
        active = orders[~orders.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled', 'Unfulfillable'])] if 'item_status' in orders.columns else orders

        # MTD split (same period as ads data = current month)
        mtd_start = yesterday.replace(day=1)
        mtd_orders = active[(active['date'] >= mtd_start) & (active['date'] <= yesterday)]
        mtd_total_rev = mtd_orders['item_price'].sum() if not mtd_orders.empty else 0
        mtd_ad_sales = ads_df['sales1d'].sum()
        mtd_ad_spend = ads_df['cost'].sum()
        mtd_organic = max(0, mtd_total_rev - mtd_ad_sales)
        mtd_ad_pct = (mtd_ad_sales / max(mtd_total_rev, 1)) * 100 if mtd_total_rev > 0 else 0
        mtd_organic_pct = max(0, 100 - mtd_ad_pct)
        mtd_days = (yesterday - mtd_start).days + 1
        mtd_blended_roas = mtd_total_rev / max(mtd_ad_spend, 1)

        # Yesterday split (estimate: scale ads by 1/days_in_period)
        yday_total = active[active['date'] == yesterday]['item_price'].sum()
        yday_ad_est = mtd_ad_sales / max(mtd_days, 1)  # daily avg from ads
        yday_organic_est = max(0, yday_total - yday_ad_est)
        yday_ad_pct = (yday_ad_est / max(yday_total, 1)) * 100 if yday_total > 0 else 0

        ads_organic = {
            'mtd_total': f"{mtd_total_rev:,.0f}",
            'mtd_ad_sales': f"{mtd_ad_sales:,.0f}",
            'mtd_organic': f"{mtd_organic:,.0f}",
            'mtd_ad_pct': round(mtd_ad_pct, 1),
            'mtd_organic_pct': round(mtd_organic_pct, 1),
            'mtd_ad_spend': f"{mtd_ad_spend:,.0f}",
            'mtd_blended_roas': f"{mtd_blended_roas:.1f}",
            'mtd_days': mtd_days,
            'yday_total': f"{yday_total:,.0f}",
            'yday_ad_est': f"{yday_ad_est:,.0f}",
            'yday_organic_est': f"{yday_organic_est:,.0f}",
            'yday_ad_pct': round(yday_ad_pct, 1),
        }

    # ── Inventory by FC (Seller Flex vs Amazon FBA) ──
    SELLER_FLEX_FCS = {'TPKR', 'XHZU', 'XHZV', 'XHZR'}
    fc_inventory = {'seller_flex': [], 'amazon_fba': [], 'sf_total': 0, 'fba_total': 0, 'sf_skus': 0, 'fba_skus': 0, 'has_data': False}
    if not inventory_fc.empty and 'fc_code' in inventory_fc.columns and 'quantity' in inventory_fc.columns:
        fc_inventory['has_data'] = True
        fc_summary = inventory_fc.groupby(['fc_code', 'fc_type']).agg(
            total_qty=('quantity', 'sum'),
            sku_count=('sku', 'nunique'),
        ).reset_index().sort_values('total_qty', ascending=False)
        for _, row in fc_summary.iterrows():
            entry = {'fc': row['fc_code'], 'qty': int(row['total_qty']), 'skus': int(row['sku_count'])}
            if row['fc_code'].upper() in SELLER_FLEX_FCS:
                fc_inventory['seller_flex'].append(entry)
                fc_inventory['sf_total'] += entry['qty']
                fc_inventory['sf_skus'] += entry['skus']
            else:
                fc_inventory['amazon_fba'].append(entry)
                fc_inventory['fba_total'] += entry['qty']
                fc_inventory['fba_skus'] += entry['skus']

    # ── FC Daily Movement (from ledger) ──
    fc_movement = {'has_data': False, 'days': [], 'sf_daily': [], 'fba_daily': []}
    if not fc_ledger.empty and 'date' in fc_ledger.columns and 'ending_balance' in fc_ledger.columns:
        fc_ledger['date'] = pd.to_datetime(fc_ledger['date'], errors='coerce').dt.strftime('%Y-%m-%d')
        fc_ledger['fc_upper'] = fc_ledger['fc_code'].str.upper()
        fc_ledger['is_sf'] = fc_ledger['fc_upper'].isin(SELLER_FLEX_FCS)
        for num_col in ['receipts', 'customer_shipments', 'customer_returns', 'transfers', 'ending_balance']:
            if num_col in fc_ledger.columns:
                fc_ledger[num_col] = pd.to_numeric(fc_ledger[num_col], errors='coerce').fillna(0).astype(int)

        all_dates = sorted(fc_ledger['date'].unique())
        fc_movement['has_data'] = True
        fc_movement['days'] = all_dates

        for d in all_dates:
            day_data = fc_ledger[fc_ledger['date'] == d]
            for is_sf, key in [(True, 'sf_daily'), (False, 'fba_daily')]:
                subset = day_data[day_data['is_sf'] == is_sf]
                fc_movement[key].append({
                    'date': d,
                    'balance': int(subset['ending_balance'].sum()),
                    'receipts': int(subset['receipts'].sum()),
                    'shipments': int(subset['customer_shipments'].sum()),
                    'returns': int(subset['customer_returns'].sum()),
                    'transfers': int(subset['transfers'].sum()),
                })

    # ── Alerts ──
    alerts = []
    if not orders.empty and 'date' in orders.columns:
        if kpi.get('rev_delta', 0) < -20:
            alerts.append({'type': 'warning', 'icon': '⚠️', 'text': f"Revenue dropped {abs(kpi['rev_delta']):.0f}% vs 7-day average"})

    if not inventory.empty and not orders.empty and 'fba_available' in inventory.columns and 'sku' in orders.columns:
        oos_skus = set(inventory[inventory['fba_available'] == 0]['sku'].str.strip())
        recent = orders[orders.get('date', pd.Series()) >= yesterday - timedelta(days=7)] if 'date' in orders.columns else pd.DataFrame()
        if not recent.empty:
            selling = set(recent['sku'].str.strip())
            overlap = oos_skus & selling
            if overlap:
                alerts.append({'type': 'danger', 'icon': '🔴', 'text': f"{len(overlap)} actively-selling SKUs are OUT OF STOCK: {', '.join(list(overlap)[:3])}"})

    if not ads_df.empty:
        high_acos = ads_df[(ads_df['cost'] > 1000) & (ads_df['sales1d'] > 0) & ((ads_df['cost'] / ads_df['sales1d']) > 0.35)]
        if not high_acos.empty:
            alerts.append({'type': 'warning', 'icon': '⚠️', 'text': f"{len(high_acos)} campaigns with ACoS > 35% and spend > ₹1,000"})
        zero = ads_df[(ads_df['cost'] > 200) & (ads_df['sales1d'] == 0)]
        if not zero.empty:
            alerts.append({'type': 'danger', 'icon': '💸', 'text': f"{len(zero)} campaigns spent ₹{zero['cost'].sum():,.0f} with ZERO sales"})

    if not alerts:
        alerts.append({'type': 'success', 'icon': '✅', 'text': 'No major alerts. All looking good!'})

    return render_template("dashboard.html",
        data_date=str(range_end),
        range_start=str(range_start),
        range_end=str(range_end),
        range_days=range_days,
        is_single_day=is_single_day,
        has_daily_ads=has_daily_ads,
        generated_at=today.strftime('%Y-%m-%d %H:%M'),
        kpi=kpi,
        alerts=alerts,
        top_asins=top_asins,
        top_campaigns=top_campaigns,
        bleeding_campaigns=bleeding_campaigns,
        zero_sales_campaigns=zero_sales_campaigns,
        categories=categories,
        low_stock=low_stock,
        oos_items=oos_items,
        order_status=order_status,
        ads_organic=ads_organic,
        fc_inventory=fc_inventory,
        fc_movement=fc_movement,
    )


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
