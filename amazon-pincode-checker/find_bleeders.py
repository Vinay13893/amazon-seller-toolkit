"""Find bleeding campaigns (high ACoS) from SP campaign report."""
import time
import json
from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient

config = load_config()
client = AmazonAdsClient(config)

report_id = "a2bb3bb1-69b5-4071-96c1-aed3c4c35b77"

for i in range(30):
    result = client.get(
        f"/reporting/reports/{report_id}",
        accept="application/vnd.createasyncreportrequest.v3+json",
    )
    status = result.get("status")
    print(f"Poll {i+1}: {status}")

    if status == "COMPLETED":
        url = result.get("url")
        data = client.download_gzip_report(url)
        print(f"\nDownloaded {len(data)} campaign rows")

        bleeders = []
        for row in data:
            cost = float(row.get("cost", 0))
            sales = float(row.get("sales1d", 0))
            clicks = int(row.get("clicks", 0))
            impressions = int(row.get("impressions", 0))
            status_val = row.get("campaignStatus", "")

            if cost > 0:
                acos = (cost / sales * 100) if sales > 0 else float("inf")
                if acos > 80 or sales == 0:
                    bleeders.append({
                        "name": row.get("campaignName", ""),
                        "status": status_val,
                        "cost": cost,
                        "sales": sales,
                        "clicks": clicks,
                        "impressions": impressions,
                        "acos": acos,
                    })

        bleeders.sort(key=lambda x: x["cost"], reverse=True)

        print(f"\n{'='*110}")
        print(f"  BLEEDING CAMPAIGNS (ACoS > 80%) — Last 30 Days")
        print(f"{'='*110}")
        print(f"  Found {len(bleeders)} bleeding campaigns\n")
        print(f"  {'Campaign':<50} {'Status':<10} {'Spend':>10} {'Sales':>10} {'Clicks':>7} {'ACoS':>8}")
        print(f"  {'-'*100}")

        total_wasted = 0
        for b in bleeders:
            acos_str = f"{b['acos']:.1f}%" if b["acos"] != float("inf") else "INF (0 sales)"
            print(f"  {b['name'][:49]:<50} {b['status']:<10} Rs{b['cost']:>8.2f} Rs{b['sales']:>8.2f} {b['clicks']:>7} {acos_str:>13}")
            total_wasted += b["cost"]

        print(f"\n  Total spend on bleeding campaigns: Rs {total_wasted:,.2f}")

        # Also show enabled ones specifically
        enabled_bleeders = [b for b in bleeders if b["status"] == "ENABLED"]
        if enabled_bleeders:
            print(f"\n  {'='*110}")
            print(f"  CURRENTLY ENABLED BLEEDERS ({len(enabled_bleeders)} campaigns)")
            print(f"  {'='*110}")
            for b in enabled_bleeders:
                acos_str = f"{b['acos']:.1f}%" if b["acos"] != float("inf") else "INF (0 sales)"
                print(f"  {b['name'][:49]:<50} Rs{b['cost']:>8.2f} Rs{b['sales']:>8.2f} {b['clicks']:>7} {acos_str:>13}")
        break

    elif status == "FAILURE":
        print("Report FAILED:", result)
        break

    time.sleep(15)
else:
    print("Timed out waiting for report")
