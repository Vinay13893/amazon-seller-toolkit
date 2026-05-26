"""
One-shot scraping Celery tasks:
  keyword_rank   — find a keyword's search position for an ASIN
  hijack_check   — list all sellers on an ASIN, flag unauthorized ones
  pincode_check  — check product availability/delivery for given pincodes
"""
import re
import time
import random
import logging
from datetime import datetime
from urllib.parse import quote_plus

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from ..celery_app import celery

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

STEALTH_INIT_SCRIPT = """
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-IN', 'en-US', 'en']});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
"""

MARKETPLACE_DOMAINS = {"IN": "www.amazon.in", "US": "www.amazon.com"}
OFFERS_URL = {
    "IN": "https://www.amazon.in/gp/offer-listing/{asin}?condition=new",
    "US": "https://www.amazon.com/gp/offer-listing/{asin}?condition=new",
}


def _launch():
    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    return pw, browser


def _new_ctx(browser):
    return browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1920, "height": 1080},
        locale="en-IN",
        timezone_id="Asia/Kolkata",
    )


# ═══════════════════════════════════════════════════════════════════
# TOOL 1 — KEYWORD RANK
# ═══════════════════════════════════════════════════════════════════
RANK_PAGES = 7


def _build_search_url(domain: str, keyword: str, page_num: int) -> str:
    q = quote_plus(keyword.strip())
    return f"https://{domain}/s?k={q}" if page_num <= 1 else f"https://{domain}/s?k={q}&page={page_num}"


def _extract_search_asins(html: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    asins = []
    for div in soup.select('div[data-component-type="s-search-result"]'):
        a = (div.get("data-asin") or "").upper().strip()
        if a and len(a) == 10 and a not in asins:
            asins.append(a)
    if not asins:
        for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, re.I):
            a = m.group(1).upper()
            if a not in asins:
                asins.append(a)
    return asins


def _detect_sponsored(html: str, asin: str) -> bool:
    idx = html.upper().find(f'DATA-ASIN="{asin.upper()}"')
    if idx == -1:
        return False
    window = html[max(0, idx - 2000): idx + 4000].lower()
    return "sponsored" in window


def _run_rank(pairs: list[dict], marketplace: str) -> list[dict]:
    domain = MARKETPLACE_DOMAINS[marketplace]
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    results = []
    pw, browser = _launch()
    ctx = _new_ctx(browser)
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        for pair in pairs:
            kw = pair["keyword"].strip()
            asin = re.sub(r"[^A-Z0-9]", "", pair["asin"].strip().upper())
            if not kw or not asin:
                continue
            found_page = found_pos = sponsored = None
            scan_status = "ok"
            for pnum in range(1, RANK_PAGES + 1):
                try:
                    url = _build_search_url(domain, kw, pnum)
                    page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    time.sleep(1.0)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                    time.sleep(0.8)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    time.sleep(0.8)
                    html = page.content()
                    page_asins = _extract_search_asins(html)
                    if asin in page_asins:
                        found_page = pnum
                        found_pos = page_asins.index(asin) + 1
                        sponsored = _detect_sponsored(html, asin)
                        break
                except Exception as e:
                    scan_status = f"error:{type(e).__name__}"
            results.append(dict(
                checked_at=now, marketplace=marketplace, keyword=kw, asin=asin,
                scan_status=scan_status, pages_scanned=RANK_PAGES,
                found=bool(found_page), page=found_page or "",
                position=found_pos or "", is_sponsored=bool(sponsored),
            ))
    finally:
        page.close(); ctx.close(); browser.close(); pw.stop()
    return results


@celery.task(bind=True, name="app.tasks.tools.keyword_rank")
def keyword_rank(self, pairs: list[dict], marketplace: str) -> list[dict]:
    log.info("keyword_rank pairs=%d marketplace=%s", len(pairs), marketplace)
    return _run_rank(pairs, marketplace)


# ═══════════════════════════════════════════════════════════════════
# TOOL 2 — HIJACK / OFFER CHECKER
# ═══════════════════════════════════════════════════════════════════
def _ns(s):
    return " ".join((s or "").split()).strip()


def _clean_seller(s):
    s = _ns(s)
    s = re.split(r"\s+Seller rating\s+is\s+", s, re.I)[0]
    s = re.split(r"\s+See\s+less\s*$", s, re.I)[0]
    return s.strip(" -|").strip()


