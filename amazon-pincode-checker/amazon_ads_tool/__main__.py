"""
CLI entry point for Amazon Ads Automation Tool.
Run: python -m amazon_ads_tool <command>
"""

import argparse
import logging
import sys
from pathlib import Path

from .config import load_config, load_all_clients, AmazonAdsConfig
from .api_client import AmazonAdsClient
from .reports import ReportManager
from .campaigns import CampaignManager
from .optimizer import BidOptimizer, SearchTermHarvester
from .analyzer import PerformanceAnalyzer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def cmd_profiles(config: AmazonAdsConfig):
    """List all advertising profiles."""
    client = AmazonAdsClient(config)
    profiles = client.list_profiles()
    print(f"\n{'ID':<20} {'Type':<15} {'Marketplace':<12} {'Name'}")
    print("-" * 70)
    for p in profiles:
        print(f"{p.get('profileId', ''):<20} {p.get('accountInfo', {}).get('type', ''):<15} "
              f"{p.get('countryCode', ''):<12} {p.get('accountInfo', {}).get('name', '')}")


def cmd_campaigns(config: AmazonAdsConfig):
    """List all campaigns across SP, SB, SD."""
    client = AmazonAdsClient(config)
    manager = CampaignManager(client, config)
    campaigns = manager.list_all_campaigns()

    print(f"\n{'Type':<5} {'Status':<10} {'Budget':>10} {'Targeting':<10} {'Name'}")
    print("-" * 80)
    for c in campaigns:
        print(f"{c.ad_type:<5} {c.status:<10} ₹{c.budget:>8,.2f} {c.targeting_type:<10} {c.name[:50]}")
    print(f"\nTotal: {len(campaigns)} campaigns")


def cmd_download_reports(config: AmazonAdsConfig, report_type: str = "all", days: int = 30):
    """Download reports from Amazon Ads API."""
    client = AmazonAdsClient(config)
    report_mgr = ReportManager(client, config)

    if report_type == "all":
        results = report_mgr.download_all_reports(days_back=days)
        for rtype, path in results.items():
            status = f"saved to {path}" if path else "FAILED"
            print(f"  {rtype}: {status}")
    else:
        path = report_mgr.download_and_save(report_type, days_back=days)
        print(f"  {report_type}: saved to {path}")


def cmd_optimize(config: AmazonAdsConfig, dry_run: bool = True):
    """Run bid optimization and search term harvesting."""
    client = AmazonAdsClient(config)
    report_mgr = ReportManager(client, config)

    print("Downloading targeting report...")
    targeting_data = report_mgr.download_report("sp_targeting")

    print("Downloading search term report...")
    search_term_data = report_mgr.download_report("sp_search_terms")

    # Bid optimization
    bid_optimizer = BidOptimizer(client, config)
    bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)

    # Search term harvesting
    harvester = SearchTermHarvester(client, config)
    st_actions = harvester.analyze_search_terms(search_term_data)

    mode = "DRY RUN" if dry_run else "LIVE"
    print(f"\n{'='*60}")
    print(f"  OPTIMIZATION RESULTS ({mode})")
    print(f"{'='*60}")
    print(f"  Bid increases:  {sum(1 for a in bid_actions if a.action_type == 'increase')}")
    print(f"  Bid decreases:  {sum(1 for a in bid_actions if a.action_type == 'decrease')}")
    print(f"  Keywords paused: {sum(1 for a in bid_actions if a.action_type == 'pause')}")
    print(f"  Terms harvested: {sum(1 for a in st_actions if 'harvest' in a.action)}")
    print(f"  Terms negated:   {sum(1 for a in st_actions if 'negate' in a.action)}")
    print(f"{'='*60}\n")

    if not dry_run:
        confirm = input("Apply these changes? (yes/no): ").strip().lower()
        if confirm != "yes":
            print("Aborted.")
            return

    bid_optimizer.execute_bid_actions(bid_actions, dry_run=dry_run)
    harvester.execute_search_term_actions(st_actions, dry_run=dry_run)

    # Export actions CSV
    analyzer = PerformanceAnalyzer(config)
    csv_path = analyzer.export_actions_csv(bid_actions, st_actions)
    print(f"\nActions exported to: {csv_path}")


def cmd_monthly_report(config: AmazonAdsConfig, days: int = 30):
    """Generate monthly performance report."""
    client = AmazonAdsClient(config)
    report_mgr = ReportManager(client, config)

    print("Downloading reports for analysis...")
    sp_data = report_mgr.download_report("sp_campaigns", days_back=days)
    sd_data = report_mgr.download_report("sd_campaigns", days_back=days)
    sb_data = report_mgr.download_report("sb_campaigns", days_back=days)

    # Also get optimization data
    print("Running optimization analysis...")
    targeting_data = report_mgr.download_report("sp_targeting", days_back=days)
    search_term_data = report_mgr.download_report("sp_search_terms", days_back=days)

    bid_optimizer = BidOptimizer(client, config)
    bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)

    harvester = SearchTermHarvester(client, config)
    st_actions = harvester.analyze_search_terms(search_term_data)

    # Generate report
    analyzer = PerformanceAnalyzer(config)
    report = analyzer.generate_monthly_report(
        sp_data, sd_data, sb_data,
        bid_actions=bid_actions,
        search_term_actions=st_actions,
    )

    print("\n" + report)
    print("\nReport saved to reports/ directory.")


