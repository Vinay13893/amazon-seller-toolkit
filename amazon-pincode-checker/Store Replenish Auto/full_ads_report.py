"""Request all remaining ad reports, wait, download, and generate full analysis."""
import sys, json, gzip, csv, time
from pathlib import Path
from datetime import datetime, timedelta
sys.path.insert(0, ".")

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
from amazon_ads_tool.reports import ReportManager, REPORT_CONFIGS
from amazon_ads_tool.optimizer import BidOptimizer, SearchTermHarvester
from amazon_ads_tool.analyzer import PerformanceAnalyzer
import requests as req

config = load_config()
client = AmazonAdsClient(config)
report_mgr = ReportManager(client, config)

days = 30
end_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

# Reports to request
report_types = ["sd_campaigns", "sb_campaigns", "sp_targeting", "sp_search_terms"]

# Step 1: Request all reports
report_ids = {}
for rtype in report_types:
    try:
        rid = report_mgr.request_report(rtype, days_back=days)
        report_ids[rtype] = rid
        print(f"  {rtype}: requested (ID: {rid})")
    except Exception as e:
        print(f"  {rtype}: FAILED to request - {e}")

# Step 2: Poll all until done (max 10 minutes)
print(f"\nWaiting for {len(report_ids)} reports to complete...")
start_time = time.time()
completed = {}
while report_ids and (time.time() - start_time) < 600:
    for rtype, rid in list(report_ids.items()):
        try:
            result = client.get(
                f"/reporting/reports/{rid}",
                accept="application/vnd.createasyncreportrequest.v3+json",
            )
            status = result.get("status", "")
            if status == "COMPLETED":
                url = result.get("url", "")
                completed[rtype] = url
                del report_ids[rtype]
                print(f"  {rtype}: COMPLETED")
            elif status == "FAILURE":
                print(f"  {rtype}: FAILED - {result}")
                del report_ids[rtype]
        except Exception as e:
            print(f"  {rtype}: error checking - {e}")
    
    if report_ids:
        remaining = list(report_ids.keys())
        elapsed = int(time.time() - start_time)
        print(f"  [{elapsed}s] Still waiting: {remaining}")
        time.sleep(15)

# Step 3: Download completed reports
all_data = {}

# Load the SP campaigns data we already downloaded
sp_csv = Path("reports/default/sp_campaigns_20260402_211019.csv")
if sp_csv.exists():
    with open(sp_csv, newline="", encoding="utf-8") as f:
        all_data["sp_campaigns"] = list(csv.DictReader(f))
    print(f"\n  sp_campaigns: loaded {len(all_data['sp_campaigns'])} rows from CSV")

for rtype, url in completed.items():
    try:
        resp = req.get(url, timeout=120)
        resp.raise_for_status()
        data = json.loads(gzip.decompress(resp.content))
        all_data[rtype] = data
        print(f"  {rtype}: downloaded {len(data)} rows")
    except Exception as e:
        print(f"  {rtype}: download failed - {e}")
        all_data[rtype] = []

# Step 4: Generate the analysis report
print("\n" + "="*60)
print("  GENERATING PERFORMANCE ANALYSIS")
print("="*60)

sp_data = all_data.get("sp_campaigns", [])
sd_data = all_data.get("sd_campaigns", [])
sb_data = all_data.get("sb_campaigns", [])
targeting_data = all_data.get("sp_targeting", [])
search_term_data = all_data.get("sp_search_terms", [])

bid_actions = []
st_actions = []

if targeting_data:
    bid_optimizer = BidOptimizer(client, config)
    bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)
    print(f"  Bid actions: {len(bid_actions)}")

if search_term_data:
    harvester = SearchTermHarvester(client, config)
    st_actions = harvester.analyze_search_terms(search_term_data)
    print(f"  Search term actions: {len(st_actions)}")

analyzer = PerformanceAnalyzer(config)
report = analyzer.generate_monthly_report(
    sp_data, sd_data, sb_data,
    bid_actions=bid_actions,
    search_term_actions=st_actions,
)

print("\n" + report)

# Also export actions CSV
if bid_actions or st_actions:
    csv_path = analyzer.export_actions_csv(bid_actions, st_actions)
    print(f"\nOptimization actions exported to: {csv_path}")

print("\nDone!")
