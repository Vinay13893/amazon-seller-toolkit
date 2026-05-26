"""
Placement Audit — Where are our ads showing?
=============================================
Pulls SP Placement report from Amazon Ads API and shows:
  - Spend / impressions / clicks / ROAS broken down by:
    TOP OF SEARCH  |  REST OF SEARCH  |  PRODUCT PAGES
  - Per category breakdown
  - Bid adjustment recommendations (where to increase top-of-search multiplier)

Run:
    cd e:\\amazon-bsr-tracker\\amazon-pincode-checker
    & amazon_ads_tool\.venv\Scripts\Activate.ps1
    python competitor_intel/placement_audit.py
"""

import os
import sys
import json
from datetime import datetime, timedelta
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

sys.path.insert(0, PARENT_DIR)

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
from amazon_ads_tool.reports import ReportManager

# Load category config
sys.path.insert(0, os.path.join(PARENT_DIR, "category_analysis"))
try:
    from categories import classify_campaign, CATEGORIES
except ImportError:
    CATEGORIES = {}
    def classify_campaign(name): return "UNCATEGORIZED"

LOOKBACK_DAYS = 30


def _rupees(val):
    return f"₹{val:,.0f}"


def _pct(val):
    return f"{val:.1f}%"


def _roas(spend, sales):
    if spend == 0:
        return 0.0
    return sales / spend


PLACEMENT_LABELS = {
    # Actual API v3 placementClassification values
    "Top of Search on-Amazon": "TOP of Search",
    "Other on-Amazon": "Rest of Search",
    "Detail Page on-Amazon": "Product Pages",
    # Legacy / alternate strings
    "PLACEMENT_TOP": "TOP of Search",
    "PLACEMENT_REST_OF_SEARCH": "Rest of Search",
    "PLACEMENT_PRODUCT_PAGE": "Product Pages",
    "Top of search (first page)": "TOP of Search",
    "Rest of search": "Rest of Search",
    "Product pages": "Product Pages",
    "HOME": "Home Page",
}


def normalize_placement(raw):
    return PLACEMENT_LABELS.get(raw, raw or "Unknown")


