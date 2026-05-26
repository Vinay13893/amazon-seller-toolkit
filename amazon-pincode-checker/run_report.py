"""
Comprehensive Amazon Ads analysis.
Requests ALL reports simultaneously so Amazon generates them in parallel,
then polls all at once for faster results.
"""
import time
import json
import csv
import os
import sys
import argparse
import logging
from datetime import datetime, timedelta
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

from dotenv import load_dotenv
load_dotenv()

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
from amazon_ads_tool.reports import ReportManager
from amazon_ads_tool.optimizer import BidOptimizer, SearchTermHarvester
from amazon_ads_tool.analyzer import PerformanceAnalyzer

# ── CLI args ──
parser = argparse.ArgumentParser(description="Amazon Ads comprehensive report")
parser.add_argument("--profile", type=str, default=None, help="Override profile ID")
parser.add_argument("--name", type=str, default=None, help="Account name (used for folder names)")
parser.add_argument("--days", type=int, default=30, help="Days back (default 30)")
parser.add_argument("--submit-only", action="store_true", help="Submit all report requests, save IDs to JSON, then exit (no polling)")
parser.add_argument("--resume", type=str, default=None, metavar="IDS_FILE", help="Poll/download reports from a previously-saved IDs JSON file, then run analysis")
args = parser.parse_args()

config = load_config()
if args.profile:
    config.profile_id = args.profile
ACCOUNT_NAME = args.name or config.client_name
client = AmazonAdsClient(config)
report_mgr = ReportManager(client, config)
DAYS = args.days

# Output directories — account-specific subfolders
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ACCOUNT_DIR = os.path.join(BASE_DIR, "reports", ACCOUNT_NAME)
RAW_DIR = os.path.join(ACCOUNT_DIR, "raw_data")
CSV_DIR = os.path.join(ACCOUNT_DIR, "csv_reports")
os.makedirs(RAW_DIR, exist_ok=True)
os.makedirs(CSV_DIR, exist_ok=True)
DATE_TAG = datetime.now().strftime("%Y%m%d")

print(f"\n🔧 Amazon Ads Tool | Account: {ACCOUNT_NAME} | Profile: {config.profile_id} | Region: {config.region} | Marketplace: {config.marketplace}")
print(f"   Period: {DAYS} days (end date = yesterday)")
print(f"   Output: {ACCOUNT_DIR}/\n")

report_types = [
    "sp_campaigns", "sp_targeting", "sp_search_terms",
    "sp_advertised_product", "sd_campaigns", "sb_campaigns",
]
data = {}