def _price_num(p):
    if not p:
        return ""
    p = p.replace(",", "").replace("\u20b9", "").replace("$", "").strip()
    try:
        return float(p)
    except ValueError:
        return ""


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
    soup = BeautifulSoup(html, "lxml")
    blocks = soup.select("div#aod-offer, div.aod-offer") or soup.select("div.olpOffer")
    offers = []
    seen = set()
    for b in blocks:
        t = _ns(b.get_text(" ", strip=True))
        if not t:
            continue
        a = b.select_one("a[href*='/sp?seller='], a[href*='/gp/aag/main?seller='], a[href*='seller=']")
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
        p = b.select_one("span.a-price span.a-offscreen") or b.select_one("span.olpOfferPrice")
        price = _ns(p.get_text(strip=True)) if p else ""
        if not price:
            m = re.search(r"(\u20b9\s?[\d,]+(?:\.\d{1,2})?)", t)
            if m:
                price = m.group(1).replace(" ", "")
        fulf = "FBA" if re.search(r"Fulfilled by Amazon|Ships from Amazon|Dispatched from and sold by Amazon", t, re.I) else "FBM"
        delivery = _extract_delivery(t)
        key = (seller_id or seller or "", price, fulf)
        if key in seen or not (seller or price):
            continue
        seen.add(key)
        offers.append(dict(seller=seller, seller_id=seller_id, price=price,
                           fulfillment=fulf, delivery=delivery))
        if len(offers) >= 30:
            break
    return offers


def _try_continue_shopping(page):
    try:
        html = page.content()
        if "continue shopping" in html.lower():
            for sel in ["a:has-text('Continue shopping')", "a:has-text('Continue Shopping')", "input[type=submit]"]:
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


def _run_hijack(items: list[dict], marketplace: str) -> list[dict]:
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    results = []
    pw, browser = _launch()
    ctx = _new_ctx(browser)
    page = ctx.new_page()
    page.add_init_script(STEALTH_INIT_SCRIPT)
    try:
        for item in items:
            asin = item["asin"].strip().upper()
            auth = _clean_seller(item.get("authorized_seller", ""))
            if not asin:
                continue
            offer_url = OFFERS_URL[marketplace].format(asin=asin)
            offers = []
            try:
                page.goto(offer_url, wait_until="domcontentloaded", timeout=30000)
                time.sleep(2.5)
                _try_continue_shopping(page)
                time.sleep(1.0)
                offers = _extract_offers(page.content())
            except Exception as e:
                results.append(dict(checked_at=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status=f"ERROR:{type(e).__name__}"))
                continue
            if not offers:
                results.append(dict(checked_at=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller="", seller_id="",
                                    price="", fulfillment="", delivery="",
                                    status="NO_OFFERS_FOUND"))
                continue
            auth_lower = auth.lower() if auth else ""
            for o in offers:
                if auth and o["seller"] and o["seller"].lower() != auth_lower:
                    st = "UNAUTHORIZED"
                elif auth and not o["seller"]:
                    st = "UNKNOWN_SELLER"
                else:
                    st = "OK"
                results.append(dict(checked_at=now, asin=asin, marketplace=marketplace,
                                    authorized_seller=auth, seller=o["seller"],
                                    seller_id=o["seller_id"], price=o["price"],
                                    fulfillment=o["fulfillment"], delivery=o.get("delivery", ""),
                                    status=st))
    finally:
        page.close(); ctx.close(); browser.close(); pw.stop()
    return results


@celery.task(bind=True, name="app.tasks.tools.hijack_check")
def hijack_check(self, items: list[dict], marketplace: str) -> list[dict]:
    log.info("hijack_check items=%d marketplace=%s", len(items), marketplace)
    return _run_hijack(items, marketplace)


# ═══════════════════════════════════════════════════════════════════
# TOOL 3 — PINCODE CHECKER  (Amazon India only)
# ═══════════════════════════════════════════════════════════════════
_PINCODE_INPUT = ["#GLUXZipUpdateInput", "input[aria-label*='pincode' i]", "input[placeholder*='PIN' i]"]
_PINCODE_APPLY = ["#GLUXZipUpdate", "input.a-button-input[type='submit']", "button:has-text('Apply')"]
_LOC_OPEN = ["#glow-ingress-block", "#nav-global-location-popover-link", "#contextualIngressPtLabel_deliveryShortLine"]
_DELIVERY_SEL = [
    "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
    "#ddmDeliveryMessage", "#deliveryBlockMessage", "#delivery-message",
]
_AVAIL_SEL = ["#availability span", "#outOfStock span"]
_MERCHANT_SEL = ["#merchant-info", "#tabular-buybox-text", "#shipsFromSoldBy_feature_div"]
_DELIVERY_CLASSIFIERS = [
    (re.compile(r"same[ -]?day|today by|today,", re.I), "same_day"),
    (re.compile(r"one[ -]?day|tomorrow by|tomorrow,|overnight", re.I), "next_day"),
    (re.compile(r"two[ -]?day|day after tomorrow", re.I), "two_day"),
]


def _first_visible(page, selectors, timeout_ms=4000):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    return loc
            except Exception:
                continue
        time.sleep(0.15)
    return None


def _safe_text(page, selectors):
    texts = []
    for sel in selectors:
        try:
            loc = page.locator(sel)
            for i in range(min(loc.count(), 4)):
                t = (loc.nth(i).inner_text(timeout=1500) or "").strip()
                if t:
                    texts.append(t)
        except Exception:
            continue
    return re.sub(r"\s+", " ", " | ".join(dict.fromkeys(texts))).strip()


