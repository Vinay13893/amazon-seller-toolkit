"""
BSR scraping Celery tasks.

Flow:
  scrape_all_bsr()           — beat task: fans out one job per user
      └─ scrape_bsr_for_user(user_id) — scrapes all active ASINs for that user
"""

import re
import uuid
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional, Tuple, List

import requests
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from ..celery_app import celery
from ..database import SessionLocal
from ..models import User, ASIN, BSRHistory, JobLog, JobStatus

log = logging.getLogger(__name__)

SCRAPE_WORKERS = 5       # parallel threads
REQUEST_TIMEOUT = 15     # seconds for requests fallback

BASE_URL = {
    "IN": "https://www.amazon.in/dp/{asin}",
    "US": "https://www.amazon.com/dp/{asin}",
    "UK": "https://www.amazon.co.uk/dp/{asin}",
    "DE": "https://www.amazon.de/dp/{asin}",
    "JP": "https://www.amazon.co.jp/dp/{asin}",
}

# Rotate through several real Chrome UA strings to reduce block rate
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
]
_ua_index = 0
_ua_lock = threading.Lock()

def _next_ua() -> str:
    global _ua_index
    with _ua_lock:
        ua = _USER_AGENTS[_ua_index % len(_USER_AGENTS)]
        _ua_index += 1
    return ua

# One shared requests.Session per thread (thread-local)
_thread_local = threading.local()

def _get_session() -> requests.Session:
    if not hasattr(_thread_local, "session"):
        s = requests.Session()
        s.headers.update({
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Cache-Control": "max-age=0",
            "DNT": "1",
        })
        _thread_local.session = s
    return _thread_local.session


# ---------------------------------------------------------------------------
# Scraping helpers
# ---------------------------------------------------------------------------

def _fetch_requests(url: str) -> Tuple[int, str]:
    """Fast path: plain HTTPS request — no browser, ~1-3 seconds per ASIN."""
    session = _get_session()
    session.headers["User-Agent"] = _next_ua()
    resp = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
    return resp.status_code, resp.text


def _fetch_playwright(url: str) -> Tuple[int, str]:
    """Slow-path fallback: headless Chromium with stealth mode."""
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
        # Remove webdriver fingerprint
        page.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            status = resp.status if resp else 0
            page.wait_for_timeout(800)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
            page.wait_for_timeout(700)
            html = page.content()
        finally:
            page.close()
            browser.close()
    return status, html


def _scrape_one(asin_obj) -> dict:
    """
    Scrape a single ASIN.  Tries requests first (fast); if CAPTCHA/blocked,
    falls back to Playwright (stealth).  Safe to call from multiple threads.
    """
    marketplace = asin_obj.marketplace or "IN"
    url = BASE_URL.get(marketplace, BASE_URL["IN"]).format(asin=asin_obj.asin)

    result = {
        "asin_id": asin_obj.id,
        "bsr_main": None,
        "bsr_main_cat": None,
        "sub_rank": None,
        "sub_category": None,
        "scrape_status": "FETCH_ERROR",
    }

    # ── Fast path: requests ──────────────────────────────────────────────────
    try:
        http_status, html = _fetch_requests(url)
        log.debug("requests %s → HTTP %d", asin_obj.asin, http_status)
    except Exception as exc:
        log.warning("requests failed for %s: %s — trying Playwright", asin_obj.asin, exc)
        html = ""
        http_status = 0

    captcha = bool(html and "captcha" in html.lower() and "Type the characters" in html)
    blocked  = http_status not in (200, 0) or (http_status == 200 and len(html) < 5000)

    # ── Slow-path fallback: Playwright ───────────────────────────────────────
    if captcha or blocked or not html:
        log.info("falling back to Playwright for %s (captcha=%s blocked=%s)",
                 asin_obj.asin, captcha, blocked)
        try:
            http_status, html = _fetch_playwright(url)
        except Exception as exc:
            log.warning("Playwright failed for %s: %s", asin_obj.asin, exc)
            return result

    if http_status != 200:
        result["scrape_status"] = f"HTTP_{http_status}"
        return result

    bsr_main, bsr_main_cat, bsr_all, scrape_status = _extract_bsr(html)
    result["bsr_main"] = bsr_main
    result["bsr_main_cat"] = bsr_main_cat
    result["scrape_status"] = scrape_status

    if bsr_all:
        subs = []
        for part in bsr_all.split(";")[1:]:
            if "|" in part:
                r, c = part.split("|", 1)
                if r.isdigit():
                    subs.append((int(r), c))
        if subs:
            result["sub_rank"], result["sub_category"] = min(subs, key=lambda x: x[0])

    return result