def _split_windows(days_back, max_days=31):
    """Return inclusive date windows ending yesterday, each <= max_days."""
    yesterday = datetime.now() - timedelta(days=1)
    windows = []
    remaining = days_back
    end = yesterday
    while remaining > 0:
        window_days = min(max_days, remaining)
        start = end - timedelta(days=window_days - 1)
        windows.append((start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")))
        end = start - timedelta(days=1)
        remaining -= window_days
    windows.reverse()
    return windows


def _fetch_window_parallel(start_date, end_date, max_wait=1200):
    """Fetch all report types for one date window in parallel request/poll cycles."""
    report_ids = {}
    window_data = {rt: [] for rt in report_types}

    print(f"\n📦 Window {start_date} -> {end_date}")
    for rt in report_types:
        try:
            rid = report_mgr.request_report(rt, start_date=start_date, end_date=end_date)
            report_ids[rt] = rid
            print(f"  📋 {rt}: requested (ID: {rid[:12]}...)")
        except Exception as e:
            print(f"  ⚠️ {rt}: request failed - {e}")
            report_ids[rt] = None

    pending = {rt: rid for rt, rid in report_ids.items() if isinstance(rid, str)}
    completed = {}
    start = time.time()

    while pending and (time.time() - start) < max_wait:
        time.sleep(15)
        elapsed = int(time.time() - start)
        still_pending = {}
        for rt, rid in pending.items():
            try:
                result = client.get(
                    f"/reporting/reports/{rid}",
                    accept="application/vnd.createasyncreportrequest.v3+json",
                )
                status = result.get("status", "")
                if status == "COMPLETED":
                    completed[rt] = result.get("url")
                    print(f"  ✅ {rt}: completed ({elapsed}s)")
                elif status == "FAILURE":
                    print(f"  ⚠️ {rt}: FAILED - {result.get('failureReason')}")
                else:
                    still_pending[rt] = rid
            except Exception as e:
                print(f"  ⚠️ {rt}: poll error - {e}")
                still_pending[rt] = rid
        pending = still_pending
        if pending:
            print(f"  ... waiting ({elapsed}s): {', '.join(pending.keys())}")

    if pending:
        for rt in pending:
            print(f"  ⏳ {rt}: timed out after {max_wait}s")

    for rt, url in completed.items():
        try:
            rows = client.download_gzip_report(url)
            window_data[rt] = rows
            print(f"  📥 {rt}: {len(rows)} rows downloaded")
        except Exception as e:
            print(f"  ⚠️ {rt}: download failed - {e}")

    return window_data


def _submit_all_windows(days_back):
    """Submit all report requests for all date windows. Save IDs to JSON. Return path to file."""
    windows = _split_windows(days_back)
    ids_file = os.path.join(ACCOUNT_DIR, "pending_report_ids.json")

    # Load any previously saved IDs to avoid double-submitting
    existing = {}
    if os.path.exists(ids_file):
        try:
            with open(ids_file) as f:
                existing = json.load(f).get("windows", {})
            print(f"  📂 Loaded {len(existing)} existing window(s) from {ids_file}")
        except Exception:
            pass

    all_ids = {}
    for start_date, end_date in windows:
        key = f"{start_date}__{end_date}"
        prior = (existing.get(key) or {}).get("reports", {})
        all_ids[key] = {"start": start_date, "end": end_date, "reports": dict(prior)}

        print(f"\n📦 Window {start_date} → {end_date}")
        for rt in report_types:
            if all_ids[key]["reports"].get(rt):
                print(f"  🔖 {rt}: using existing ID ({all_ids[key]['reports'][rt][:12]}...)")
                continue
            try:
                rid = report_mgr.request_report(rt, start_date=start_date, end_date=end_date)
                all_ids[key]["reports"][rt] = rid
                print(f"  📋 {rt}: submitted (ID: {rid[:12]}...)")
            except Exception as e:
                print(f"  ⚠️ {rt}: failed - {e}")
                all_ids[key]["reports"][rt] = None

    payload = {"submitted_at": datetime.now().isoformat(), "windows": all_ids}
    with open(ids_file, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\n✅ Report IDs saved → {ids_file}")
    return ids_file


def _poll_saved_ids(ids_file, max_wait=7200):
    """Load saved report IDs, poll all windows in parallel until done. Returns merged data dict."""
    with open(ids_file) as f:
        saved = json.load(f)

    print(f"\n🔍 Resuming from {ids_file}")
    print(f"   Originally submitted: {saved['submitted_at']}")

    # Build flat poll queue: {(rt, window_key): rid}
    pending = {}
    for window_key, w in saved["windows"].items():
        for rt, rid in w.get("reports", {}).items():
            if rid:
                pending[(rt, window_key)] = rid

    print(f"   Total report slots to check: {len(pending)}")

    merged = {rt: [] for rt in report_types}
    poll_start = time.time()

    while pending and (time.time() - poll_start) < max_wait:
        time.sleep(30)
        elapsed = int(time.time() - poll_start)
        still = {}
        newly_done = []
        for (rt, wk), rid in list(pending.items()):
            try:
                result = client.get(
                    f"/reporting/reports/{rid}",
                    accept="application/vnd.createasyncreportrequest.v3+json",
                )
                status = result.get("status", "")
                if status == "COMPLETED":
                    url = result.get("url")
                    rows = client.download_gzip_report(url)
                    merged[rt].extend(rows)
                    start_lbl = wk.split("__")[0]
                    newly_done.append(f"{rt} ({start_lbl}+): {len(rows)} rows")
                elif status == "FAILURE":
                    reason = result.get("failureReason", "unknown")
                    print(f"  ❌ {rt} [{wk}]: FAILED - {reason}")
                else:
                    still[(rt, wk)] = rid
            except Exception as e:
                print(f"  ⚠️ {rt} [{wk}]: poll error - {e}")
                still[(rt, wk)] = rid

        for msg in newly_done:
            print(f"  ✅ {msg}")
        pending = still
        if pending:
            print(f"  ... ({elapsed}s elapsed): {len(pending)} reports still pending")

    if pending:
        for (rt, wk), _ in pending.items():
            print(f"  ⏳ {rt} [{wk}]: timed out after {max_wait}s")

    return merged


# ── Handle special run modes ──────────────────────────────────────────────────
if args.submit_only:
    print(f"\n📤 SUBMIT-ONLY MODE: submitting all {DAYS}-day reports across windows...")
    ids_path = _submit_all_windows(DAYS)
    print(f"\n📌 Come back in 30-60 min and run:")
    print(f"   python run_report.py --name {ACCOUNT_NAME} --resume \"{ids_path}\"")
    sys.exit(0)

if args.resume:
    print(f"\n⏳ RESUME MODE: polling saved report IDs from: {args.resume}")
    data = _poll_saved_ids(args.resume, max_wait=7200)
    for rt in report_types:
        print(f"  📊 {rt}: {len(data[rt])} total rows")

elif DAYS <= 31:
    # ── Step 1: Request ALL reports at once (parallel on Amazon's side) ──
    report_ids = {}
    print("📤 Requesting all reports simultaneously...")
    for rt in report_types:
        try:
            rid = report_mgr.request_report(rt, days_back=DAYS)
            report_ids[rt] = rid
            # Quick check if already completed (425 reuse)
            try:
                result = client.get(
                    f"/reporting/reports/{rid}",
                    accept="application/vnd.createasyncreportrequest.v3+json",
                )
                if result.get("status") == "COMPLETED":
                    report_ids[rt] = ("DONE", rid, result.get("url"))
                    print(f"  ✅ {rt}: already completed")
                    continue
            except:
                pass
            print(f"  📋 {rt}: requested (ID: {rid[:12]}...)")
        except Exception as e:
            print(f"  ❌ {rt}: request failed - {e}")
            report_ids[rt] = None

    # ── Step 2: Poll ALL pending reports together ──
    print("\n⏳ Waiting for reports to complete...")
    MAX_WAIT = 900  # 15 minutes
    start = time.time()
    pending = {rt: rid for rt, rid in report_ids.items() if isinstance(rid, str)}
    completed = {rt: info for rt, info in report_ids.items() if isinstance(info, tuple)}
    failed = {rt: None for rt, info in report_ids.items() if info is None}

    while pending and (time.time() - start) < MAX_WAIT:
        time.sleep(15)
        elapsed = int(time.time() - start)
        still_pending = {}
        for rt, rid in pending.items():
            try:
                result = client.get(
                    f"/reporting/reports/{rid}",
                    accept="application/vnd.createasyncreportrequest.v3+json",
                )
                status = result.get("status", "")
                if status == "COMPLETED":
                    completed[rt] = ("DONE", rid, result.get("url"))
                    print(f"  ✅ {rt}: completed ({elapsed}s)")
                elif status == "FAILURE":
                    failed[rt] = result.get("failureReason")
                    print(f"  ❌ {rt}: FAILED - {result.get('failureReason')}")
                else:
                    still_pending[rt] = rid
            except Exception as e:
                print(f"  ⚠️ {rt}: poll error - {e}")
                still_pending[rt] = rid
        pending = still_pending
        if pending:
            names = ", ".join(pending.keys())
            print(f"  ... still waiting ({elapsed}s): {names}")

    if pending:
        for rt in pending:
            print(f"  ⏳ {rt}: timed out after {MAX_WAIT}s")

    # ── Step 3: Download all completed reports ──
    print("\n📥 Downloading report data...")
    for rt, info in completed.items():
        try:
            _, rid, url = info
            rows = client.download_gzip_report(url)
            data[rt] = rows
            print(f"  ✅ {rt}: {len(rows)} rows")
        except Exception as e:
            print(f"  ❌ {rt}: download failed - {e}")
            data[rt] = []
else:
    # Amazon Ads summary reports are capped at 31 days, so fetch in chunks and merge.
    windows = _split_windows(DAYS, max_days=31)
    print(f"📤 {DAYS}-day request exceeds API range; fetching in {len(windows)} windows (<=31d each)...")
    data = {rt: [] for rt in report_types}
    for start_date, end_date in windows:
        window_data = _fetch_window_parallel(start_date, end_date, max_wait=1200)
        for rt in report_types:
            data[rt].extend(window_data.get(rt, []))

    for rt in report_types:
        print(f"  ✅ {rt}: merged total {len(data[rt])} rows")

# Save raw data to raw_data/ folder
print("\n💾 Saving raw data...")
for rt, rows in data.items():
    raw_path = os.path.join(RAW_DIR, f"{rt}_{DATE_TAG}.json")
    with open(raw_path, "w") as f:
        json.dump(rows, f, indent=2)
    # Also save as CSV
    if rows:
        csv_path = os.path.join(RAW_DIR, f"{rt}_{DATE_TAG}.csv")
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
    print(f"  📁 {rt}: {len(rows)} rows → raw_data/")

# Fill missing with empty
for rt in report_types:
    if rt not in data:
        data[rt] = []

sp_data = data["sp_campaigns"]
sd_data = data["sd_campaigns"]
sb_data = data["sb_campaigns"]
targeting_data = data["sp_targeting"]
search_term_data = data["sp_search_terms"]
asin_data = data["sp_advertised_product"]

# ── Step 4: Standard optimization analysis ──
print("\n🔍 Running optimization analysis...")
bid_optimizer = BidOptimizer(client, config)
bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)

harvester = SearchTermHarvester(client, config)
st_actions = harvester.analyze_search_terms(search_term_data)

# ── Step 5: Generate standard monthly report ──
analyzer = PerformanceAnalyzer(config)
report = analyzer.generate_monthly_report(
    sp_data, sd_data, sb_data,
    bid_actions=bid_actions,
    search_term_actions=st_actions,
)
print()
print(report)

# ── Step 6: Deep ASIN Analysis ──
if asin_data:
    print("\n" + "=" * 80)
    print("# ASIN-LEVEL DEEP ANALYSIS")
    print("=" * 80)

    # Aggregate by ASIN
    asin_agg = {}
    for row in asin_data:
        asin = row.get("advertisedAsin", "N/A")
        sku = row.get("advertisedSku", "")
        if asin not in asin_agg:
            asin_agg[asin] = {
                "asin": asin, "sku": sku,
                "impressions": 0, "clicks": 0, "cost": 0.0,
                "sales": 0.0, "orders": 0, "units": 0,
                "campaigns": set(),
            }
        a = asin_agg[asin]
        a["impressions"] += int(row.get("impressions", 0))
        a["clicks"] += int(row.get("clicks", 0))
        a["cost"] += float(row.get("cost", 0))
        a["sales"] += float(row.get("sales1d", row.get("sales", 0)))
        a["orders"] += int(row.get("purchases1d", row.get("purchases", 0)))
        a["units"] += int(row.get("unitsSoldClicks1d", row.get("unitsSoldClicks", 0)))
        a["campaigns"].add(row.get("campaignName", ""))

    # Sort by spend
    asins_by_spend = sorted(asin_agg.values(), key=lambda x: x["cost"], reverse=True)
    total_spend = sum(a["cost"] for a in asins_by_spend)
    total_sales = sum(a["sales"] for a in asins_by_spend)

    print(f"\nTotal ASINs advertised: {len(asins_by_spend)}")
    print(f"Total Ad Spend: ₹{total_spend:,.2f}")
    print(f"Total Ad Sales: ₹{total_sales:,.2f}")
    print(f"Overall ACoS: {(total_spend/total_sales*100) if total_sales > 0 else 0:.1f}%")

    # ── Winners: Low ACoS, good orders ──
    print("\n\n## 🏆 WINNING ASINs (ACoS < Target, 3+ Orders)")
    print("-" * 120)
    print(f"{'ASIN':<14} {'SKU':<25} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'ROAS':>6} {'CTR':>6} {'CVR':>6} {'CPC':>7} {'Campaigns':>3}")
    print("-" * 120)
    winners = [a for a in asins_by_spend
               if a["sales"] > 0 and (a["cost"]/a["sales"]*100) < config.target_acos and a["orders"] >= 3]
    winners.sort(key=lambda x: x["sales"], reverse=True)
    for a in winners:
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else 0
        roas = (a["sales"]/a["cost"]) if a["cost"] > 0 else 0
        ctr = (a["clicks"]/a["impressions"]*100) if a["impressions"] > 0 else 0
        cvr = (a["orders"]/a["clicks"]*100) if a["clicks"] > 0 else 0
        cpc = (a["cost"]/a["clicks"]) if a["clicks"] > 0 else 0
        print(f"{a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} ₹{a['sales']:>10,.2f} {a['orders']:>7} {acos:>6.1f}% {roas:>5.1f}x {ctr:>5.2f}% {cvr:>5.1f}% ₹{cpc:>5.2f} {len(a['campaigns']):>3}")

    # ── Losers: High ACoS or zero conversions ──
    print("\n\n## 🚨 LOSING ASINs (ACoS > 2x Target OR Zero Orders with Spend > ₹100)")
    print("-" * 120)
    print(f"{'ASIN':<14} {'SKU':<25} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'Clicks':>7} {'CTR':>6} {'Action':<20}")
    print("-" * 120)
    losers = []
    for a in asins_by_spend:
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else float("inf")
        if a["cost"] > 100 and (acos > config.target_acos * 2 or a["orders"] == 0):
            losers.append(a)
    for a in losers:
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else float("inf")
        acos_str = f"{acos:.1f}%" if acos != float("inf") else "∞"
        ctr = (a["clicks"]/a["impressions"]*100) if a["impressions"] > 0 else 0
        action = "PAUSE ADS" if a["orders"] == 0 else "CUT BIDS 40%"
        if a["orders"] > 0 and acos < config.target_acos * 3:
            action = "REDUCE BIDS 25%"
        print(f"{a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} ₹{a['sales']:>10,.2f} {a['orders']:>7} {acos_str:>7} {a['clicks']:>7} {ctr:>5.2f}% {action:<20}")

    # ── ASINs to push harder ──
    print("\n\n## 🚀 ASINs TO PUSH HARDER (Good ACoS + High ROAS, increase budget)")
    print("-" * 120)
    push_harder = [a for a in asins_by_spend
                   if a["sales"] > 0 and (a["cost"]/a["sales"]*100) < config.target_acos * 0.7
                   and a["orders"] >= 2]
    push_harder.sort(key=lambda x: (x["sales"]/x["cost"]) if x["cost"] > 0 else 0, reverse=True)
    print(f"{'ASIN':<14} {'SKU':<25} {'Spend':>10} {'Sales':>12} {'ACoS':>7} {'ROAS':>6} {'Orders':>7} {'Headroom':>10}")
    print("-" * 120)
    for a in push_harder[:20]:
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else 0
        roas = (a["sales"]/a["cost"]) if a["cost"] > 0 else 0
        headroom = config.target_acos - acos
        print(f"{a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} ₹{a['sales']:>10,.2f} {acos:>6.1f}% {roas:>5.1f}x {a['orders']:>7} {headroom:>8.1f}pp")

    # ── Wasted spend summary ──
    total_wasted = sum(a["cost"] for a in losers if a["orders"] == 0)
    print(f"\n\n## 💸 WASTED SPEND SUMMARY")
    print(f"   Total wasted on zero-order ASINs (>₹100 spend): ₹{total_wasted:,.2f}")
    print(f"   That's {(total_wasted/total_spend*100) if total_spend > 0 else 0:.1f}% of total ad spend")

    # ── ASIN spending distribution ──
    print(f"\n## 📊 SPEND DISTRIBUTION (Top 20 ASINs)")
    print("-" * 100)
    print(f"{'#':<4} {'ASIN':<14} {'SKU':<25} {'Spend':>10} {'% of Total':>10} {'Sales':>12} {'ACoS':>7} {'Orders':>7}")
    print("-" * 100)
    for i, a in enumerate(asins_by_spend[:20], 1):
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else float("inf")
        acos_str = f"{acos:.1f}%" if acos != float("inf") else "∞"
        pct = (a["cost"]/total_spend*100) if total_spend > 0 else 0
        print(f"{i:<4} {a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} {pct:>8.1f}% ₹{a['sales']:>10,.2f} {acos_str:>7} {a['orders']:>7}")

# ── Step 7: Deep Keyword Analysis ──
if targeting_data:
    print("\n\n" + "=" * 80)
    print("# KEYWORD-LEVEL DEEP ANALYSIS")
    print("=" * 80)

    # Aggregate by keyword
    kw_agg = {}
    for row in targeting_data:
        kw = row.get("keyword", row.get("targeting", row.get("targetingText", "N/A")))
        match = row.get("matchType", row.get("keywordType", ""))
        key = f"{kw}|{match}"
        if key not in kw_agg:
            kw_agg[key] = {
                "keyword": kw, "match_type": match,
                "impressions": 0, "clicks": 0, "cost": 0.0,
                "sales": 0.0, "orders": 0,
                "bid": float(row.get("keywordBid", row.get("bid", 0)) or 0),
                "campaigns": set(), "ad_groups": set(),
            }
        k = kw_agg[key]
        k["impressions"] += int(row.get("impressions", 0))
        k["clicks"] += int(row.get("clicks", 0))
        k["cost"] += float(row.get("cost", 0))
        k["sales"] += float(row.get("sales1d", row.get("sales", 0)))
        k["orders"] += int(row.get("purchases1d", row.get("purchases", 0)))
        k["campaigns"].add(row.get("campaignName", ""))
        k["ad_groups"].add(row.get("adGroupName", ""))

    kws_by_spend = sorted(kw_agg.values(), key=lambda x: x["cost"], reverse=True)
    total_kw_spend = sum(k["cost"] for k in kws_by_spend)

    print(f"\nTotal Keywords/Targets: {len(kws_by_spend)}")
    print(f"Total Keyword Spend: ₹{total_kw_spend:,.2f}")

    # Winning keywords
    print("\n## 🏆 TOP PERFORMING KEYWORDS (Low ACoS, 2+ Orders)")
    print("-" * 130)
    print(f"{'Keyword':<40} {'Match':<10} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'CPC':>7} {'CVR':>6} {'Bid':>6}")
    print("-" * 130)
    winning_kws = [k for k in kws_by_spend if k["sales"] > 0 and (k["cost"]/k["sales"]*100) < config.target_acos and k["orders"] >= 2]
    winning_kws.sort(key=lambda x: x["sales"], reverse=True)
    for k in winning_kws[:25]:
        acos = (k["cost"]/k["sales"]*100)
        cpc = (k["cost"]/k["clicks"]) if k["clicks"] > 0 else 0
        cvr = (k["orders"]/k["clicks"]*100) if k["clicks"] > 0 else 0
        print(f"{k['keyword'][:40]:<40} {k['match_type'][:10]:<10} ₹{k['cost']:>9,.2f} ₹{k['sales']:>10,.2f} {k['orders']:>7} {acos:>6.1f}% ₹{cpc:>5.2f} {cvr:>5.1f}% ₹{k['bid']:>4.1f}")

    # Money-draining keywords
    print("\n## 🚨 MONEY-DRAINING KEYWORDS (High spend, poor returns)")
    print("-" * 130)
    print(f"{'Keyword':<40} {'Match':<10} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'Clicks':>7} {'Action':<20}")
    print("-" * 130)
    draining = []
    for k in kws_by_spend:
        acos = (k["cost"]/k["sales"]*100) if k["sales"] > 0 else float("inf")
        if k["cost"] > 50 and (acos > config.target_acos * 2 or k["orders"] == 0):
            draining.append(k)
    for k in draining[:25]:
        acos = (k["cost"]/k["sales"]*100) if k["sales"] > 0 else float("inf")
        acos_str = f"{acos:.1f}%" if acos != float("inf") else "∞"
        action = "NEGATE" if k["orders"] == 0 else "CUT BID 40%"
        print(f"{k['keyword'][:40]:<40} {k['match_type'][:10]:<10} ₹{k['cost']:>9,.2f} ₹{k['sales']:>10,.2f} {k['orders']:>7} {acos_str:>7} {k['clicks']:>7} {action:<20}")

    # Wasted keyword spend
    wasted_kw = sum(k["cost"] for k in kws_by_spend if k["orders"] == 0 and k["cost"] > 50)
    print(f"\n💸 Wasted on zero-order keywords (>₹50 each): ₹{wasted_kw:,.2f}")

# ── Step 8: Search Term Winners ──
if search_term_data:
    print("\n\n" + "=" * 80)
    print("# SEARCH TERM ANALYSIS")
    print("=" * 80)

    st_agg = {}
    for row in search_term_data:
        st = row.get("searchTerm", "")
        if st not in st_agg:
            st_agg[st] = {"term": st, "impressions": 0, "clicks": 0, "cost": 0.0, "sales": 0.0, "orders": 0}
        s = st_agg[st]
        s["impressions"] += int(row.get("impressions", 0))
        s["clicks"] += int(row.get("clicks", 0))
        s["cost"] += float(row.get("cost", 0))
        s["sales"] += float(row.get("sales1d", row.get("sales", 0)))
        s["orders"] += int(row.get("purchases1d", row.get("purchases", 0)))

    sts_by_spend = sorted(st_agg.values(), key=lambda x: x["cost"], reverse=True)

    print(f"\nTotal unique search terms: {len(sts_by_spend)}")

    # Best converting search terms
    print("\n## 🏆 BEST CONVERTING SEARCH TERMS")
    print("-" * 110)
    print(f"{'Search Term':<50} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'CVR':>6}")
    print("-" * 110)
    best_sts = [s for s in sts_by_spend if s["orders"] >= 2 and s["sales"] > 0]
    best_sts.sort(key=lambda x: x["orders"], reverse=True)
    for s in best_sts[:20]:
        acos = (s["cost"]/s["sales"]*100) if s["sales"] > 0 else 0
        cvr = (s["orders"]/s["clicks"]*100) if s["clicks"] > 0 else 0
        print(f"{s['term'][:50]:<50} ₹{s['cost']:>9,.2f} ₹{s['sales']:>10,.2f} {s['orders']:>7} {acos:>6.1f}% {cvr:>5.1f}%")

    # Worst search terms (wasting money)
    print("\n## 🚨 WORST SEARCH TERMS (Wasting Money)")
    print("-" * 110)
    print(f"{'Search Term':<50} {'Spend':>10} {'Clicks':>7} {'Orders':>7} {'Action':<20}")
    print("-" * 110)
    worst_sts = [s for s in sts_by_spend if s["orders"] == 0 and s["cost"] > 30]
    for s in worst_sts[:20]:
        print(f"{s['term'][:50]:<50} ₹{s['cost']:>9,.2f} {s['clicks']:>7} {s['orders']:>7} {'ADD AS NEGATIVE':<20}")


# ── Step 9: Save all analysis as CSV files ──
print("\n\n📊 Saving CSV reports...")

def _safe_acos(cost, sales):
    return round(cost / sales * 100, 2) if sales > 0 else None

def _safe_div(a, b):
    return round(a / b, 2) if b > 0 else 0

# ASIN-level CSV
if asin_data and asin_agg:
    asin_csv = os.path.join(CSV_DIR, f"asin_analysis_{DATE_TAG}.csv")
    with open(asin_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ASIN", "SKU", "Impressions", "Clicks", "Cost", "Sales", "Orders", "Units",
                     "ACoS%", "ROAS", "CTR%", "CVR%", "CPC", "Campaigns", "Category"])
        for a in asins_by_spend:
            acos = _safe_acos(a["cost"], a["sales"])
            roas = _safe_div(a["sales"], a["cost"])
            ctr = _safe_div(a["clicks"] * 100, a["impressions"])
            cvr = _safe_div(a["orders"] * 100, a["clicks"])
            cpc = _safe_div(a["cost"], a["clicks"])
            # Categorize
            if a["orders"] == 0 and a["cost"] > 100:
                cat = "LOSER - PAUSE"
            elif acos is not None and acos > config.target_acos * 2:
                cat = "LOSER - CUT BIDS"
            elif acos is not None and acos < config.target_acos * 0.7 and a["orders"] >= 2:
                cat = "PUSH HARDER"
            elif acos is not None and acos < config.target_acos and a["orders"] >= 3:
                cat = "WINNER"
            else:
                cat = "MONITOR"
            w.writerow([a["asin"], a["sku"], a["impressions"], a["clicks"],
                        round(a["cost"], 2), round(a["sales"], 2), a["orders"], a["units"],
                        acos, roas, ctr, cvr, cpc, len(a["campaigns"]), cat])
    print(f"  ✅ {asin_csv}")

# Keyword-level CSV
if targeting_data and kw_agg:
    kw_csv = os.path.join(CSV_DIR, f"keyword_analysis_{DATE_TAG}.csv")
    with open(kw_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Keyword", "MatchType", "Impressions", "Clicks", "Cost", "Sales", "Orders",
                     "ACoS%", "CPC", "CVR%", "Bid", "Category"])
        for k in kws_by_spend:
            acos = _safe_acos(k["cost"], k["sales"])
            cpc = _safe_div(k["cost"], k["clicks"])
            cvr = _safe_div(k["orders"] * 100, k["clicks"])
            if k["orders"] == 0 and k["cost"] > 50:
                cat = "NEGATE"
            elif acos is not None and acos > config.target_acos * 2:
                cat = "CUT BID 40%"
            elif acos is not None and acos < config.target_acos and k["orders"] >= 2:
                cat = "TOP PERFORMER"
            else:
                cat = "MONITOR"
            w.writerow([k["keyword"], k["match_type"], k["impressions"], k["clicks"],
                        round(k["cost"], 2), round(k["sales"], 2), k["orders"],
                        acos, cpc, cvr, k["bid"], cat])
    print(f"  ✅ {kw_csv}")

