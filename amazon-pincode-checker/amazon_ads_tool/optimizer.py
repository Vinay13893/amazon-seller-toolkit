"""
Bid optimization and search term harvesting engine.
Core automation logic for monthly campaign optimization.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

from .api_client import AmazonAdsClient
from .config import AmazonAdsConfig

logger = logging.getLogger(__name__)


@dataclass
class BidAction:
    """A proposed or executed bid change."""
    keyword_id: str
    target_id: str
    campaign_name: str
    ad_group_name: str
    keyword_text: str
    match_type: str
    current_bid: float
    new_bid: float
    reason: str
    acos: float
    clicks: int
    impressions: int
    sales: float
    cost: float
    action_type: str  # "increase", "decrease", "pause"
    executed: bool = False


@dataclass
class SearchTermAction:
    """A proposed search term harvest or negation."""
    search_term: str
    campaign_id: str
    campaign_name: str
    ad_group_id: str
    ad_group_name: str
    clicks: int
    impressions: int
    cost: float
    sales: float
    orders: int
    action: str  # "harvest_exact", "harvest_phrase", "negate_exact", "negate_phrase"
    reason: str
    executed: bool = False


class BidOptimizer:
    """Automated bid optimization based on performance data."""

    def __init__(self, client: AmazonAdsClient, config: AmazonAdsConfig):
        self.client = client
        self.config = config

    def analyze_targeting_report(self, targeting_data: list[dict]) -> list[BidAction]:
        """Analyze targeting report and generate bid adjustment recommendations."""
        actions = []

        for row in targeting_data:
            clicks = int(row.get("clicks", 0))
            impressions = int(row.get("impressions", 0))
            cost = float(row.get("cost", 0))
            sales = float(row.get("sales1d", row.get("sales", 0)))
            orders = int(row.get("purchases1d", row.get("purchases", 0)))
            campaign_name = row.get("campaignName", "")
            ad_group_name = row.get("adGroupName", "")
            keyword_text = row.get("keyword", row.get("targeting", row.get("targetingText", "")))
            keyword_id = row.get("keywordId", "")
            target_id = row.get("targetId", "")
            current_bid = float(row.get("keywordBid") or row.get("bid") or 0)

            # Skip rows with insufficient data
            if clicks < self.config.min_clicks_for_decision:
                continue

            acos = (cost / sales * 100) if sales > 0 else float("inf")
            if current_bid == 0:
                continue

            # ── Decision Logic ──────────────────────────────────────

            # CASE 1: Great performer - ACoS well below target → increase bid
            if acos < self.config.target_acos * 0.7 and orders >= 2:
                increase = self.config.bid_increase_pct / 100
                new_bid = min(current_bid * (1 + increase), self.config.max_bid)
                actions.append(BidAction(
                    keyword_id=keyword_id, target_id=target_id,
                    campaign_name=campaign_name, ad_group_name=ad_group_name,
                    keyword_text=keyword_text, match_type=row.get("matchType", ""),
                    current_bid=current_bid, new_bid=round(new_bid, 2),
                    reason=f"Strong performer: ACoS {acos:.1f}% < target {self.config.target_acos}%",
                    acos=acos, clicks=clicks, impressions=impressions,
                    sales=sales, cost=cost, action_type="increase",
                ))

            # CASE 2: ACoS above target but converting → decrease bid
            elif acos > self.config.target_acos * 1.3 and orders >= 1:
                decrease = self.config.bid_decrease_pct / 100
                new_bid = max(current_bid * (1 - decrease), self.config.min_bid)
                actions.append(BidAction(
                    keyword_id=keyword_id, target_id=target_id,
                    campaign_name=campaign_name, ad_group_name=ad_group_name,
                    keyword_text=keyword_text, match_type=row.get("matchType", ""),
                    current_bid=current_bid, new_bid=round(new_bid, 2),
                    reason=f"High ACoS: {acos:.1f}% > target {self.config.target_acos}%",
                    acos=acos, clicks=clicks, impressions=impressions,
                    sales=sales, cost=cost, action_type="decrease",
                ))

            # CASE 3: Many clicks, zero sales → pause or heavy decrease
            elif clicks >= self.config.negate_after_clicks and orders == 0:
                new_bid = self.config.min_bid
                actions.append(BidAction(
                    keyword_id=keyword_id, target_id=target_id,
                    campaign_name=campaign_name, ad_group_name=ad_group_name,
                    keyword_text=keyword_text, match_type=row.get("matchType", ""),
                    current_bid=current_bid, new_bid=new_bid,
                    reason=f"No sales after {clicks} clicks (spent ₹{cost:.2f})",
                    acos=acos, clicks=clicks, impressions=impressions,
                    sales=sales, cost=cost, action_type="pause",
                ))

        logger.info("Generated %d bid actions from %d targeting rows", len(actions), len(targeting_data))
        return actions

    def execute_bid_actions(self, actions: list[BidAction], dry_run: bool = True) -> list[BidAction]:
        """Execute bid changes. Set dry_run=False to actually apply."""
        executed = []
        for action in actions:
            if dry_run:
                logger.info("[DRY RUN] %s: %s bid ₹%.2f → ₹%.2f (%s)",
                            action.action_type.upper(), action.keyword_text,
                            action.current_bid, action.new_bid, action.reason)
                action.executed = False
                executed.append(action)
                continue

            try:
                if action.action_type == "pause":
                    if action.keyword_id:
                        self.client.sp_update_keyword(action.keyword_id, {"state": "paused"})
                    elif action.target_id:
                        self.client.sp_update_target(action.target_id, {"state": "paused"})
                else:
                    new_bid = action.new_bid
                    if action.keyword_id:
                        self.client.sp_update_keyword(action.keyword_id, {"bid": new_bid})
                    elif action.target_id:
                        self.client.sp_update_target(action.target_id, {"bid": new_bid})

                action.executed = True
                logger.info("EXECUTED %s: %s bid ₹%.2f → ₹%.2f",
                            action.action_type.upper(), action.keyword_text,
                            action.current_bid, action.new_bid)

            except Exception as e:
                logger.error("Failed to execute %s on %s: %s",
                             action.action_type, action.keyword_text, e)
                action.executed = False

            executed.append(action)
        return executed


class SearchTermHarvester:
    """Harvest converting search terms and negate non-performers."""

    def __init__(self, client: AmazonAdsClient, config: AmazonAdsConfig):
        self.client = client
        self.config = config

    def analyze_search_terms(self, search_term_data: list[dict]) -> list[SearchTermAction]:
        """Analyze search term report and generate harvest/negate recommendations."""
        actions = []

        for row in search_term_data:
            search_term = row.get("searchTerm", "").strip()
            if not search_term:
                continue

            clicks = int(row.get("clicks", 0))
            impressions = int(row.get("impressions", 0))
            cost = float(row.get("cost", 0))
            sales = float(row.get("sales1d", row.get("sales", 0)))
            orders = int(row.get("purchases1d", row.get("purchases", 0)))
            campaign_id = row.get("campaignId", "")
            campaign_name = row.get("campaignName", "")
            ad_group_id = row.get("adGroupId", "")
            ad_group_name = row.get("adGroupName", "")

            # ── Harvest: converting search terms → exact match keywords ──
            if orders >= self.config.search_term_harvest_threshold:
                acos = (cost / sales * 100) if sales > 0 else float("inf")
                if acos <= self.config.target_acos * 1.5:
                    actions.append(SearchTermAction(
                        search_term=search_term,
                        campaign_id=campaign_id, campaign_name=campaign_name,
                        ad_group_id=ad_group_id, ad_group_name=ad_group_name,
                        clicks=clicks, impressions=impressions,
                        cost=cost, sales=sales, orders=orders,
                        action="harvest_exact",
                        reason=f"Converting: {orders} orders, ACoS {acos:.1f}%",
                    ))

            # ── Negate: high clicks, zero conversions ──
            elif clicks >= self.config.negate_after_clicks and orders == 0:
                actions.append(SearchTermAction(
                    search_term=search_term,
                    campaign_id=campaign_id, campaign_name=campaign_name,
                    ad_group_id=ad_group_id, ad_group_name=ad_group_name,
                    clicks=clicks, impressions=impressions,
                    cost=cost, sales=sales, orders=orders,
                    action="negate_exact",
                    reason=f"Wasted spend: {clicks} clicks, ₹{cost:.2f} cost, 0 sales",
                ))

        # Deduplicate by search term + action
        seen = set()
        unique_actions = []
        for a in actions:
            key = (a.search_term.lower(), a.action, a.ad_group_id)
            if key not in seen:
                seen.add(key)
                unique_actions.append(a)

        logger.info("Generated %d search term actions (%d harvest, %d negate)",
                     len(unique_actions),
                     sum(1 for a in unique_actions if "harvest" in a.action),
                     sum(1 for a in unique_actions if "negate" in a.action))
        return unique_actions

    def execute_search_term_actions(self, actions: list[SearchTermAction], dry_run: bool = True) -> list[SearchTermAction]:
        """Execute search term harvesting and negation."""
        executed = []
        for action in actions:
            if dry_run:
                logger.info("[DRY RUN] %s: '%s' in %s (%s)",
                            action.action.upper(), action.search_term,
                            action.campaign_name, action.reason)
                action.executed = False
                executed.append(action)
                continue

            try:
                if action.action == "harvest_exact":
                    self.client.sp_create_keywords([{
                        "campaignId": action.campaign_id,
                        "adGroupId": action.ad_group_id,
                        "keywordText": action.search_term,
                        "matchType": "EXACT",
                        "state": "enabled",
                    }])
                    action.executed = True

                elif action.action == "negate_exact":
                    self.client.sp_create_negative_keywords([{
                        "campaignId": action.campaign_id,
                        "adGroupId": action.ad_group_id,
                        "keywordText": action.search_term,
                        "matchType": "NEGATIVE_EXACT",
                        "state": "enabled",
                    }])
                    action.executed = True

                logger.info("EXECUTED %s: '%s'", action.action.upper(), action.search_term)

            except Exception as e:
                logger.error("Failed to %s '%s': %s", action.action, action.search_term, e)
                action.executed = False

            executed.append(action)
        return executed
