"""
Daily Dashboard - Single Entry Point
======================================
Run this to:
  1. Check data freshness in the data bank
  2. Fetch only what's missing (incremental)
  3. Generate the daily dashboard report

Usage:
    python run_dashboard.py              # Full run (fetch + dashboard)
    python run_dashboard.py --status     # Just show data bank status
    python run_dashboard.py --no-fetch   # Dashboard from cached data only
    python run_dashboard.py --force      # Force re-fetch everything
    python run_dashboard.py --backfill   # Deep historical backfill (365d orders, 90d ads)
"""

import os
import sys
import argparse
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from data_manager import (
    load_bank, save_bank, append_bank,
    needs_refresh, needs_snapshot_refresh,
    get_yesterday, print_bank_status,
    ORDERS_BACKFILL_DAYS, ADS_BACKFILL_DAYS, LEDGER_BACKFILL_DAYS,
)
from sp_api_fetcher import fetch_orders, fetch_fba_inventory, fetch_inventory_by_fc
from ads_api_fetcher import (
    fetch_ads_campaigns, fetch_ads_products,
    fetch_ads_campaigns_daily, fetch_ads_products_daily,
)
from dashboard import generate_dashboard, save_dashboard


def refresh_data(force=False, backfill=False):
    """Check freshness and fetch missing data. Cache-first for all sources.

    force=True:    Re-fetch last 30 days of everything
    backfill=True: Force deep history (365d orders, 90d ads, 90d ledger)
    """
    yesterday = get_yesterday()

    # -- 1. Orders ------------------------------------------------
    print("\n" + "=" * 60)
    print("  REFRESHING DATA BANK")
    print("=" * 60)

    if backfill:
        start = yesterday - timedelta(days=ORDERS_BACKFILL_DAYS - 1)
        print(f"\n  [Orders] BACKFILL mode: fetching {ORDERS_BACKFILL_DAYS} days ({start} -> {yesterday})")
        orders_new = fetch_orders(start, yesterday)
        if not orders_new.empty:
            append_bank('orders', orders_new)
    elif force:
        start = yesterday - timedelta(days=29)
        print(f"\n  [Orders] FORCE mode: fetching last 30 days")
        orders_new = fetch_orders(start, yesterday)
        if not orders_new.empty:
            save_bank('orders', orders_new)
    else:
        needs, start = needs_refresh('orders', 'order_date')
        if needs and start:
            orders_new = fetch_orders(start, yesterday)
            if not orders_new.empty:
                append_bank('orders', orders_new)
        else:
            print("  [Orders] Up to date.")

    # -- 2. FBA Inventory (snapshot) ------------------------------
    if force or backfill or needs_snapshot_refresh('fba_inventory'):
        inv = fetch_fba_inventory()
        if not inv.empty:
            save_bank('fba_inventory', inv)
    else:
        print("  [Inventory] Up to date.")

    # -- 3. Inventory by FC (Seller Flex vs Amazon FBA) -----------
    if force or backfill or needs_snapshot_refresh('inventory_by_fc'):
        try:
            fc_snapshot, fc_ledger = fetch_inventory_by_fc()
            if not fc_snapshot.empty:
                save_bank('inventory_by_fc', fc_snapshot)
            if not fc_ledger.empty:
                append_bank('fc_ledger', fc_ledger)
        except Exception as e:
            print(f"  WARNING: Inventory-by-FC fetch failed: {e}")
    else:
        print("  [Inventory by FC] Up to date.")

    # -- 4. Ads Summary Data (cache-first) ------------------------
    print()
    ads_campaigns = fetch_ads_campaigns()
    ads_products = fetch_ads_products()

    if not ads_campaigns.empty:
        save_bank('ads_campaigns', ads_campaigns)
    if not ads_products.empty:
        save_bank('ads_products', ads_products)

    # -- 5. Daily Ads Campaigns (incremental, date-range aware) ---
    if backfill:
        start = yesterday - timedelta(days=ADS_BACKFILL_DAYS - 1)
        print(f"\n  [Ads Daily] BACKFILL mode: {ADS_BACKFILL_DAYS} days ({start} -> {yesterday})")
        ads_daily = fetch_ads_campaigns_daily(start, yesterday)
        if not ads_daily.empty:
            append_bank('ads_campaigns_daily', ads_daily)
    else:
        needs, start = needs_refresh('ads_campaigns_daily', 'date')
        if needs and start:
            ads_daily = fetch_ads_campaigns_daily(start, yesterday)
            if not ads_daily.empty:
                append_bank('ads_campaigns_daily', ads_daily)
        else:
            print("  [Ads Daily Campaigns] Up to date.")

    # -- 6. Daily Ads Products / ASIN-level (incremental) ---------
    if backfill:
        start = yesterday - timedelta(days=ADS_BACKFILL_DAYS - 1)
        print(f"\n  [Ads Products Daily] BACKFILL mode: {ADS_BACKFILL_DAYS} days ({start} -> {yesterday})")
        ads_prod_daily = fetch_ads_products_daily(start, yesterday)
        if not ads_prod_daily.empty:
            append_bank('ads_products_daily', ads_prod_daily)
    else:
        needs, start = needs_refresh('ads_products_daily', 'date')
        if needs and start:
            ads_prod_daily = fetch_ads_products_daily(start, yesterday)
            if not ads_prod_daily.empty:
                append_bank('ads_products_daily', ads_prod_daily)
        else:
            print("  [Ads Products Daily] Up to date.")


