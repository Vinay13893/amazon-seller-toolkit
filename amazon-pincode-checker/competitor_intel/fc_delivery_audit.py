"""
FC Delivery Audit — Us vs Competitors: Who delivers faster?
============================================================
Checks Amazon.in delivery promise for:
  - Our best ASIN per category
  - Top competitor ASINs (from SERP audit output or keywords_config.py seeds)

At 10 major Indian pincodes.

Output:
  - competitor_intel/output/fc_delivery_audit_YYYY-MM-DD.csv
  - Console report with side-by-side comparison

Run:
    cd e:\\amazon-bsr-tracker\\amazon-pincode-checker
    & amazon_ads_tool\.venv\Scripts\Activate.ps1
    python competitor_intel/fc_delivery_audit.py

    # Use competitor dominance CSV from SERP audit:
    python competitor_intel/fc_delivery_audit.py --from-serp-output
"""

import argparse
import csv
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

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
from competitor_intel.keywords_config import (
    CATEGORY_KEYWORDS, FC_PINCODES, OUR_BEST_ASIN_PER_CATEGORY
)

TODAY = datetime.now().strftime("%Y-%m-%d")
PROFILE_DIR = os.path.join(PARENT_DIR, "amazon_profile")
BASE_URL = "https://www.amazon.in"
HEADLESS = False
DELAY_BETWEEN_CHECKS = 1.2

# Speed buckets
SPEED_ORDER = ["same_day", "next_day", "2_days", "3_5_days", "slow", "unavailable", "unknown"]
SPEED_LABEL = {
    "same_day":    "Same Day",
    "next_day":    "Tomorrow",
    "2_days":      "2 Days",
    "3_5_days":    "3–5 Days",
    "slow":        "6+ Days",
    "unavailable": "UNAVAILABLE",
    "unknown":     "Unknown",
}
SPEED_SCORE = {k: i for i, k in enumerate(SPEED_ORDER)}


def classify_delivery(text):
    """Classify a delivery promise string into a speed bucket."""
    if not text:
        return "unknown"
    t = text.lower()
    if any(x in t for x in ["unavailable", "currently unavailable", "out of stock", "not available"]):
        return "unavailable"
    if any(x in t for x in ["today", "same day", "tonight"]):
        return "same_day"
    if any(x in t for x in ["tomorrow", "next day"]):
        return "next_day"
    # "Delivery in 2 days" or "by <day after tomorrow>"
    m = re.search(r"in (\d+) day", t)
    if m:
        days = int(m.group(1))
        if days <= 1:
            return "next_day"
        elif days == 2:
            return "2_days"
        elif days <= 5:
            return "3_5_days"
        else:
            return "slow"
    # Look for day names (Mon, Tue, ... as proxies)
    # Check for specific date mentions like "25 May" — compute approximate days
    return "unknown"


def set_pincode(page, pincode):
    """Set delivery pincode on Amazon.in."""
    try:
        # Click the "Deliver to" link to open pincode dialog
        deliver_loc = page.locator("#nav-global-location-popover-link, [data-csa-c-slot-id='nav-location']")
        if deliver_loc.count() > 0:
            deliver_loc.first.click(timeout=3000)
            time.sleep(1.0)

        # Try pincode input field
        selectors = [
            "#GLUXZipUpdateInput",
            "input[aria-label*='pincode' i]",
            "input[placeholder*='PIN' i]",
        ]
        input_elem = None
        for sel in selectors:
            loc = page.locator(sel)
            if loc.count() > 0:
                input_elem = loc.first
                break
        if not input_elem:
            return False

        input_elem.click(timeout=2000)
        input_elem.fill("")
        input_elem.type(pincode, delay=50)
        time.sleep(0.5)

        # Submit
        submit_selectors = [
            "#GLUXZipUpdate input[type='submit']",
            "input.a-button-input[type='submit']",
            "span.a-button-inner input",
        ]
        for sel in submit_selectors:
            loc = page.locator(sel)
            if loc.count() > 0:
                loc.first.click(timeout=2000)
                break

        time.sleep(2.0)
        return True
    except Exception:
        return False


