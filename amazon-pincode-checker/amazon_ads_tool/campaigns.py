"""
Campaign management - listing, filtering, bulk operations.
Provides a higher-level interface over the raw API client.
"""

import logging
from typing import Optional
from dataclasses import dataclass

from .api_client import AmazonAdsClient
from .config import AmazonAdsConfig

logger = logging.getLogger(__name__)


@dataclass
class CampaignSummary:
    """Unified campaign summary across ad types."""
    campaign_id: str
    name: str
    ad_type: str  # SP, SB, SD
    status: str
    budget: float
    budget_type: str
    targeting_type: str  # manual, auto
    start_date: str
    end_date: str


class CampaignManager:
    """High-level campaign management operations."""

    def __init__(self, client: AmazonAdsClient, config: AmazonAdsConfig):
        self.client = client
        self.config = config

    # ── Listing ─────────────────────────────────────────────────────

    def list_all_campaigns(self, include_paused: bool = True) -> list[CampaignSummary]:
        """List all campaigns across SP, SB, SD."""
        all_campaigns = []
        states = ["ENABLED"]
        if include_paused:
            states.append("PAUSED")

        # Sponsored Products
        try:
            sp_campaigns = self.client.sp_list_campaigns(states=states)
            for c in sp_campaigns:
                all_campaigns.append(CampaignSummary(
                    campaign_id=str(c.get("campaignId", "")),
                    name=c.get("name", ""),
                    ad_type="SP",
                    status=c.get("state", ""),
                    budget=float(c.get("budget", {}).get("budget", 0)),
                    budget_type=c.get("budget", {}).get("budgetType", ""),
                    targeting_type=c.get("targetingType", ""),
                    start_date=c.get("startDate", ""),
                    end_date=c.get("endDate", ""),
                ))
        except Exception as e:
            logger.error("Failed to list SP campaigns: %s", e)

        # Sponsored Brands
        try:
            sb_campaigns = self.client.sb_list_campaigns()
            for c in sb_campaigns:
                all_campaigns.append(CampaignSummary(
                    campaign_id=str(c.get("campaignId", "")),
                    name=c.get("name", ""),
                    ad_type="SB",
                    status=c.get("state", ""),
                    budget=float(c.get("budget", 0)),
                    budget_type=c.get("budgetType", ""),
                    targeting_type="",
                    start_date=c.get("startDate", ""),
                    end_date=c.get("endDate", ""),
                ))
        except Exception as e:
            logger.error("Failed to list SB campaigns: %s", e)

        # Sponsored Display
        try:
            sd_campaigns = self.client.sd_list_campaigns()
            for c in sd_campaigns:
                budget_val = c.get("budget", 0)
                if isinstance(budget_val, dict):
                    budget_val = budget_val.get("budget", 0)
                all_campaigns.append(CampaignSummary(
                    campaign_id=str(c.get("campaignId", "")),
                    name=c.get("name", ""),
                    ad_type="SD",
                    status=c.get("state", ""),
                    budget=float(budget_val),
                    budget_type=c.get("budgetType", "") if isinstance(c.get("budget"), dict) else "",
                    targeting_type=c.get("targetingType", ""),
                    start_date=c.get("startDate", ""),
                    end_date=c.get("endDate", ""),
                ))
        except Exception as e:
            logger.error("Failed to list SD campaigns: %s", e)

        logger.info("Found %d total campaigns (SP: %d, SB: %d, SD: %d)",
                     len(all_campaigns),
                     sum(1 for c in all_campaigns if c.ad_type == "SP"),
                     sum(1 for c in all_campaigns if c.ad_type == "SB"),
                     sum(1 for c in all_campaigns if c.ad_type == "SD"))
        return all_campaigns

    # ── Bulk Operations ─────────────────────────────────────────────

    def pause_campaign(self, campaign_id: str, ad_type: str) -> dict:
        """Pause a campaign by ID."""
        updates = {"state": "paused"}
        if ad_type == "SP":
            return self.client.sp_update_campaign(campaign_id, updates)
        elif ad_type == "SB":
            return self.client.sb_update_campaign(campaign_id, updates)
        elif ad_type == "SD":
            return self.client.sd_update_campaign(campaign_id, updates)
        raise ValueError(f"Unknown ad type: {ad_type}")

    def enable_campaign(self, campaign_id: str, ad_type: str) -> dict:
        """Enable a campaign by ID."""
        updates = {"state": "enabled"}
        if ad_type == "SP":
            return self.client.sp_update_campaign(campaign_id, updates)
        elif ad_type == "SB":
            return self.client.sb_update_campaign(campaign_id, updates)
        elif ad_type == "SD":
            return self.client.sd_update_campaign(campaign_id, updates)
        raise ValueError(f"Unknown ad type: {ad_type}")

    def update_budget(self, campaign_id: str, ad_type: str, new_budget: float) -> dict:
        """Update campaign daily budget."""
        if ad_type == "SP":
            updates = {"budget": {"budget": new_budget, "budgetType": "DAILY"}}
            return self.client.sp_update_campaign(campaign_id, updates)
        elif ad_type == "SB":
            updates = {"budget": new_budget}
            return self.client.sb_update_campaign(campaign_id, updates)
        elif ad_type == "SD":
            updates = {"budget": {"budget": new_budget, "budgetType": "DAILY"}}
            return self.client.sd_update_campaign(campaign_id, updates)
        raise ValueError(f"Unknown ad type: {ad_type}")

    def pause_bleeding_campaigns(self, report_data: list[dict], max_acos: float = 100.0) -> list[dict]:
        """Pause campaigns with ACoS above threshold (bleeding money)."""
        paused = []
        for row in report_data:
            cost = float(row.get("cost", 0))
            sales_key = "sales1d" if "sales1d" in row else "sales14d"
            sales = float(row.get(sales_key, 0))

            if cost > 0 and sales > 0:
                acos = (cost / sales) * 100
                if acos > max_acos:
                    campaign_id = row.get("campaignId", "")
                    name = row.get("campaignName", "")
                    logger.warning("Campaign '%s' has ACoS %.1f%% (>%.1f%%). Pausing.", name, acos, max_acos)
                    paused.append({"campaignId": campaign_id, "name": name, "acos": acos})
            elif cost > 0 and sales == 0:
                # Spent money with zero sales
                campaign_id = row.get("campaignId", "")
                name = row.get("campaignName", "")
                if cost > self.config.max_bid * 10:  # Only if significant spend
                    logger.warning("Campaign '%s' spent ₹%.2f with 0 sales. Flagging.", name, cost)
                    paused.append({"campaignId": campaign_id, "name": name, "acos": float("inf"), "cost": cost})

        return paused