# Search term CSV
if search_term_data and st_agg:
    st_csv = os.path.join(CSV_DIR, f"search_term_analysis_{DATE_TAG}.csv")
    with open(st_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["SearchTerm", "Impressions", "Clicks", "Cost", "Sales", "Orders",
                     "ACoS%", "CVR%", "Category"])
        for s in sts_by_spend:
            acos = _safe_acos(s["cost"], s["sales"])
            cvr = _safe_div(s["orders"] * 100, s["clicks"])
            if s["orders"] == 0 and s["cost"] > 30:
                cat = "ADD AS NEGATIVE"
            elif s["orders"] >= 2 and acos is not None and acos < config.target_acos:
                cat = "BEST CONVERTING"
            elif s["orders"] >= 2:
                cat = "CONVERTING"
            else:
                cat = "MONITOR"
            w.writerow([s["term"], s["impressions"], s["clicks"],
                        round(s["cost"], 2), round(s["sales"], 2), s["orders"],
                        acos, cvr, cat])
    print(f"  ✅ {st_csv}")

# Campaign-level CSV (SP + SD combined)
all_campaigns = []
for row in sp_data:
    row["ad_type"] = "SP"
    all_campaigns.append(row)
for row in sd_data:
    row["ad_type"] = "SD"
    all_campaigns.append(row)