def get_delivery_promise(page, asin, pincode):
    """
    Visit ASIN product page and extract delivery promise.
    Returns (delivery_text, speed_bucket)
    """
    url = f"{BASE_URL}/dp/{asin}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)
        time.sleep(1.5)
    except Exception as e:
        return f"Error: {e}", "unknown"

    # Set pincode if needed (check current pincode)
    try:
        current_pin = page.locator("#glow-ingress-line2, #contextualIngressPtLabel_deliveryShortLine").inner_text(timeout=2000)
        if pincode not in current_pin:
            set_pincode(page, pincode)
            time.sleep(1.5)
    except Exception:
        pass

    # Extract delivery promise
    delivery_selectors = [
        "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span.a-text-bold",
        "#deliveryMessageMirWidget span.a-text-bold",
        "#dynamicDeliveryMessage span.a-text-bold",
        "#ddmDeliveryMessage .a-color-success",
        "#delivery-message span",
        ".a-color-success.a-text-bold",
        "#deliveryBlockMessage",
        "#outOfStock",
    ]

    delivery_text = ""
    for sel in delivery_selectors:
        loc = page.locator(sel)
        if loc.count() > 0:
            text = clean_text(loc.first.inner_text(timeout=1500))
            if text and len(text) > 3:
                delivery_text = text
                break

    if not delivery_text:
        # Fallback: search page text for delivery pattern
        try:
            body = page.locator("#availability, #deliveryMessageMirWidget, #mir-layout-DELIVERY_BLOCK").first
            delivery_text = clean_text(body.inner_text(timeout=2000))[:100]
        except Exception:
            delivery_text = "not found"

    speed = classify_delivery(delivery_text)
    return delivery_text, speed


