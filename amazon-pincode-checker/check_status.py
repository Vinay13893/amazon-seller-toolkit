"""Quick status check on submitted report IDs."""
import json, os, sys
from dotenv import load_dotenv
load_dotenv()
from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
config = load_config()
client = AmazonAdsClient(config)

ids_file = os.path.join(BASE_DIR, "reports", "emount_ventures", "pending_report_ids.json")
with open(ids_file) as f:
    saved = json.load(f)

total = completed = 0
for wk, w in saved["windows"].items():
    print(f"\n📦 {w['start']} → {w['end']}")
    for rt, rid in w["reports"].items():
        if not rid:
            print(f"  ⏭️  {rt}: no ID (skipped)")
            continue
        total += 1
        try:
            r = client.get(f"/reporting/reports/{rid}",
                           accept="application/vnd.createasyncreportrequest.v3+json")
            status = r.get("status", "?")
            print(f"  {'✅' if status == 'COMPLETED' else '⏳'} {rt}: {status}")
            if status == "COMPLETED":
                completed += 1
        except Exception as e:
            print(f"  ⚠️  {rt}: {e}")

print(f"\n📊 {completed}/{total} reports COMPLETED")