for row in sb_data:
    row["ad_type"] = "SB"
    all_campaigns.append(row)
if all_campaigns:
    camp_csv = os.path.join(CSV_DIR, f"campaign_analysis_{DATE_TAG}.csv")
    with open(camp_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Campaign", "CampaignId", "Status", "AdType", "Budget",
                     "Impressions", "Clicks", "Cost", "Sales", "Orders", "Units", "ACoS%", "ROAS"])
        for c in all_campaigns:
            cost = float(c.get("cost", 0))
            sales = float(c.get("sales1d", c.get("sales", 0)))
            orders = int(c.get("purchases1d", c.get("purchases", 0)))
            units = int(c.get("unitsSoldClicks1d", c.get("unitsSoldClicks", 0)))
            acos = _safe_acos(cost, sales)
            roas = _safe_div(sales, cost)
            w.writerow([c.get("campaignName", ""), c.get("campaignId", ""),
                        c.get("campaignStatus", ""), c.get("ad_type", ""),
                        c.get("campaignBudgetAmount", ""),
                        c.get("impressions", 0), c.get("clicks", 0),
                        round(cost, 2), round(sales, 2), orders, units, acos, roas])
    print(f"  ✅ {camp_csv}")

print(f"\n✅ Analysis complete for {ACCOUNT_NAME}!")
print(f"   Raw data    → {RAW_DIR}/")
print(f"   CSV reports → {CSV_DIR}/")