def _extract_bsr(html: str) -> Tuple[Optional[int], Optional[str], Optional[str], str]:
    """
    Parse BSR data from Amazon product HTML.

    Returns: (bsr_main, bsr_main_category, bsr_all_compact, status)
      bsr_all_compact example: "13170|Home & Kitchen;631|Small Kitchen Appliances"
      status: OK_MULTI | CAPTCHA | NOT_FOUND | PARSE_FAIL
    """
    if "captcha" in html.lower() and "Type the characters you see" in html:
        return None, None, None, "CAPTCHA"

    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=True)

    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]+)", text)
    if not matches:
        if "Sorry! We couldn't find that page" in html or "Page Not Found" in html:
            return None, None, None, "NOT_FOUND"
        return None, None, None, "PARSE_FAIL"

    ranks: List[Tuple[int, str]] = []
    for rank_raw, cat_raw in matches:
        rank_num = rank_raw.replace(",", "").strip()
        cat = re.sub(r"\s+See Top.*$", "", cat_raw.strip(), flags=re.IGNORECASE).strip()
        cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
        if rank_num.isdigit():
            ranks.append((int(rank_num), cat))

    if not ranks:
        return None, None, None, "PARSE_FAIL"

    bsr_main, bsr_main_cat = ranks[0]
    bsr_all = ";".join(f"{r}|{c}" for r, c in ranks)
    return bsr_main, bsr_main_cat, bsr_all, "OK_MULTI"


# ---------------------------------------------------------------------------
# Celery tasks
# ---------------------------------------------------------------------------

@celery.task(name="app.tasks.bsr.scrape_all_bsr")
def scrape_all_bsr():
    """Beat task: query all users with active ASINs and dispatch per-user jobs."""
    db: Session = SessionLocal()
    try:
        user_ids = (
            db.query(ASIN.user_id)
            .filter(ASIN.is_active == True)
            .distinct()
            .all()
        )
        count = 0
        for (uid,) in user_ids:
            scrape_bsr_for_user.delay(str(uid))
            count += 1
        log.info("scrape_all_bsr dispatched %d user jobs", count)
        return {"dispatched": count}
    finally:
        db.close()


@celery.task(name="app.tasks.bsr.scrape_bsr_for_user", bind=True, max_retries=2)
def scrape_bsr_for_user(self, user_id: str):
    """
    Scrape current BSR for every active ASIN belonging to user_id.
    Writes results to BSRHistory and logs the job in JobLog.
    """
    db: Session = SessionLocal()
    job = JobLog(
        id=uuid.uuid4(),
        user_id=uuid.UUID(user_id),
        job_type="bsr_scrape",
        status=JobStatus.running,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()

    try:
        asins = (
            db.query(ASIN)
            .filter(ASIN.user_id == uuid.UUID(user_id), ASIN.is_active == True)
            .all()
        )

        ok_count = 0
        fail_count = 0

        # Scrape all ASINs in parallel (each worker gets its own browser instance)
        with ThreadPoolExecutor(max_workers=min(SCRAPE_WORKERS, len(asins) or 1)) as pool:
            futures = {pool.submit(_scrape_one, a): a for a in asins}
            for future in as_completed(futures):
                res = future.result()
                entry = BSRHistory(
                    asin_id=res["asin_id"],
                    bsr_rank=res["bsr_main"],
                    category=res["bsr_main_cat"],
                    sub_rank=res["sub_rank"],
                    sub_category=res["sub_category"],
                    captured_at=datetime.now(timezone.utc),
                )
                db.add(entry)
                if res["scrape_status"].startswith("OK"):
                    ok_count += 1
                else:
                    fail_count += 1

        db.commit()

        job.status = JobStatus.done
        job.completed_at = datetime.now(timezone.utc)
        db.commit()

        log.info(
            "scrape_bsr_for_user user=%s ok=%d fail=%d",
            user_id, ok_count, fail_count,
        )
        return {"ok": ok_count, "fail": fail_count}

    except Exception as exc:
        db.rollback()
        job.status = JobStatus.failed
        job.error_message = str(exc)
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        raise self.retry(exc=exc, countdown=60)
    finally:
        db.close()
