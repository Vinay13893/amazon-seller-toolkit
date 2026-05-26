"""
Resume checker - checks status of already-requested reports and downloads/analyzes them.
Use this if run_report.py timed out but reports may have completed on Amazon's side.

Usage:
  python check_reports.py --profile 1390660691082338 --name Wuze
"""
import json, time, csv, os, logging, argparse
from datetime import datetime
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

parser = argparse.ArgumentParser(description="Resume report checker")
parser.add_argument("--profile", help="Amazon Ads Profile ID to use")
parser.add_argument("--name", help="Account name (used for output folder)")
args = parser.parse_args()

from dotenv import load_dotenv
load_dotenv()

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient

config = load_config()
if args.profile:
    config.profile_id = args.profile

client = AmazonAdsClient(config)

# Output directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ACCOUNT_NAME = args.name or config.client_name
ACCOUNT_DIR = os.path.join(BASE_DIR, "reports", ACCOUNT_NAME)
RAW_DIR = os.path.join(ACCOUNT_DIR, "raw_data")
CSV_DIR = os.path.join(ACCOUNT_DIR, "csv_reports")
os.makedirs(RAW_DIR, exist_ok=True)
os.makedirs(CSV_DIR, exist_ok=True)
DATE_TAG = datetime.now().strftime("%Y%m%d")

# Report IDs - update these with the IDs from run_report.py output
REPORT_IDS = {
    "sp_campaigns": "10db72ab-3f04-4ae1-9af2-09170bf0bc4d",
    "sp_targeting": "00304e39-c486-4400-b707-e3b1a35f6c42",
    "sp_search_terms": "f0b49862-70f1-4fc2-afeb-25fc1d906d8e",
    "sp_advertised_product": "a7772e40-c01f-40e5-8c78-bba9d6ce8db0",
    "sd_campaigns": "8ea3e359-3811-4031-a1f5-cb2355230306",
}

import time
MAX_WAIT = 1800  # 30 minutes
POLL_INTERVAL = 20

print("Polling report status (30 min max)...\n")
data = {}
pending = dict(REPORT_IDS)
failed = {}
start = time.time()

while pending and (time.time() - start) < MAX_WAIT:
    still_pending = {}
    for name, rid in pending.items():
        try:
            result = client.get(
                f"/reporting/reports/{rid}",
                accept="application/vnd.createasyncreportrequest.v3+json",
            )
            status = result.get("status", "UNKNOWN")
            if status == "COMPLETED":
                url = result.get("url")
                rows = client.download_gzip_report(url)
                data[name] = rows
                print(f"  ✅ {name}: COMPLETED - {len(rows)} rows downloaded ({int(time.time()-start)}s)")
            elif status == "FAILURE":
                failed[name] = result.get("failureReason")
                print(f"  ❌ {name}: FAILED - {result.get('failureReason')}")
            else:
                still_pending[name] = rid
        except Exception as e:
            print(f"  ⚠️ {name}: error - {e}")
            still_pending[name] = rid
    pending = still_pending
    if pending:
        elapsed = int(time.time() - start)
        print(f"  ... waiting ({elapsed}s): {', '.join(pending.keys())}")
        time.sleep(POLL_INTERVAL)

if pending:
    for name in pending:
        print(f"  ⏳ {name}: timed out after {MAX_WAIT}s")

if not data:
    print("\nNo reports completed. Try again later.")
    exit()

# Save raw data to raw_data/ folder
print("\n💾 Saving raw data...")
for name, rows in data.items():
    raw_path = os.path.join(RAW_DIR, f"{name}_{DATE_TAG}.json")
    with open(raw_path, "w") as f:
        json.dump(rows, f, indent=2)
    if rows:
        csv_path = os.path.join(RAW_DIR, f"{name}_{DATE_TAG}.csv")
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
    print(f"  📁 {name}: {len(rows)} rows → raw_data/")

# Run analysis on whatever we have
from amazon_ads_tool.optimizer import BidOptimizer, SearchTermHarvester
from amazon_ads_tool.analyzer import PerformanceAnalyzer

sp_data = data.get("sp_campaigns", [])
sd_data = data.get("sd_campaigns", [])
targeting_data = data.get("sp_targeting", [])
search_term_data = data.get("sp_search_terms", [])
asin_data = data.get("sp_advertised_product", [])

# Bid optimization
bid_optimizer = BidOptimizer(client, config)
bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)

harvester = SearchTermHarvester(client, config)
st_actions = harvester.analyze_search_terms(search_term_data)

# Monthly report
analyzer = PerformanceAnalyzer(config)
report = analyzer.generate_monthly_report(sp_data, sd_data, [], bid_actions=bid_actions, search_term_actions=st_actions)
print("\n" + report)

