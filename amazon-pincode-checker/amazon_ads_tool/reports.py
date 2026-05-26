"""
Report generation and downloading for Amazon Ads API v3.
Supports SP, SD, and SB async reports.
"""

import os
import csv
import json
import time
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from .config import (
    AmazonAdsConfig,
    SP_REPORT_METRICS, SP_TARGETING_METRICS, SP_SEARCH_TERM_METRICS,
    SD_REPORT_METRICS, SB_REPORT_METRICS, SP_ADVERTISED_PRODUCT_METRICS,
)
from .api_client import AmazonAdsClient

logger = logging.getLogger(__name__)

# Report type configurations
REPORT_CONFIGS = {
    "sp_campaigns": {
        "record_type": "spCampaigns",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SP Campaign Report",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["campaign"],
                "columns": SP_REPORT_METRICS,
                "reportTypeId": "spCampaigns",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sp_targeting": {
        "record_type": "spTargeting",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SP Targeting Report",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["targeting"],
                "columns": SP_TARGETING_METRICS,
                "reportTypeId": "spTargeting",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sp_search_terms": {
        "record_type": "spSearchTerm",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SP Search Term Report",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["searchTerm"],
                "columns": SP_SEARCH_TERM_METRICS,
                "reportTypeId": "spSearchTerm",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sd_campaigns": {
        "record_type": "sdCampaigns",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SD Campaign Report",
            "configuration": {
                "adProduct": "SPONSORED_DISPLAY",
                "groupBy": ["campaign"],
                "columns": SD_REPORT_METRICS,
                "reportTypeId": "sdCampaigns",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sb_campaigns": {
        "record_type": "sbCampaigns",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SB Campaign Report",
            "configuration": {
                "adProduct": "SPONSORED_BRANDS",
                "groupBy": ["campaign"],
                "columns": SB_REPORT_METRICS,
                "reportTypeId": "sbCampaigns",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sp_advertised_product": {
        "record_type": "spAdvertisedProduct",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SP Advertised Product Report",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["advertiser"],
                "columns": SP_ADVERTISED_PRODUCT_METRICS,
                "reportTypeId": "spAdvertisedProduct",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
    "sp_placement": {
        "record_type": "spCampaigns",
        "path": "/reporting/reports",
        "body_template": {
            "name": "SP Placement Report",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["campaign", "campaignPlacement"],
                "columns": [
                    "campaignName", "campaignId", "placementClassification",
                    "impressions", "clicks", "cost",
                    "purchases1d", "sales1d", "unitsSoldClicks1d",
                ],
                "reportTypeId": "spCampaigns",
                "format": "GZIP_JSON",
                "timeUnit": "SUMMARY",
            },
        },
    },
}


class ReportManager:
    """Handles requesting, polling, downloading, and saving reports."""

    def __init__(self, client: AmazonAdsClient, config: AmazonAdsConfig):
        self.client = client
        self.config = config
        self.reports_dir = Path(config.reports_dir) / config.client_name
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def _date_range(self, days_back: Optional[int] = None) -> dict:
        """Generate date range for report. End date is always yesterday."""
        days = days_back or self.config.report_lookback_days
        yesterday = datetime.now() - timedelta(days=1)
        end_date = yesterday.strftime("%Y-%m-%d")
        start_date = (yesterday - timedelta(days=days)).strftime("%Y-%m-%d")
        return {"startDate": start_date, "endDate": end_date}

    def request_report(self, report_type: str, days_back: Optional[int] = None,
                       start_date: Optional[str] = None, end_date: Optional[str] = None) -> str:
        """Request an async report. Returns the report ID.
        
        Args:
            report_type: One of the REPORT_CONFIGS keys.
            days_back: Number of days back from yesterday (used if start_date/end_date not given).
            start_date: Explicit start date as 'YYYY-MM-DD'.
            end_date: Explicit end date as 'YYYY-MM-DD'.
        """
        if report_type not in REPORT_CONFIGS:
            raise ValueError(f"Unknown report type: {report_type}. Choose from: {list(REPORT_CONFIGS.keys())}")

        config = REPORT_CONFIGS[report_type]
        body = json.loads(json.dumps(config["body_template"]))  # deep copy
        if start_date and end_date:
            body["startDate"] = start_date
            body["endDate"] = end_date
        else:
            body["startDate"] = self._date_range(days_back)["startDate"]
            body["endDate"] = self._date_range(days_back)["endDate"]

        logger.info("Requesting %s report (%s to %s)...", report_type, body["startDate"], body["endDate"])
        try:
            result = self.client.post(
                config["path"],
                body=body,
                accept="application/vnd.createasyncreportrequest.v3+json",
            )
            report_id = result.get("reportId", "")
        except Exception as e:
            # Handle 425 duplicate — extract existing report ID
            err_msg = str(e)
            if "425" in err_msg and "duplicate" in err_msg.lower():
                import re
                match = re.search(r"duplicate of\s*:\s*([a-f0-9-]+)", err_msg, re.IGNORECASE)
                if match:
                    report_id = match.group(1)
                    logger.info("Reusing existing report ID: %s", report_id)
                else:
                    raise
            else:
                raise
        logger.info("Report requested: %s (ID: %s)", report_type, report_id)
        return report_id

    def poll_report(self, report_id: str, max_wait: int = 300) -> str:
        """Poll until report is ready. Returns download URL."""
        start = time.time()
        poll_count = 0
        while time.time() - start < max_wait:
            result = self.client.get(
                f"/reporting/reports/{report_id}",
                accept="application/vnd.createasyncreportrequest.v3+json",
            )
            status = result.get("status", "")

            if status == "COMPLETED":
                url = result.get("url", "")
                logger.info("Report %s ready. Download URL obtained.", report_id)
                return url
            elif status == "FAILURE":
                raise RuntimeError(f"Report {report_id} failed: {result}")

            poll_count += 1
            elapsed = int(time.time() - start)
            print(f"        poll #{poll_count}: status={status}, elapsed={elapsed}s", flush=True)
            logger.info("Report %s status: %s. Waiting 10s...", report_id, status)
            time.sleep(10)

        raise TimeoutError(f"Report {report_id} did not complete within {max_wait}s")

    def download_report(self, report_type: str, days_back: Optional[int] = None,
                        start_date: Optional[str] = None, end_date: Optional[str] = None) -> list[dict]:
        """Request, poll, and download a report. Returns parsed data."""
        report_id = self.request_report(report_type, days_back, start_date=start_date, end_date=end_date)
        url = self.poll_report(report_id)
        data = self.client.download_gzip_report(url)
        logger.info("Downloaded %s report: %d rows", report_type, len(data))
        return data

    def download_and_save(self, report_type: str, days_back: Optional[int] = None) -> Path:
        """Download report and save as CSV."""
        data = self.download_report(report_type, days_back)
        if not data:
            logger.warning("No data in %s report", report_type)
            return None

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{report_type}_{timestamp}.csv"
        filepath = self.reports_dir / filename

        fieldnames = list(data[0].keys())
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(data)

        logger.info("Saved %s report to %s (%d rows)", report_type, filepath, len(data))
        return filepath

    def download_all_reports(self, days_back: Optional[int] = None) -> dict[str, Path]:
        """Download all report types and save to CSV."""
        results = {}
        for report_type in REPORT_CONFIGS:
            try:
                filepath = self.download_and_save(report_type, days_back)
                results[report_type] = filepath
            except Exception as e:
                logger.error("Failed to download %s: %s", report_type, e)
                results[report_type] = None
        return results

    def load_latest_report(self, report_type: str) -> list[dict]:
        """Load the most recent saved CSV report of a given type."""
        pattern = f"{report_type}_*.csv"
        files = sorted(self.reports_dir.glob(pattern), reverse=True)
        if not files:
            return []

        with open(files[0], newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            return list(reader)