def main():
    print("=" * 70)
    print("  EMOUNT VENTURES — SP PLACEMENT AUDIT")
    print(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} IST")
    print(f"  Period: Last {LOOKBACK_DAYS} days")
    print("=" * 70)

    # ── Pull data ────────────────────────────────────────────────────────────
    print("\nConnecting to Amazon Ads API...")
    config = load_config()
    client = AmazonAdsClient(config)
    rm = ReportManager(client, config)

    end_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")

    print(f"Requesting SP Placement report ({start_date} → {end_date})...")
    try:
        data = rm.download_report("sp_placement", start_date=start_date, end_date=end_date)
    except Exception as e:
        print(f"\n❌ Failed to pull placement report: {e}")
        sys.exit(1)

    if not data:
        print("No data returned.")
        sys.exit(0)

    print(f"✅ Got {len(data)} rows\n")

    # ── Aggregate: category → placement → metrics ────────────────────────────
    # Structure: { category: { placement: {impressions, clicks, cost, orders, sales} } }
    cat_place = defaultdict(lambda: defaultdict(lambda: {
        "impressions": 0, "clicks": 0, "cost": 0.0, "orders": 0, "sales": 0.0
    }))

    # Also: overall (all categories combined)
    for row in data:
        campaign = row.get("campaignName", "")
        cat = classify_campaign(campaign)
        # API v3 returns placement as "placementClassification"
        placement = normalize_placement(
            row.get("placementClassification", row.get("campaignPlacement", row.get("placement", "")))
        )

        imps = int(row.get("impressions", 0) or 0)
        clicks = int(row.get("clicks", 0) or 0)
        cost = float(row.get("cost", 0) or 0)
        orders = int(row.get("purchases1d", 0) or 0)
        sales = float(row.get("sales1d", 0) or 0)

        cat_place[cat][placement]["impressions"] += imps
        cat_place[cat][placement]["clicks"] += clicks
        cat_place[cat][placement]["cost"] += cost
        cat_place[cat][placement]["orders"] += orders
        cat_place[cat][placement]["sales"] += sales

    # Save raw data as JSON for reference
    out_json = os.path.join(OUTPUT_DIR, f"placement_raw_{end_date}.json")
    with open(out_json, "w") as f:
        json.dump(data, f, indent=2)

    PLACEMENT_ORDER = ["TOP of Search", "Rest of Search", "Product Pages"]

    # ── Print per-category breakdown ─────────────────────────────────────────
    all_categories = sorted(cat_place.keys())
    for cat in all_categories:
        cat_display = CATEGORIES.get(cat, {}).get("display_name", cat) if CATEGORIES else cat
        print(f"\n{'─' * 70}")
        print(f"  📦 {cat_display}  ({cat})")
        print(f"{'─' * 70}")

        placements = cat_place[cat]
        # total for this category
        total_cost = sum(p["cost"] for p in placements.values())
        total_sales = sum(p["sales"] for p in placements.values())
        total_clicks = sum(p["clicks"] for p in placements.values())
        total_imps = sum(p["impressions"] for p in placements.values())

        target_acos = CATEGORIES.get(cat, {}).get("target_acos", 20.0) if CATEGORIES else 20.0

        print(f"  {'Placement':<24} {'Spend':>10} {'%Spend':>8} {'Sales':>10} {'ROAS':>6} {'ACoS':>7} {'Clicks':>7} {'Imps':>9} {'CTR':>6}")
        print(f"  {'-'*24} {'-'*10} {'-'*8} {'-'*10} {'-'*6} {'-'*7} {'-'*7} {'-'*9} {'-'*6}")

        for place_name in PLACEMENT_ORDER:
            m = placements.get(place_name)
            if not m:
                continue
            spend = m["cost"]
            sales = m["sales"]
            clicks = m["clicks"]
            imps = m["impressions"]

            pct_spend = (spend / total_cost * 100) if total_cost > 0 else 0
            roas = _roas(spend, sales)
            acos = (spend / sales * 100) if sales > 0 else 0
            ctr = (clicks / imps * 100) if imps > 0 else 0

            # Flag if top-of-search has better/worse ROAS vs target
            flag = ""
            if place_name == "TOP of Search" and spend > 0:
                if acos > 0 and acos <= target_acos:
                    flag = " ✅"
                elif acos > target_acos * 1.5:
                    flag = " ⚠️"

            print(f"  {place_name + flag:<24} {_rupees(spend):>10} {_pct(pct_spend):>8} "
                  f"{_rupees(sales):>10} {roas:>6.1f}x {_pct(acos):>7} "
                  f"{clicks:>7,} {imps:>9,} {_pct(ctr):>6}")

        # Total row
        total_roas = _roas(total_cost, total_sales)
        total_acos = (total_cost / total_sales * 100) if total_sales > 0 else 0
        total_ctr = (total_clicks / total_imps * 100) if total_imps > 0 else 0
        print(f"  {'TOTAL':<24} {_rupees(total_cost):>10} {'100.0%':>8} "
              f"{_rupees(total_sales):>10} {total_roas:>6.1f}x {_pct(total_acos):>7} "
              f"{total_clicks:>7,} {total_imps:>9,} {_pct(total_ctr):>6}")

        # ── Recommendations ──────────────────────────────────────────────────
        top_m = placements.get("TOP of Search", {})
        rest_m = placements.get("Rest of Search", {})
        pages_m = placements.get("Product Pages", {})

        top_acos = (top_m.get("cost", 0) / top_m.get("sales", 1) * 100) if top_m.get("sales", 0) > 0 else 999
        rest_acos = (rest_m.get("cost", 0) / rest_m.get("sales", 1) * 100) if rest_m.get("sales", 0) > 0 else 999

        recs = []
        if top_m.get("cost", 0) > 0 and top_acos < target_acos:
            top_pct = (top_m["cost"] / total_cost * 100) if total_cost > 0 else 0
            if top_pct < 40:
                recs.append(f"➕ TOP of Search profitable (ACoS {_pct(top_acos)} < target {_pct(target_acos)}) "
                            f"but only {_pct(top_pct)} of spend → INCREASE top-of-search bid multiplier")
        if top_acos > target_acos * 1.5 and top_m.get("cost", 0) > 0:
            recs.append(f"⬇️  TOP of Search over-spending (ACoS {_pct(top_acos)} vs target {_pct(target_acos)}) → REDUCE top-of-search multiplier")
        if pages_m.get("cost", 0) > 0:
            pages_acos = (pages_m["cost"] / pages_m.get("sales", 1) * 100) if pages_m.get("sales", 0) > 0 else 999
            pages_pct = (pages_m["cost"] / total_cost * 100) if total_cost > 0 else 0
            if pages_acos > target_acos * 2 and pages_pct > 20:
                recs.append(f"⬇️  Product Pages wasting {_pct(pages_pct)} of budget at {_pct(pages_acos)} ACoS → REDUCE product pages multiplier")
            elif pages_acos < target_acos and pages_pct < 20:
                recs.append(f"➕ Product Pages profitable (ACoS {_pct(pages_acos)}) but low share → INCREASE product pages multiplier")
        if top_m.get("impressions", 0) == 0 and total_imps > 0:
            recs.append("🚨 ZERO impressions at TOP of Search — check bids are competitive, add top-of-search multiplier 50-100%")

        if recs:
            print()
            for r in recs:
                print(f"  {r}")

    # ── Overall Summary ──────────────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print("  OVERALL PLACEMENT SUMMARY (All Categories)")
    print(f"{'=' * 70}")

    overall = defaultdict(lambda: {"impressions": 0, "clicks": 0, "cost": 0.0, "orders": 0, "sales": 0.0})
    for cat_data in cat_place.values():
        for place_name, m in cat_data.items():
            for k in overall[place_name]:
                overall[place_name][k] += m[k]

    grand_cost = sum(m["cost"] for m in overall.values())
    grand_sales = sum(m["sales"] for m in overall.values())

    print(f"\n  {'Placement':<24} {'Spend':>10} {'%Spend':>8} {'Sales':>10} {'ROAS':>6} {'ACoS':>7}")
    print(f"  {'-'*24} {'-'*10} {'-'*8} {'-'*10} {'-'*6} {'-'*7}")
    for place_name in PLACEMENT_ORDER:
        m = overall.get(place_name)
        if not m or m["cost"] == 0:
            continue
        pct_spend = (m["cost"] / grand_cost * 100) if grand_cost > 0 else 0
        roas = _roas(m["cost"], m["sales"])
        acos = (m["cost"] / m["sales"] * 100) if m["sales"] > 0 else 0
        print(f"  {place_name:<24} {_rupees(m['cost']):>10} {_pct(pct_spend):>8} "
              f"{_rupees(m['sales']):>10} {roas:>6.1f}x {_pct(acos):>7}")
    print(f"  {'TOTAL':<24} {_rupees(grand_cost):>10} {'100.0%':>8} "
          f"{_rupees(grand_sales):>10} {_roas(grand_cost, grand_sales):>6.1f}x "
          f"{_pct((grand_cost/grand_sales*100) if grand_sales > 0 else 0):>7}")

    print(f"\n✅ Raw placement data saved to: {out_json}")
    print("=" * 70)


if __name__ == "__main__":
    main()
