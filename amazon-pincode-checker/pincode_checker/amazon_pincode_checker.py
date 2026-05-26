#!/usr/bin/env python3
"""
Amazon.in ASIN x Pincode availability checker.

What it does
------------
- Opens Amazon.in in a persistent Playwright browser profile.
- Sets the delivery pincode.
- Visits each ASIN product page.
- Captures whether the product appears available.
- Captures whether the buy box / offer appears Fulfilled by Amazon.
- Captures the delivery promise text and classifies it into same_day / next_day / other / unavailable.
- Exports results to CSV.

Why Playwright + persistent profile?
-----------------------------------
Delivery promises on Amazon.in depend on location, cookies, inventory, and often Prime/login state.
Using a persistent profile makes the result far more stable than stateless scraping.

Usage example
-------------
1) Install dependencies:
   pip install playwright
   playwright install chromium

2) Put your ASINs in asins.csv (column name: asin)
   Put your pincodes in pincodes.csv (column name: pincode)

3) Run:
   python amazon_pincode_checker.py \
       --asins asins.csv \
       --pincodes pincodes.csv \
       --output amazon_availability_report.csv \
       --profile-dir ./amazon_profile

On the first run, the browser opens in headful mode. Log into Amazon.in manually if needed.
Then rerun or continue.

Notes
-----
- Amazon can show CAPTCHAs or alternate DOMs. This script uses several selector fallbacks but may still need minor tuning.
- For best results, use a Prime account if your goal is same-day / next-day promise analysis.
- Keep concurrency low to reduce blocking risk.
"""

from __future__ import annotations

import argparse
import csv
import random
import re
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, List, Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import Page, sync_playwright

AMAZON_BASE = "https://www.amazon.in"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

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