def clean_text(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def load_competitor_asins_from_serp():
    """Load top competitor ASINs from the most recent serp competitor_dominance CSV."""
    pattern = os.path.join(OUTPUT_DIR, "competitor_dominance_*.csv")
    import glob
    files = sorted(glob.glob(pattern), reverse=True)
    if not files:
        return {}

    competitors_per_category = defaultdict(list)
    with open(files[0], newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            bought = int(row.get("bought_last_month", 0) or 0)
            if bought < 100:
                continue
            cats = row.get("categories", "").split("|")
            for cat in cats:
                cat = cat.strip()
                if cat:
                    competitors_per_category[cat].append({
                        "asin": row["asin"],
                        "brand": row.get("brand", ""),
                        "bought": bought,
                    })

    # Top 3 per category by bought count
    result = {}
    for cat, comps in competitors_per_category.items():
        comps_sorted = sorted(comps, key=lambda x: -x["bought"])[:3]
        result[cat] = [(c["asin"], c.get("brand", "")) for c in comps_sorted]
    return result


def build_asin_list(use_serp_output):
    """Build the final list of ASINs to check: (asin, label, category, is_ours)."""
    asins = []

    # Our ASINs
    for cat, asin in OUR_BEST_ASIN_PER_CATEGORY.items():
        asins.append({
            "asin": asin,
            "label": f"US ({cat})",
            "category": cat,
            "is_ours": True,
            "brand": "eHomekart/LilToes",
        })

    # Competitor ASINs
    if use_serp_output:
        comp_map = load_competitor_asins_from_serp()
        for cat, comps in comp_map.items():
            for asin, brand in comps:
                asins.append({
                    "asin": asin,
                    "label": f"Comp ({cat})",
                    "category": cat,
                    "is_ours": False,
                    "brand": brand,
                })
    else:
        # Use seeded known competitors from config
        for cat_key, cat_config in CATEGORY_KEYWORDS.items():
            for asin, brand in cat_config.get("known_competitors", []):
                asins.append({
                    "asin": asin,
                    "label": f"Comp ({cat_key})",
                    "category": cat_key,
                    "is_ours": False,
                    "brand": brand,
                })

    return asins


def main():
    parser = argparse.ArgumentParser(description="FC Delivery Audit")
    parser.add_argument("--from-serp-output", action="store_true",
                        help="Load competitor ASINs from SERP audit output CSV")
    parser.add_argument("--pincodes", nargs="+", help="Override pincode list (city:pincode ...)")
    args = parser.parse_args()

    pincodes = FC_PINCODES
    if args.pincodes:
        pincodes = []
        for p in args.pincodes:
            parts = p.split(":")
            pincodes.append((parts[0], parts[1]) if len(parts) == 2 else (p, p))

    asin_list = build_asin_list(use_serp_output=args.from_serp_output)

    print("=" * 70)
    print("  EMOUNT VENTURES — FC DELIVERY AUDIT")
    print(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} IST")
    print(f"  ASINs: {len(asin_list)} | Pincodes: {len(pincodes)}")
    print(f"  Total checks: {len(asin_list) * len(pincodes)}")
    print("=" * 70)

    results = []  # list of dicts: asin, label, category, is_ours, brand, city, pincode, delivery_text, speed

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=HEADLESS,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 800},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        for pin_city, pincode in pincodes:
            print(f"\n── Pincode: {pin_city} ({pincode}) ──────────────────────────────")
            # Navigate home and set pincode once
            try:
                page.goto(BASE_URL, wait_until="domcontentloaded", timeout=15000)
                time.sleep(1)
                set_pincode(page, pincode)
            except Exception:
                pass

            for item in asin_list:
                asin = item["asin"]
                delivery_text, speed = get_delivery_promise(page, asin, pincode)
                label = "🏠 US" if item["is_ours"] else "🔴 CO"
                speed_label = SPEED_LABEL.get(speed, speed)
                brand = item.get("brand", "")[:20]
                print(f"  {label} {asin} [{item['category']:<10}] {brand:<20} → {speed_label} | {delivery_text[:50]}")

                results.append({
                    "asin": asin,
                    "is_ours": item["is_ours"],
                    "label": item["label"],
                    "category": item["category"],
                    "brand": item.get("brand", ""),
                    "city": pin_city,
                    "pincode": pincode,
                    "delivery_text": delivery_text,
                    "speed": speed,
                    "speed_score": SPEED_SCORE.get(speed, 99),
                })
                time.sleep(DELAY_BETWEEN_CHECKS)

        ctx.close()

    # ── Save CSV ─────────────────────────────────────────────────────────────
    out_csv = os.path.join(OUTPUT_DIR, f"fc_delivery_audit_{TODAY}.csv")
    if results:
        fields = ["asin", "is_ours", "label", "category", "brand", "city", "pincode",
                  "delivery_text", "speed", "speed_score"]
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(results)
        print(f"\n✅ CSV saved: {out_csv}")

    # ── Summary: average speed score per ASIN ────────────────────────────────
    print(f"\n{'=' * 70}")
    print("  DELIVERY SPEED SUMMARY (avg across all pincodes)")
    print(f"{'=' * 70}")

    asin_scores = defaultdict(list)
    asin_meta = {}
    for r in results:
        asin_scores[r["asin"]].append(r["speed_score"])
        asin_meta[r["asin"]] = {
            "is_ours": r["is_ours"], "category": r["category"],
            "brand": r["brand"], "label": r["label"],
        }

    # Group by category
    by_cat = defaultdict(list)
    for asin, scores in asin_scores.items():
        avg = sum(scores) / len(scores)
        meta = asin_meta[asin]
        by_cat[meta["category"]].append((asin, avg, meta))

    for cat in sorted(by_cat.keys()):
        entries = sorted(by_cat[cat], key=lambda x: x[1])
        print(f"\n  📦 {cat}")
        print(f"  {'ASIN':<14} {'Brand':<22} {'Who':<6} {'Avg Speed':>10}  {'Pincodes Breakdown'}")
        print(f"  {'-'*14} {'-'*22} {'-'*6} {'-'*10}  {'-'*30}")
        for asin, avg_score, meta in entries:
            speed_counts = Counter(
                r["speed"] for r in results if r["asin"] == asin
            )
            breakdown = "  ".join(
                f"{SPEED_LABEL[sp]}:{cnt}"
                for sp, cnt in sorted(speed_counts.items(), key=lambda x: SPEED_SCORE.get(x[0], 99))
                if cnt > 0
            )
            who = "🏠 US" if meta["is_ours"] else "🔴 CO"
            avg_label = SPEED_LABEL.get(SPEED_ORDER[min(int(avg_score), len(SPEED_ORDER)-1)], "?")
            print(f"  {asin:<14} {meta['brand'][:22]:<22} {who:<6} {avg_label:>10}  {breakdown}")

    # ── FC Gap Alert ─────────────────────────────────────────────────────────
    print(f"\n{'─' * 70}")
    print("  FC COVERAGE GAP ANALYSIS")
    print(f"{'─' * 70}")

    for cat in sorted(by_cat.keys()):
        entries = by_cat[cat]
        our_entries = [(a, s, m) for a, s, m in entries if m["is_ours"]]
        comp_entries = [(a, s, m) for a, s, m in entries if not m["is_ours"]]
        if not our_entries or not comp_entries:
            continue

        our_avg = sum(s for _, s, _ in our_entries) / len(our_entries)
        comp_avg = sum(s for _, s, _ in comp_entries) / len(comp_entries)
        gap = our_avg - comp_avg  # positive = we're slower

        if gap > 0.5:
            print(f"\n  🚨 {cat}: We are SLOWER than competitors")
            print(f"     Our avg speed score: {our_avg:.1f}  |  Competitor avg: {comp_avg:.1f}")
            print(f"     → Action: Request more FBA inventory allocation to cover key FCs")
            print(f"     → Check FBA replenishment plan — push stock to DL7/BOM7/MAA5/HYD1")
        elif gap < -0.5:
            print(f"\n  ✅ {cat}: We are FASTER than competitors (advantage!)")
        else:
            print(f"\n  ≈  {cat}: Delivery speed roughly equal to competitors")

    print(f"\n{'=' * 70}")


if __name__ == "__main__":
    main()
