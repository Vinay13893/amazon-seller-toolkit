"""Download completed ad reports directly by report ID."""
import sys, json, gzip, csv
from pathlib import Path
from datetime import datetime
sys.path.insert(0, ".")

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
import requests

config = load_config()
client = AmazonAdsClient(config)

report_ids = {
    "sp_campaigns": "b9351874-02b3-4e10-8995-8148d2928983",
    "sp_campaigns_v2": "c0a48ad8-c2b5-4781-aee1-77e0eeb57556",
}

reports_dir = Path("reports/default")
reports_dir.mkdir(parents=True, exist_ok=True)

for name, rid in report_ids.items():
    print(f"\n--- {name} (ID: {rid}) ---")
    try:
        result = client.get(
            f"/reporting/reports/{rid}",
            accept="application/vnd.createasyncreportrequest.v3+json",
        )
        status = result.get("status")
        print(f"  Status: {status}")
        
        if status != "COMPLETED":
            print(f"  Skipping (not completed)")
            continue
        
        url = result.get("url", "")
        if not url:
            print(f"  ERROR: No download URL")
            continue
            
        print(f"  Downloading from S3...")
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        print(f"  Downloaded {len(resp.content)} bytes")
        
        # Decompress
        data = gzip.decompress(resp.content)
        records = json.loads(data)
        print(f"  Parsed {len(records)} rows")
        
        if records:
            # Save as CSV
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filepath = reports_dir / f"{name}_{ts}.csv"
            with open(filepath, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=list(records[0].keys()))
                writer.writeheader()
                writer.writerows(records)
            print(f"  Saved to: {filepath}")
            
            # Print summary
            total_cost = sum(float(r.get("cost", 0)) for r in records)
            total_sales = sum(float(r.get("sales1d", r.get("sales14d", 0))) for r in records)
            total_clicks = sum(int(r.get("clicks", 0)) for r in records)
            total_impressions = sum(int(r.get("impressions", 0)) for r in records)
            print(f"  Impressions: {total_impressions:,}")
            print(f"  Clicks: {total_clicks:,}")
            print(f"  Cost: Rs.{total_cost:,.2f}")
            print(f"  Sales: Rs.{total_sales:,.2f}")
            if total_sales > 0:
                acos = total_cost / total_sales * 100
                print(f"  ACoS: {acos:.1f}%")
            if total_cost > 0:
                roas = total_sales / total_cost
                print(f"  ROAS: {roas:.2f}x")
    except Exception as e:
        print(f"  ERROR: {e}")
        import traceback
        traceback.print_exc()

print("\nDone!")
