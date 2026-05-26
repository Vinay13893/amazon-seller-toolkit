"""
Performance analyzer - generates monthly insights and recommendations.
Produces human-readable reports for agency clients.
"""

import csv
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional
from dataclasses import dataclass

from .config import AmazonAdsConfig
from .optimizer import BidAction, SearchTermAction

logger = logging.getLogger(__name__)


@dataclass
class CampaignMetrics:
    """Computed metrics for a campaign."""
    campaign_id: str
    campaign_name: str
    ad_type: str
    impressions: int = 0
    clicks: int = 0
    cost: float = 0.0
    sales: float = 0.0
    orders: int = 0
    units: int = 0

    @property
    def ctr(self) -> float:
        return (self.clicks / self.impressions * 100) if self.impressions > 0 else 0.0

    @property
    def cpc(self) -> float:
        return (self.cost / self.clicks) if self.clicks > 0 else 0.0

    @property
    def acos(self) -> float:
        return (self.cost / self.sales * 100) if self.sales > 0 else float("inf")

    @property
    def roas(self) -> float:
        return (self.sales / self.cost) if self.cost > 0 else 0.0

    @property
    def conversion_rate(self) -> float:
        return (self.orders / self.clicks * 100) if self.clicks > 0 else 0.0


class PerformanceAnalyzer:
    """Generates performance analysis and monthly reports."""

    def __init__(self, config: AmazonAdsConfig):
        self.config = config
        self.reports_dir = Path(config.reports_dir) / config.client_name
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def compute_campaign_metrics(self, report_data: list[dict], ad_type: str = "SP") -> list[CampaignMetrics]:
        """Parse report data into structured metrics."""
        campaigns: dict[str, CampaignMetrics] = {}

        # Handle both old (1d/14d suffix) and new (no suffix) column names
        for suffix in ("1d", "14d", ""):
            sales_key = f"sales{suffix}" if suffix else "sales"
            orders_key = f"purchases{suffix}" if suffix else "purchases"
            units_key = f"unitsSoldClicks{suffix}" if suffix else "unitsSoldClicks"
            # Check if first row has this key pattern
            if report_data and (sales_key in report_data[0] or orders_key in report_data[0]):
                break
        else:
            # Default fallback
            sales_key = "sales"
            orders_key = "purchases"
            units_key = "unitsSoldClicks"

        for row in report_data:
            cid = row.get("campaignId", "")
            if cid not in campaigns:
                campaigns[cid] = CampaignMetrics(
                    campaign_id=cid,
                    campaign_name=row.get("campaignName", ""),
                    ad_type=ad_type,
                )
            m = campaigns[cid]
            m.impressions += int(row.get("impressions", 0))
            m.clicks += int(row.get("clicks", 0))
            m.cost += float(row.get("cost", 0))
            m.sales += float(row.get(sales_key, 0))
            m.orders += int(row.get(orders_key, 0))
            m.units += int(row.get(units_key, 0))

        return sorted(campaigns.values(), key=lambda m: m.cost, reverse=True)

    def generate_monthly_report(
        self,
        sp_data: list[dict],
        sd_data: list[dict],
        sb_data: list[dict],
        bid_actions: Optional[list[BidAction]] = None,
        search_term_actions: Optional[list[SearchTermAction]] = None,
    ) -> str:
        """Generate a comprehensive monthly performance report as markdown."""
        sp_metrics = self.compute_campaign_metrics(sp_data, "SP")
        sd_metrics = self.compute_campaign_metrics(sd_data, "SD")
        sb_metrics = self.compute_campaign_metrics(sb_data, "SB")
        all_metrics = sp_metrics + sd_metrics + sb_metrics

        # Aggregate totals
        total_impressions = sum(m.impressions for m in all_metrics)
        total_clicks = sum(m.clicks for m in all_metrics)
        total_cost = sum(m.cost for m in all_metrics)
        total_sales = sum(m.sales for m in all_metrics)
        total_orders = sum(m.orders for m in all_metrics)

        overall_ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
        overall_cpc = (total_cost / total_clicks) if total_clicks > 0 else 0
        overall_acos = (total_cost / total_sales * 100) if total_sales > 0 else 0
        overall_roas = (total_sales / total_cost) if total_cost > 0 else 0
        overall_cvr = (total_orders / total_clicks * 100) if total_clicks > 0 else 0

        report_date = datetime.now().strftime("%B %Y")
        lines = []

        # ── Header ──
        lines.append(f"# Amazon Ads Monthly Report - {report_date}")
        lines.append(f"**Client:** {self.config.client_name}")
        lines.append(f"**Period:** Last {self.config.report_lookback_days} days")
        lines.append(f"**Target ACoS:** {self.config.target_acos}%")
        lines.append("")

        # ── Overall Summary ──
        lines.append("## Overall Performance Summary")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| Total Spend | ₹{total_cost:,.2f} |")
        lines.append(f"| Total Sales | ₹{total_sales:,.2f} |")
        lines.append(f"| Total Orders | {total_orders:,} |")
        lines.append(f"| Impressions | {total_impressions:,} |")
        lines.append(f"| Clicks | {total_clicks:,} |")
        lines.append(f"| CTR | {overall_ctr:.2f}% |")
        lines.append(f"| CPC | ₹{overall_cpc:.2f} |")
        lines.append(f"| ACoS | {overall_acos:.2f}% |")
        lines.append(f"| ROAS | {overall_roas:.2f}x |")
        lines.append(f"| Conversion Rate | {overall_cvr:.2f}% |")
        lines.append("")

        # ── By Ad Type ──
        lines.append("## Performance by Ad Type")
        lines.append("")
        for ad_type, metrics_list in [("Sponsored Products", sp_metrics), ("Sponsored Display", sd_metrics), ("Sponsored Brands", sb_metrics)]:
            if not metrics_list:
                continue
            t_imp = sum(m.impressions for m in metrics_list)
            t_clk = sum(m.clicks for m in metrics_list)
            t_cost = sum(m.cost for m in metrics_list)
            t_sales = sum(m.sales for m in metrics_list)
            t_orders = sum(m.orders for m in metrics_list)
            t_acos = (t_cost / t_sales * 100) if t_sales > 0 else 0
            t_roas = (t_sales / t_cost) if t_cost > 0 else 0

            lines.append(f"### {ad_type}")
            lines.append(f"- **Campaigns:** {len(metrics_list)}")
            lines.append(f"- **Spend:** ₹{t_cost:,.2f} | **Sales:** ₹{t_sales:,.2f} | **Orders:** {t_orders:,}")
            lines.append(f"- **ACoS:** {t_acos:.2f}% | **ROAS:** {t_roas:.2f}x")
            lines.append("")

        # ── Top Campaigns ──
        lines.append("## Top 10 Campaigns by Spend")
        lines.append("")
        lines.append("| # | Campaign | Type | Spend | Sales | ACoS | ROAS | CTR | Orders |")
        lines.append("|---|----------|------|-------|-------|------|------|-----|--------|")
        for i, m in enumerate(all_metrics[:10], 1):
            acos_str = f"{m.acos:.1f}%" if m.acos != float("inf") else "∞"
            lines.append(f"| {i} | {m.campaign_name[:40]} | {m.ad_type} | ₹{m.cost:,.2f} | ₹{m.sales:,.2f} | {acos_str} | {m.roas:.2f}x | {m.ctr:.2f}% | {m.orders} |")
        lines.append("")

        # ── Problem Campaigns ──
        problem_campaigns = [m for m in all_metrics if m.acos > self.config.target_acos * 2 and m.cost > 100]
        if problem_campaigns:
            lines.append("## ⚠️ Problem Campaigns (ACoS > 2x Target)")
            lines.append("")
            lines.append("| Campaign | Type | Spend | Sales | ACoS | Action Needed |")
            lines.append("|----------|------|-------|-------|------|---------------|")
            for m in problem_campaigns[:10]:
                acos_str = f"{m.acos:.1f}%" if m.acos != float("inf") else "∞"
                action = "Pause" if m.orders == 0 else "Reduce bids"
                lines.append(f"| {m.campaign_name[:40]} | {m.ad_type} | ₹{m.cost:,.2f} | ₹{m.sales:,.2f} | {acos_str} | {action} |")
            lines.append("")

        # ── Star Campaigns ──
        star_campaigns = [m for m in all_metrics if m.acos < self.config.target_acos and m.orders >= 5]
        if star_campaigns:
            lines.append("## ⭐ Star Campaigns (Below Target ACoS)")
            lines.append("")
            lines.append("| Campaign | Type | Spend | Sales | ACoS | ROAS | Orders |")
            lines.append("|----------|------|-------|-------|------|------|--------|")
            for m in star_campaigns[:10]:
                lines.append(f"| {m.campaign_name[:40]} | {m.ad_type} | ₹{m.cost:,.2f} | ₹{m.sales:,.2f} | {m.acos:.1f}% | {m.roas:.2f}x | {m.orders} |")
            lines.append("")

        # ── Bid Actions Summary ──
        if bid_actions:
            lines.append("## Bid Optimization Actions")
            lines.append("")
            increases = [a for a in bid_actions if a.action_type == "increase"]
            decreases = [a for a in bid_actions if a.action_type == "decrease"]
            pauses = [a for a in bid_actions if a.action_type == "pause"]
            lines.append(f"- **Bid Increases:** {len(increases)} keywords (strong performers)")
            lines.append(f"- **Bid Decreases:** {len(decreases)} keywords (high ACoS)")
            lines.append(f"- **Paused:** {len(pauses)} keywords (zero conversions)")
            lines.append("")

        # ── Search Term Actions Summary ──
        if search_term_actions:
            lines.append("## Search Term Optimization")
            lines.append("")
            harvested = [a for a in search_term_actions if "harvest" in a.action]
            negated = [a for a in search_term_actions if "negate" in a.action]
            lines.append(f"- **Harvested to Exact:** {len(harvested)} search terms")
            lines.append(f"- **Negated:** {len(negated)} search terms")
            lines.append("")

            if harvested:
                lines.append("### Top Harvested Search Terms")
                lines.append("| Search Term | Orders | Sales | ACoS |")
                lines.append("|-------------|--------|-------|------|")
                for a in sorted(harvested, key=lambda x: x.orders, reverse=True)[:10]:
                    acos = (a.cost / a.sales * 100) if a.sales > 0 else 0
                    lines.append(f"| {a.search_term} | {a.orders} | ₹{a.sales:,.2f} | {acos:.1f}% |")
                lines.append("")

            if negated:
                lines.append("### Top Negated Search Terms (Wasted Spend)")
                lines.append("| Search Term | Clicks | Cost Wasted |")
                lines.append("|-------------|--------|-------------|")
                for a in sorted(negated, key=lambda x: x.cost, reverse=True)[:10]:
                    lines.append(f"| {a.search_term} | {a.clicks} | ₹{a.cost:,.2f} |")
                lines.append("")

        # ── Recommendations ──
        lines.append("## Recommendations")
        lines.append("")
        lines.append("1. **Budget Reallocation:** Shift budget from high-ACoS campaigns to star performers")
        if problem_campaigns:
            lines.append(f"2. **Pause/Fix:** {len(problem_campaigns)} campaigns need immediate attention")
        if star_campaigns:
            lines.append(f"3. **Scale Up:** {len(star_campaigns)} campaigns have room to grow (increase budgets by 20-30%)")
        lines.append("4. **Search Term Mining:** Run search term harvesting weekly for better keyword coverage")
        lines.append("5. **Negative Keywords:** Continue negating non-converting search terms to reduce wasted spend")
        lines.append("")

        report_text = "\n".join(lines)

        # Save report
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_path = self.reports_dir / f"monthly_report_{timestamp}.md"
        report_path.write_text(report_text, encoding="utf-8")
        logger.info("Saved monthly report to %s", report_path)

        return report_text

    def export_actions_csv(
        self,
        bid_actions: list[BidAction],
        search_term_actions: list[SearchTermAction],
    ) -> Path:
        """Export all optimization actions to CSV for review."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = self.reports_dir / f"optimization_actions_{timestamp}.csv"

        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "Action Type", "Item", "Campaign", "Ad Group",
                "Current Bid", "New Bid", "ACoS", "Clicks", "Cost", "Sales", "Orders",
                "Reason", "Executed"
            ])

            for a in bid_actions:
                writer.writerow([
                    f"BID_{a.action_type.upper()}", a.keyword_text,
                    a.campaign_name, a.ad_group_name,
                    a.current_bid, a.new_bid, f"{a.acos:.1f}%",
                    a.clicks, a.cost, a.sales, "",
                    a.reason, a.executed,
                ])

            for a in search_term_actions:
                writer.writerow([
                    a.action.upper(), a.search_term,
                    a.campaign_name, a.ad_group_name,
                    "", "", "",
                    a.clicks, a.cost, a.sales, a.orders,
                    a.reason, a.executed,
                ])

        logger.info("Exported %d actions to %s",
                     len(bid_actions) + len(search_term_actions), filepath)
        return filepath
