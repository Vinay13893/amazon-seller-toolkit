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

app = Flask(__name__)

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


def _playwright_worker():
    """Runs in a dedicated thread — owns the Playwright instance."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
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
    page = browser.new_page(user_agent=USER_AGENT)
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        status = resp.status if resp else 0
        page.wait_for_timeout(1000)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        page.wait_for_timeout(800)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(700)
        html = page.content()
    finally:
        page.close()
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
    for rank_raw, cat_raw in matches:
        rank_num = rank_raw.replace(",", "").strip()
        cat = cat_raw.strip()
        cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
        cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
        if rank_num.isdigit():
            ranks.append((int(rank_num), cat))
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
    page = browser.new_page(user_agent=USER_AGENT)
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


def _check_hijackers_worker(browser, items: list[dict], marketplace: str) -> list[dict]:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    results = []
    page = browser.new_page(user_agent=USER_AGENT)
    try:
        for item in items:
            asin = item["asin"].strip().upper()
            auth = clean_seller(item.get("authorized_seller", ""))
            if not asin:
                continue
            offer_url = OFFERS_URL[marketplace].format(asin=asin)
            try:
                page.goto(offer_url, wait_until="domcontentloaded", timeout=30000)
                time.sleep(2.5)
                html = page.content()
                offers = extract_offers(html)
            except Exception as e:
                results.append(dict(scan_time=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status=f"ERROR:{type(e).__name__}"))
                continue
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
    time.sleep(1.0 + random.random() * 0.5)

    loc = _pin_first_visible(page, LOCATION_OPEN_SELECTORS, timeout_ms=6000)
    if not loc:
        return False
    try:
        loc.click(timeout=3000)
        time.sleep(1.0 + random.random() * 0.7)
    except Exception:
        return False

    input_box = _pin_first_visible(page, PINCODE_INPUT_SELECTORS, timeout_ms=7000)
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
        apply_btn.click(timeout=3000)
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
    page = browser.new_page(user_agent=USER_AGENT)
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
        return _result_cache.pop(key, None)


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
        raw = asins_input.replace(",", "\n").replace(" ", "\n")
        asins = [a.strip() for a in raw.splitlines() if a.strip()]
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


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