UNAVAILABLE_SELECTORS = [
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


@dataclass
class CheckResult:
    asin: str
    pincode: str
    url: str
    title: str
    is_buyable: bool
    availability_text: str
    amazon_fulfilled: bool
    merchant_text: str
    delivery_type: str
    delivery_text: str
    captcha_seen: bool
    error: str


def read_single_column_csv(path: Path, expected_names: Iterable[str]) -> List[str]:
    expected = {name.lower() for name in expected_names}
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError(f"{path} has no header row")
        lower_map = {name.lower(): name for name in reader.fieldnames}
        matched = next((lower_map[name] for name in expected if name in lower_map), None)
        if not matched:
            raise ValueError(
                f"{path} must contain one of these headers: {', '.join(sorted(expected))}"
            )
        values: List[str] = []
        for row in reader:
            raw = (row.get(matched) or "").strip()
            if raw:
                values.append(raw)
        return values


def first_visible(page: Page, selectors: List[str], timeout_ms: int = 4000):
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


def safe_text(page: Page, selectors: List[str]) -> str:
    texts: List[str] = []
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


def looks_like_captcha(page: Page) -> bool:
    text = page.locator("body").inner_text(timeout=2000)[:5000]
    patterns = [
        r"Enter the characters you see below",
        r"Type the characters you see in this image",
        r"Sorry, we just need to make sure you're not a robot",
        r"To discuss automated access to Amazon data",
    ]
    return any(re.search(p, text, re.I) for p in patterns)


def classify_delivery(delivery_text: str, buyable: bool) -> str:
    if not buyable:
        return "unavailable"
    cleaned = delivery_text.strip()
    if not cleaned:
        return "unknown"
    for pattern, label in DELIVERY_CLASSIFIERS:
        if pattern.search(cleaned):
            return label
    return "other"


def human_sleep(base: float = 1.2, jitter: float = 0.8) -> None:
    time.sleep(base + random.random() * jitter)


def open_location_popover(page: Page) -> bool:
    loc = first_visible(page, LOCATION_OPEN_SELECTORS, timeout_ms=6000)
    if not loc:
        return False
    try:
        loc.click(timeout=3000)
        human_sleep(1.0, 0.7)
        return True
    except Exception:
        return False


def set_pincode(page: Page, pincode: str) -> bool:
    page.goto(AMAZON_BASE, wait_until="domcontentloaded", timeout=60000)
    human_sleep(1.0, 0.5)

    if not open_location_popover(page):
        return False

    input_box = first_visible(page, PINCODE_INPUT_SELECTORS, timeout_ms=7000)
    if not input_box:
        return False

    try:
        input_box.click(timeout=2000)
        input_box.fill("")
        input_box.type(pincode, delay=80)
    except Exception:
        return False

    apply_btn = first_visible(page, PINCODE_APPLY_SELECTORS, timeout_ms=5000)
    if not apply_btn:
        return False

    try:
        apply_btn.click(timeout=3000)
    except Exception:
        return False

    human_sleep(2.0, 1.0)

    # Some variants show an extra continue/done button after applying the pincode.
    for text in ["Continue", "Done", "Apply", "Confirm"]:
        try:
            btn = page.get_by_role("button", name=re.compile(text, re.I)).first
            if btn.count() > 0 and btn.is_visible():
                btn.click(timeout=2000)
                human_sleep(1.0, 0.6)
                break
        except Exception:
            pass

    # Soft validation: confirm the pincode appears somewhere on page.
    try:
        body = page.locator("body").inner_text(timeout=2500)
        if pincode in body:
            return True
    except Exception:
        pass

    return True  # We return True even if soft validation is inconclusive.


def extract_title(page: Page) -> str:
    try:
        title = page.locator("#productTitle").inner_text(timeout=3000).strip()
        return re.sub(r"\s+", " ", title)
    except Exception:
        return ""


def extract_availability_text(page: Page) -> str:
    text = safe_text(page, UNAVAILABLE_SELECTORS + ["#availability", "#outOfStock", "#availabilityInsideBuyBox_feature_div"])
    if text:
        return text
    return ""


def is_buyable_from_text(text: str) -> bool:
    lowered = text.lower()
    negative_patterns = [
        "currently unavailable",
        "temporarily out of stock",
        "not deliverable",
        "cannot be delivered",
        "we don't know when or if this item will be back",
        "this item cannot be dispatched",
    ]
    if any(p in lowered for p in negative_patterns):
        return False
    return True


def extract_merchant_text(page: Page) -> str:
    return safe_text(page, AMAZON_FULFILLED_SELECTORS)


def is_amazon_fulfilled(merchant_text: str, full_page_text: str) -> bool:
    haystack = f"{merchant_text}\n{full_page_text}".lower()
    positive_patterns = [
        "fulfilled by amazon",
        "ships from amazon",
        "dispatched from amazon",
        "amazon fulfilled",
    ]
    return any(p in haystack for p in positive_patterns)


def extract_delivery_text(page: Page) -> str:
    text = safe_text(page, DELIVERY_TEXT_SELECTORS)
    if text:
        return text

    # Fallback: scan body for common promise phrases.
    try:
        body = page.locator("body").inner_text(timeout=2500)
    except Exception:
        return ""

    matches = []
    patterns = [
        r"(?:FREE )?(?:Same-Day|One-Day|Two-Day) Delivery",
        r"Today by [^\n\.]{1,40}",
        r"Tomorrow by [^\n\.]{1,40}",
        r"FREE delivery [^\n\.]{1,80}",
        r"Fastest delivery [^\n\.]{1,80}",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, body, re.I):
            matches.append(match.group(0).strip())
    return " | ".join(dict.fromkeys(matches))[:500]


def check_asin(page: Page, asin: str, pincode: str) -> CheckResult:
    url = f"{AMAZON_BASE}/dp/{asin}"
    error = ""
    captcha_seen = False
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        human_sleep(1.8, 1.0)
    except Exception as exc:
        return CheckResult(
            asin=asin,
            pincode=pincode,
            url=url,
            title="",
            is_buyable=False,
            availability_text="",
            amazon_fulfilled=False,
            merchant_text="",
            delivery_type="error",
            delivery_text="",
            captcha_seen=False,
            error=f"navigation_error: {exc}",
        )

    if looks_like_captcha(page):
        captcha_seen = True
        error = "captcha_seen"

    title = extract_title(page)
    availability_text = extract_availability_text(page)
    buyable = is_buyable_from_text(availability_text)

    try:
        body_text = page.locator("body").inner_text(timeout=2500)
    except Exception:
        body_text = ""

    merchant_text = extract_merchant_text(page)
    amazon_fulfilled = is_amazon_fulfilled(merchant_text, body_text)
    delivery_text = extract_delivery_text(page)
    delivery_type = classify_delivery(delivery_text, buyable)

    # Secondary guard: if page explicitly says unavailable in body, trust that.
    if re.search(r"currently unavailable|temporarily out of stock", body_text, re.I):
        buyable = False
        if not availability_text:
            availability_text = "Currently unavailable"
        delivery_type = "unavailable"

    return CheckResult(
        asin=asin,
        pincode=pincode,
        url=url,
        title=title,
        is_buyable=buyable,
        availability_text=availability_text,
        amazon_fulfilled=amazon_fulfilled,
        merchant_text=merchant_text,
        delivery_type=delivery_type,
        delivery_text=delivery_text,
        captcha_seen=captcha_seen,
        error=error,
    )


def write_results(path: Path, results: List[CheckResult]) -> None:
    fieldnames = list(asdict(results[0]).keys()) if results else list(CheckResult.__dataclass_fields__.keys())
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow(asdict(row))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check Amazon.in ASIN availability by pincode")
    parser.add_argument("--asins", required=True, help="CSV file with 'asin' column")
    parser.add_argument("--pincodes", required=True, help="CSV file with 'pincode' column")
    parser.add_argument("--output", default="amazon_availability_report.csv", help="Output CSV path")
    parser.add_argument("--profile-dir", default="./amazon_profile", help="Persistent browser profile directory")
    parser.add_argument("--headless", action="store_true", help="Run headless (not recommended for first run)")
    parser.add_argument("--max-asins", type=int, default=0, help="Optional cap for testing")
    parser.add_argument("--max-pincodes", type=int, default=0, help="Optional cap for testing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    asin_path = Path(args.asins)
    pin_path = Path(args.pincodes)
    output_path = Path(args.output)
    profile_dir = Path(args.profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)

    asins = read_single_column_csv(asin_path, ["asin", "ASIN"])
    pincodes = read_single_column_csv(pin_path, ["pincode", "pin", "zipcode", "postal_code"])

    if args.max_asins > 0:
        asins = asins[: args.max_asins]
    if args.max_pincodes > 0:
        pincodes = pincodes[: args.max_pincodes]

    if not asins:
        raise ValueError("No ASINs found")
    if not pincodes:
        raise ValueError("No pincodes found")

    results: List[CheckResult] = []

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=args.headless,
            viewport={"width": 1440, "height": 1200},
            user_agent=USER_AGENT,
            locale="en-IN",
            timezone_id="Asia/Kolkata",
            ignore_https_errors=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        )
        page = browser.new_page()
        page.set_default_timeout(25000)

        print("If Amazon asks you to sign in or solve a CAPTCHA, do it in the opened browser window.")
        print("Once the homepage is stable, the script will continue.")

        for idx_pin, pincode in enumerate(pincodes, start=1):
            print(f"\n[{idx_pin}/{len(pincodes)}] Setting pincode: {pincode}")
            ok = set_pincode(page, pincode)
            if not ok:
                print(f"WARNING: could not confidently set pincode {pincode}; continuing anyway")

            human_sleep(1.5, 1.0)

            for idx_asin, asin in enumerate(asins, start=1):
                print(f"  - [{idx_asin}/{len(asins)}] Checking ASIN {asin}")
                result = check_asin(page, asin, pincode)
                results.append(result)

                # Save progressively so a partial run is still useful.
                write_results(output_path, results)
                human_sleep(2.0, 1.5)

        browser.close()

    print(f"\nDone. Results saved to: {output_path.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted by user")
        raise SystemExit(130)
    except Exception as exc:
        print(f"Fatal error: {exc}", file=sys.stderr)
        raise SystemExit(1)