def run_dashboard():
    """Load all data from bank and generate dashboard."""
    print("\n" + "=" * 60)
    print("  GENERATING DASHBOARD")
    print("=" * 60)

    orders = load_bank('orders')
    inventory = load_bank('fba_inventory')
    ads_campaigns = load_bank('ads_campaigns')
    ads_products = load_bank('ads_products')

    print(f"  Loaded: {len(orders)} orders, {len(inventory)} inventory SKUs, "
          f"{len(ads_campaigns)} ads campaign rows, {len(ads_products)} ads product rows")

    report = generate_dashboard(orders, inventory, ads_campaigns, ads_products)
    filepath = save_dashboard(report)

    # Print to console too
    print("\n" + report)
    return filepath


def main():
    parser = argparse.ArgumentParser(description='EMOUNT Daily Amazon Dashboard')
    parser.add_argument('--status', action='store_true', help='Show data bank status only')
    parser.add_argument('--no-fetch', action='store_true', help='Skip fetching, use cached data')
    parser.add_argument('--force', action='store_true', help='Force re-fetch all data')
    parser.add_argument('--backfill', action='store_true',
                        help=f'Deep historical backfill ({ORDERS_BACKFILL_DAYS}d orders, {ADS_BACKFILL_DAYS}d ads)')
    parser.add_argument('--ads-only', action='store_true',
                        help=f'Re-fetch only ads daily data ({ADS_BACKFILL_DAYS}d backfill)')
    args = parser.parse_args()

    print("\n+" + "=" * 58 + "+")
    print("|" + "  EMOUNT VENTURES - DAILY AMAZON DASHBOARD".center(58) + "|")
    print("|" + f"  {datetime.now().strftime('%Y-%m-%d %H:%M IST')}".center(58) + "|")
    print("+" + "=" * 58 + "+")

    if args.status:
        print_bank_status()
        return

    if args.ads_only:
        # Quick re-fetch of just ads daily data (with resume support)
        yesterday = get_yesterday()
        start = yesterday - timedelta(days=ADS_BACKFILL_DAYS - 1)
        print(f"\n  [Ads-Only] Fetching {ADS_BACKFILL_DAYS} days of daily ads ({start} → {yesterday})")
        print(f"  (Chunks save incrementally — safe to interrupt and resume)\n")
        ads_daily = fetch_ads_campaigns_daily(start, yesterday)
        if not ads_daily.empty:
            print(f"  [DataBank] ads_campaigns_daily: {len(ads_daily)} rows total")
        ads_prod = fetch_ads_products_daily(start, yesterday)
        if not ads_prod.empty:
            print(f"  [DataBank] ads_products_daily: {len(ads_prod)} rows total")
        print_bank_status()
        return

    if not args.no_fetch:
        try:
            refresh_data(force=args.force, backfill=args.backfill)
        except Exception as e:
            print(f"\n  WARNING: Data fetch error: {e}")
            print("  Continuing with cached data...")

    print_bank_status()
    run_dashboard()


if __name__ == '__main__':
    main()