def cmd_pause_bleeders(config: AmazonAdsConfig, max_acos: float = 100.0):
    """Find and optionally pause campaigns with ACoS above threshold."""
    client = AmazonAdsClient(config)
    report_mgr = ReportManager(client, config)
    manager = CampaignManager(client, config)

    print("Downloading SP campaign report...")
    sp_data = report_mgr.download_report("sp_campaigns")

    bleeders = manager.pause_bleeding_campaigns(sp_data, max_acos=max_acos)

    if not bleeders:
        print(f"\nNo campaigns with ACoS > {max_acos}%. All good!")
        return

    print(f"\n{'='*60}")
    print(f"  BLEEDING CAMPAIGNS (ACoS > {max_acos}%)")
    print(f"{'='*60}")
    for b in bleeders:
        acos_str = f"{b['acos']:.1f}%" if b['acos'] != float("inf") else "∞ (zero sales)"
        print(f"  {b['name'][:50]}: ACoS {acos_str}")
    print(f"\n  Total: {len(bleeders)} campaigns")

    confirm = input("\nPause these campaigns? (yes/no): ").strip().lower()
    if confirm == "yes":
        for b in bleeders:
            try:
                manager.pause_campaign(b["campaignId"], "SP")
                print(f"  Paused: {b['name']}")
            except Exception as e:
                print(f"  Failed to pause {b['name']}: {e}")


def cmd_report_all(days: int = 30):
    """Generate monthly report for ALL configured accounts."""
    clients = load_all_clients()
    if not clients:
        print("No clients configured. Set AMZN_ADS_CLIENTS in .env")
        return

    print(f"\n{'='*60}")
    print(f"  MULTI-ACCOUNT REPORT ({len(clients)} accounts)")
    print(f"{'='*60}\n")

    for client_name, config in clients.items():
        if not config.client_id or not config.refresh_token:
            print(f"⚠️  Skipping '{client_name}' - missing credentials\n")
            continue

        print(f"\n{'─'*60}")
        print(f"  Account: {client_name.upper()}")
        print(f"{'─'*60}")

        try:
            cmd_monthly_report(config, days=days)
        except Exception as e:
            print(f"  ❌ Error for '{client_name}': {e}\n")

    print(f"\n{'='*60}")
    print(f"  All reports saved to reports/<client_name>/ directories")
    print(f"{'='*60}\n")


def cmd_download_all(report_type: str = "all", days: int = 30):
    """Download reports for ALL configured accounts."""
    clients = load_all_clients()
    if not clients:
        print("No clients configured. Set AMZN_ADS_CLIENTS in .env")
        return

    print(f"\n{'='*60}")
    print(f"  MULTI-ACCOUNT DOWNLOAD ({len(clients)} accounts)")
    print(f"{'='*60}\n")

    for client_name, config in clients.items():
        if not config.client_id or not config.refresh_token:
            print(f"⚠️  Skipping '{client_name}' - missing credentials\n")
            continue

        print(f"\n{'─'*60}")
        print(f"  Account: {client_name.upper()}")
        print(f"{'─'*60}")

        try:
            cmd_download_reports(config, report_type, days)
        except Exception as e:
            print(f"  ❌ Error for '{client_name}': {e}\n")


def main():
    parser = argparse.ArgumentParser(
        description="Amazon Ads Automation Tool - Agency Edition",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands:
  profiles          List all advertising profiles
  campaigns         List all campaigns (SP, SB, SD)
  download          Download reports from Amazon Ads API
  optimize          Run bid optimization & search term harvesting (dry run)
  optimize-live     Run optimization and APPLY changes
  report            Generate monthly performance report
  pause-bleeders    Find & pause campaigns with very high ACoS
  report-all        Generate report for ALL configured accounts
  download-all      Download reports for ALL configured accounts

Examples:
  python -m amazon_ads_tool profiles
  python -m amazon_ads_tool campaigns --client mystore
  python -m amazon_ads_tool download --type sp_campaigns --days 30
  python -m amazon_ads_tool optimize --client mystore
  python -m amazon_ads_tool optimize-live --client mystore
  python -m amazon_ads_tool report --client mystore --days 30
  python -m amazon_ads_tool report-all --days 30
  python -m amazon_ads_tool download-all --days 30
  python -m amazon_ads_tool pause-bleeders --max-acos 80
        """,
    )

    parser.add_argument("command", help="Command to run")
    parser.add_argument("--client", default="default", help="Client name (matches env var prefix)")
    parser.add_argument("--days", type=int, default=30, help="Report lookback days")
    parser.add_argument("--type", dest="report_type", default="all", help="Report type to download")
    parser.add_argument("--max-acos", type=float, default=100.0, help="Max ACoS threshold for pause-bleeders")
    parser.add_argument("--target-acos", type=float, help="Override target ACoS")

    args = parser.parse_args()
    config = load_config(args.client)

    if args.target_acos:
        config.target_acos = args.target_acos

    # Multi-account commands (don't need a specific client config)
    multi_commands = {
        "report-all": lambda: cmd_report_all(args.days),
        "download-all": lambda: cmd_download_all(args.report_type, args.days),
    }

    if args.command in multi_commands:
        multi_commands[args.command]()
        return

    commands = {
        "profiles": lambda: cmd_profiles(config),
        "campaigns": lambda: cmd_campaigns(config),
        "download": lambda: cmd_download_reports(config, args.report_type, args.days),
        "optimize": lambda: cmd_optimize(config, dry_run=True),
        "optimize-live": lambda: cmd_optimize(config, dry_run=False),
        "report": lambda: cmd_monthly_report(config, args.days),
        "pause-bleeders": lambda: cmd_pause_bleeders(config, args.max_acos),
    }

    if args.command not in commands:
        parser.print_help()
        sys.exit(1)

    print(f"\n🔧 Amazon Ads Tool | Client: {config.client_name} | Region: {config.region} | Marketplace: {config.marketplace}\n")
    commands[args.command]()


if __name__ == "__main__":
    main()