# === ASIN Analysis ===
if asin_data:
    print("\n" + "=" * 80)
    print("# ASIN-LEVEL DEEP ANALYSIS")
    print("=" * 80)

    asin_agg = {}
    for row in asin_data:
        asin = row.get("advertisedAsin", "N/A")
        sku = row.get("advertisedSku", "")
        if asin not in asin_agg:
            asin_agg[asin] = {"asin": asin, "sku": sku, "impressions": 0, "clicks": 0, "cost": 0.0, "sales": 0.0, "orders": 0, "units": 0, "campaigns": set()}
        a = asin_agg[asin]
        a["impressions"] += int(row.get("impressions", 0))
        a["clicks"] += int(row.get("clicks", 0))
        a["cost"] += float(row.get("cost", 0))
        a["sales"] += float(row.get("sales1d", row.get("sales", 0)))
        a["orders"] += int(row.get("purchases1d", row.get("purchases", 0)))
        a["units"] += int(row.get("unitsSoldClicks1d", row.get("unitsSoldClicks", 0)))
        a["campaigns"].add(row.get("campaignName", ""))

    asins_by_spend = sorted(asin_agg.values(), key=lambda x: x["cost"], reverse=True)
    total_spend = sum(a["cost"] for a in asins_by_spend)
    total_sales = sum(a["sales"] for a in asins_by_spend)

    print(f"\nTotal ASINs: {len(asins_by_spend)} | Spend: ₹{total_spend:,.2f} | Sales: ₹{total_sales:,.2f} | ACoS: {(total_spend/total_sales*100) if total_sales > 0 else 0:.1f}%")

    print("\n## 🏆 WINNERS (ACoS < Target, 3+ Orders)")
    print("-" * 120)
    print(f"{'ASIN':<14} {'SKU':<25} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'ROAS':>6} {'CTR':>6} {'CVR':>6}")
    print("-" * 120)
    for a in sorted([a for a in asins_by_spend if a["sales"] > 0 and (a["cost"]/a["sales"]*100) < config.target_acos and a["orders"] >= 3], key=lambda x: x["sales"], reverse=True):
        acos = (a["cost"]/a["sales"]*100)
        roas = (a["sales"]/a["cost"]) if a["cost"] > 0 else 0
        ctr = (a["clicks"]/a["impressions"]*100) if a["impressions"] > 0 else 0
        cvr = (a["orders"]/a["clicks"]*100) if a["clicks"] > 0 else 0
        print(f"{a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} ₹{a['sales']:>10,.2f} {a['orders']:>7} {acos:>6.1f}% {roas:>5.1f}x {ctr:>5.2f}% {cvr:>5.1f}%")

    print("\n## 🚨 LOSERS (ACoS > 2x Target OR Zero Orders, Spend > ₹100)")
    print("-" * 120)
    print(f"{'ASIN':<14} {'SKU':<25} {'Spend':>10} {'Sales':>12} {'Orders':>7} {'ACoS':>7} {'Clicks':>7} {'Action':<20}")
    print("-" * 120)
    for a in asins_by_spend:
        acos = (a["cost"]/a["sales"]*100) if a["sales"] > 0 else float("inf")
        if a["cost"] > 100 and (acos > config.target_acos * 2 or a["orders"] == 0):
            acos_str = f"{acos:.1f}%" if acos != float("inf") else "∞"
            action = "PAUSE ADS" if a["orders"] == 0 else ("CUT BIDS 40%" if acos > config.target_acos * 3 else "REDUCE BIDS 25%")
            ctr = (a["clicks"]/a["impressions"]*100) if a["impressions"] > 0 else 0
            print(f"{a['asin']:<14} {a['sku'][:25]:<25} ₹{a['cost']:>9,.2f} ₹{a['sales']:>10,.2f} {a['orders']:>7} {acos_str:>7} {a['clicks']:>7} {action:<20}")

    print("\n## 🚀 PUSH HARDER (ACoS < 70% of Target, 2+ Orders)")
    print("-" * 100)
    push = [a for a in asins_by_spend if a["sales"] > 0 and (a["cost"]/a["sales"]*100) < config.target_acos * 0.7 and a["orders"] >= 2]
    push.sort(key=lambda x: (x["sales"]/x["cost"]) if x["cost"] > 0 else 0, reverse=True)
    for a in push[:20]:
        acos = (a["cost"]/a["sales"]*100)
        roas = (a["sales"]/a["cost"]) if a["cost"] > 0 else 0
        print(f"  {a['asin']} ({a['sku'][:20]}) — Spend ₹{a['cost']:,.0f} | Sales ₹{a['sales']:,.0f} | ACoS {acos:.1f}% | ROAS {roas:.1f}x | Headroom {config.target_acos - acos:.1f}pp")

    wasted = sum(a["cost"] for a in asins_by_spend if a["orders"] == 0 and a["cost"] > 100)
    print(f"\n💸 Wasted on zero-order ASINs (>₹100): ₹{wasted:,.2f} ({(wasted/total_spend*100) if total_spend > 0 else 0:.1f}% of total)")

