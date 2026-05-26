"""Pull this month's ad spend from Amazon Ads API (SP + SD + SB)."""

import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(__file__))

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
from amazon_ads_tool.reports import ReportManager

def main():
    config = load_config()
    client = AmazonAdsClient(config)
    rm = ReportManager(client, config)

    # This month: 1st to yesterday
    today = datetime.now()
    start_date = today.replace(day=1).strftime("%Y-%m-%d")
    yesterday = (today - timedelta(days=1)).strftime("%Y-%m-%d")

    print(f"Pulling spend from {start_date} to {yesterday}\n")

    report_types = ["sp_campaigns", "sd_campaigns", "sb_campaigns"]
    grand_total = 0.0

    for rt in report_types:
        label = rt.upper().replace("_", " ")
        try:
            print(f"--- {label} ---")
            data = rm.download_report(rt, start_date=start_date, end_date=yesterday)
            
            type_total = 0.0
            for row in data:
                cost = float(row.get("cost", 0))
                name = row.get("campaignName", "?")
                status = row.get("campaignStatus", "?")
                impressions = row.get("impressions", 0)
                clicks = row.get("clicks", 0)
                
                # SP uses purchases1d/sales1d, SD/SB use purchases/sales
                orders = row.get("purchases1d", row.get("purchases", 0))
                sales = float(row.get("sales1d", row.get("sales", 0)))
                
                if cost > 0:
                    acos = (cost / sales * 100) if sales > 0 else 999
                    print(f"  {name[:50]:50s}  ₹{cost:>10.2f}  orders={orders}  sales=₹{sales:.0f}  ACoS={acos:.1f}%")
                type_total += cost
            
            print(f"  {'SUBTOTAL':50s}  ₹{type_total:>10.2f}")
            print()
            grand_total += type_total
        except Exception as e:
            print(f"  ERROR: {e}\n")

    print(f"{'='*70}")
    print(f"  GRAND TOTAL SPEND (April {today.year}):  ₹{grand_total:,.2f}")
    print(f"{'='*70}")

if __name__ == "__main__":
    main()