def _pin_set_pincode(page, pincode: str) -> bool:
    page.goto("https://www.amazon.in", wait_until="domcontentloaded", timeout=60000)
    time.sleep(1.5 + random.random() * 0.5)
    input_box = None
    for sel in ["#nav-global-location-popover-link", "#glow-ingress-block", "#contextualIngressPtLabel_deliveryShortLine"]:
        try:
            el = page.locator(sel)
            if el.count() > 0:
                page.evaluate(f'document.querySelector("{sel}").click()')
                time.sleep(2.0 + random.random() * 0.5)
                input_box = _first_visible(page, _PINCODE_INPUT, 3000)
                if input_box:
                    break
        except Exception:
            continue
    if not input_box:
        loc = _first_visible(page, _LOC_OPEN, 4000)
        if loc:
            try:
                loc.click(no_wait_after=True, timeout=3000)
                time.sleep(2.0)
            except Exception:
                pass
        input_box = _first_visible(page, _PINCODE_INPUT, 5000)
    if not input_box:
        return False
    try:
        input_box.click(timeout=2000)
        input_box.fill("")
        input_box.type(pincode, delay=80)
    except Exception:
        return False
    apply_btn = _first_visible(page, _PINCODE_APPLY, 5000)
    if not apply_btn:
        return False
    try:
        apply_btn.click(force=True, no_wait_after=True, timeout=3000)
    except Exception:
        return False
    time.sleep(2.0 + random.random())
    for text in ["Continue", "Done", "Apply", "Confirm"]:
        try:
            btn = page.get_by_role("button", name=re.compile(text, re.I)).first
            if btn.count() > 0 and btn.is_visible():
                btn.click(timeout=2000)
                time.sleep(1.0)
                break
        except Exception:
            pass
    return True


def _pin_check_asin(page, asin: str, pincode: str) -> dict:
    try:
        page.goto(f"https://www.amazon.in/dp/{asin}", wait_until="domcontentloaded", timeout=60000)
        time.sleep(1.8 + random.random())
    except Exception as exc:
        return dict(asin=asin, pincode=pincode, title="", is_buyable=False,
                    availability_text="", amazon_fulfilled=False, delivery_type="error",
                    delivery_text="", status=f"NAV_ERROR:{type(exc).__name__}")
    try:
        title = re.sub(r"\s+", " ", page.locator("#productTitle").inner_text(timeout=3000).strip())
    except Exception:
        title = ""
    avail_text = _safe_text(page, _AVAIL_SEL + ["#availability", "#availabilityInsideBuyBox_feature_div"])
    lowered = avail_text.lower()
    neg = ["currently unavailable", "temporarily out of stock", "not deliverable", "cannot be delivered"]
    buyable = not any(p in lowered for p in neg)
    try:
        body = page.locator("body").inner_text(timeout=2500)
    except Exception:
        body = ""
    merchant = _safe_text(page, _MERCHANT_SEL)
    haystack = f"{merchant}\n{body}".lower()
    amazon_fulfilled = any(p in haystack for p in ["fulfilled by amazon", "ships from amazon", "dispatched from amazon"])
    delivery_text = _safe_text(page, _DELIVERY_SEL)
    if not delivery_text:
        matches = []
        for pat in [r"(?:FREE )?(?:Same-Day|One-Day|Two-Day) Delivery", r"Today by [^\n\.]{1,40}", r"FREE delivery [^\n\.]{1,80}"]:
            for m in re.finditer(pat, body, re.I):
                matches.append(m.group(0).strip())
        delivery_text = " | ".join(dict.fromkeys(matches))[:300]
    delivery_type = "unavailable"
    if buyable:
        delivery_type = "unknown"
        for pattern, label in _DELIVERY_CLASSIFIERS:
            if pattern.search(delivery_text):
                delivery_type = label
                break
        else:
            if delivery_text:
                delivery_type = "other"
    if re.search(r"currently unavailable|temporarily out of stock", body, re.I):
        buyable = False
        delivery_type = "unavailable"
    return dict(asin=asin, pincode=pincode, title=title[:80], is_buyable=buyable,
                availability_text=avail_text[:120], amazon_fulfilled=amazon_fulfilled,
                delivery_type=delivery_type, delivery_text=delivery_text[:200], status="OK")


def _run_pincode(asins: list[str], pincodes: list[str]) -> list[dict]:
    results = []
    pw, browser = _launch()
    ctx = _new_ctx(browser)
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
                if asin:
                    results.append(_pin_check_asin(page, asin, pincode))
                    time.sleep(1.0 + random.random() * 0.8)
    finally:
        page.close(); ctx.close(); browser.close(); pw.stop()
    return results


@celery.task(bind=True, name="app.tasks.tools.pincode_check")
def pincode_check(self, asins: list[str], pincodes: list[str]) -> list[dict]:
    log.info("pincode_check asins=%d pincodes=%d", len(asins), len(pincodes))
    return _run_pincode(asins, pincodes)