# === Keyword Analysis ===
if targeting_data:
    print("\n" + "=" * 80)
    print("# KEYWORD-LEVEL ANALYSIS")
    print("=" * 80)
    kw_agg = {}
    for row in targeting_data:
        kw = row.get("keyword", row.get("targeting", row.get("targetingText", "N/A")))
        match = row.get("matchType", row.get("keywordType", ""))
        key = f"{kw}|{match}"
        if key not in kw_agg:
            kw_agg[key] = {"keyword": kw, "match_type": match, "impressions": 0, "clicks": 0, "cost": 0.0, "sales": 0.0, "orders": 0}
        k = kw_agg[key]
        k["impressions"] += int(row.get("impressions", 0))
        k["clicks"] += int(row.get("clicks", 0))
        k["cost"] += float(row.get("cost", 0))
        k["sales"] += float(row.get("sales1d", row.get("sales", 0)))
        k["orders"] += int(row.get("purchases1d", row.get("purchases", 0)))

    kws = sorted(kw_agg.values(), key=lambda x: x["cost"], reverse=True)
    print(f"\nTotal Keywords: {len(kws)}")

    print("\n## TOP PERFORMERS (Low ACoS, 2+ Orders)")
    for k in sorted([k for k in kws if k["sales"] > 0 and (k["cost"]/k["sales"]*100) < config.target_acos and k["orders"] >= 2], key=lambda x: x["sales"], reverse=True)[:20]:
        acos = (k["cost"]/k["sales"]*100)
        cvr = (k["orders"]/k["clicks"]*100) if k["clicks"] > 0 else 0
        print(f"  {k['keyword'][:40]:<40} [{k['match_type'][:8]}] — ₹{k['cost']:,.0f} spend | ₹{k['sales']:,.0f} sales | {k['orders']} orders | ACoS {acos:.1f}% | CVR {cvr:.1f}%")

    print("\n## MONEY DRAINERS (>₹50 spend, poor returns)")
    for k in [k for k in kws if k["cost"] > 50 and ((k["cost"]/k["sales"]*100) > config.target_acos * 2 if k["sales"] > 0 else True)][:20]:
        acos = (k["cost"]/k["sales"]*100) if k["sales"] > 0 else float("inf")
        acos_str = f"{acos:.1f}%" if acos != float("inf") else "∞"
        action = "NEGATE" if k["orders"] == 0 else "CUT BID 40%"
        print(f"  {k['keyword'][:40]:<40} [{k['match_type'][:8]}] — ₹{k['cost']:,.0f} spend | {k['orders']} orders | ACoS {acos_str} | → {action}")

# === Search Term Analysis ===
if search_term_data:
    print("\n" + "=" * 80)
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

    sts = sorted(st_agg.values(), key=lambda x: x["cost"], reverse=True)
    print(f"\nTotal search terms: {len(sts)}")

    print("\n## BEST CONVERTING (2+ Orders)")
    for s in sorted([s for s in sts if s["orders"] >= 2], key=lambda x: x["orders"], reverse=True)[:20]:
        acos = (s["cost"]/s["sales"]*100) if s["sales"] > 0 else 0
        cvr = (s["orders"]/s["clicks"]*100) if s["clicks"] > 0 else 0
        print(f"  {s['term'][:50]:<50} — ₹{s['cost']:,.0f} | ₹{s['sales']:,.0f} sales | {s['orders']} orders | ACoS {acos:.1f}% | CVR {cvr:.1f}%")

    print("\n## ADD AS NEGATIVES (>₹30 spend, 0 orders)")
    for s in [s for s in sts if s["orders"] == 0 and s["cost"] > 30][:20]:
        print(f"  {s['term'][:50]:<50} — ₹{s['cost']:,.0f} wasted | {s['clicks']} clicks")

# ── Save all analysis as CSV files ──
print("\n📊 Saving CSV reports...")

def _safe_acos(cost, sales):
    return round(cost / sales * 100, 2) if sales > 0 else None

def _safe_div(a, b):
    return round(a / b, 2) if b > 0 else 0

# ASIN CSV
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

# Keyword CSV
if targeting_data and kw_agg:
    kw_csv = os.path.join(CSV_DIR, f"keyword_analysis_{DATE_TAG}.csv")
    with open(kw_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Keyword", "MatchType", "Impressions", "Clicks", "Cost", "Sales", "Orders",
                     "ACoS%", "CPC", "CVR%", "Category"])
        for k in kws:
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
                        acos, cpc, cvr, cat])
    print(f"  ✅ {kw_csv}")

# Search term CSV
if search_term_data and st_agg:
    st_csv = os.path.join(CSV_DIR, f"search_term_analysis_{DATE_TAG}.csv")
    with open(st_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["SearchTerm", "Impressions", "Clicks", "Cost", "Sales", "Orders",
                     "ACoS%", "CVR%", "Category"])
        for s in sts:
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

# Campaign CSV
all_campaigns = []
for row in sp_data:
    row["ad_type"] = "SP"
    all_campaigns.append(row)
for row in sd_data:
    row["ad_type"] = "SD"
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

print(f"\n✅ Done!")
print(f"   Raw data    → {RAW_DIR}/")
print(f"   CSV reports → {CSV_DIR}/")
