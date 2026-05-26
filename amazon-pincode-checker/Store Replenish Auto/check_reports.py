"""Check status of previously requested Amazon Ads reports and download if ready."""
import json
import sys
sys.path.insert(0, ".")
from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient

config = load_config()
client = AmazonAdsClient(config)

report_ids = [
    "b9351874-02b3-4e10-8995-8148d2928983",
    "c0a48ad8-c2b5-4781-aee1-77e0eeb57556",
]

for rid in report_ids:
    try:
        result = client.get(
            f"/reporting/reports/{rid}",
            accept="application/vnd.createasyncreportrequest.v3+json",
        )
        status = result.get("status", "UNKNOWN")
        url = result.get("url", "")
        print(f"Report {rid}")
        print(f"  Status: {status}")
        if url:
            print(f"  URL: {url[:120]}...")
        print()
    except Exception as e:
        print(f"Report {rid}: ERROR - {e}")
        print()
