"""
Data Manager — Incremental Data Store with Multi-Brand Support
===============================================================
Manages a growing data lake of orders, ads, and inventory data.
Data accumulates over time — never deleted, only appended.

Data Bank Files (CSVs):
  data_bank/orders.csv              — All order rows, appended daily (365d+)
  data_bank/fba_inventory.csv       — Latest FBA inventory snapshot
  data_bank/ads_campaigns.csv       — MTD ads campaign summary (legacy)
  data_bank/ads_campaigns_daily.csv — Daily ads campaign rows (90d+)
  data_bank/ads_products.csv        — Ads ASIN-level summary (legacy)
  data_bank/ads_products_daily.csv  — Daily ads ASIN-level rows (90d+)
  data_bank/fc_ledger.csv           — Per-FC daily inventory movements (90d+)
  data_bank/inventory_by_fc.csv     — Per-FC latest snapshot

Freshness Rules:
  - Time-series (orders, ads_daily): latest date >= yesterday → fresh
  - Snapshots (inventory): file modified today → fresh
  - On first run: backfill history (365d orders, 90d ads, 90d ledger)

Architecture:
  - Brand-agnostic: data_bank/ serves the current brand
  - For multi-brand later: data_bank_{brand}/ or brands/{brand}/data_bank/
  - All CSVs are append-only (except snapshots) — deduplication on append
"""

import os
import pandas as pd
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_BANK_DIR = os.path.join(SCRIPT_DIR, "data_bank")
os.makedirs(DATA_BANK_DIR, exist_ok=True)

# History depth for first-time backfill
ORDERS_BACKFILL_DAYS = 365
ADS_BACKFILL_DAYS = 90
LEDGER_BACKFILL_DAYS = 90


def _bank_path(name):
    return os.path.join(DATA_BANK_DIR, f"{name}.csv")


def load_bank(name):
    """Load a data bank CSV. Returns empty DataFrame if file doesn't exist."""
    path = _bank_path(name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return pd.read_csv(path)
    return pd.DataFrame()


def save_bank(name, df):
    """Save full DataFrame to data bank CSV."""
    df.to_csv(_bank_path(name), index=False)
    print(f"  [DataBank] Saved {len(df)} rows → {name}.csv")


def append_bank(name, new_df):
    """Append new rows to existing data bank. Deduplicates by all columns."""
    existing = load_bank(name)
    if existing.empty:
        save_bank(name, new_df)
        return new_df
    combined = pd.concat([existing, new_df], ignore_index=True)
    combined = combined.drop_duplicates()
    save_bank(name, combined)
    return combined


def get_latest_date(name, date_col='date'):
    """Get the latest date in a data bank file. Returns None if empty."""
    df = load_bank(name)
    if df.empty or date_col not in df.columns:
        return None
    dates = pd.to_datetime(df[date_col], errors='coerce').dropna()
    if dates.empty:
        return None
    return dates.max().date()


def get_yesterday():
    """Return yesterday's date (UTC) as a date object."""
    return (datetime.now(timezone.utc) - timedelta(days=1)).date()


def needs_refresh(name, date_col='date'):
    """Check if data bank needs new data.
    Returns (needs_fetch: bool, fetch_from_date: date or None)
    """
    yesterday = get_yesterday()
    latest = get_latest_date(name, date_col)

    if latest is None:
        # First run — determine backfill depth by data type
        if 'orders' in name:
            backfill = ORDERS_BACKFILL_DAYS
        elif 'ads' in name:
            backfill = ADS_BACKFILL_DAYS
        else:
            backfill = 90
        start = yesterday - timedelta(days=backfill - 1)
        print(f"  [DataBank] {name}: No data found. Will backfill {backfill} days ({start} → {yesterday})")
        return True, start

    if latest >= yesterday:
        print(f"  [DataBank] {name}: Fresh (latest={latest}, yesterday={yesterday}). Skipping.")
        return False, None

    fetch_from = latest + timedelta(days=1)
    gap_days = (yesterday - latest).days
    print(f"  [DataBank] {name}: Stale by {gap_days} day(s). Will fetch {fetch_from} → {yesterday}")
    return True, fetch_from


def needs_snapshot_refresh(name):
    """For snapshot data (inventory) — check if file was updated today."""
    path = _bank_path(name)
    if not os.path.exists(path):
        print(f"  [DataBank] {name}: No snapshot found. Will fetch fresh.")
        return True

    mod_time = datetime.fromtimestamp(os.path.getmtime(path))
    today = datetime.now().date()
    if mod_time.date() >= today:
        print(f"  [DataBank] {name}: Snapshot is from today. Skipping.")
        return False

    print(f"  [DataBank] {name}: Snapshot from {mod_time.date()}. Will refresh.")
    return True


def print_bank_status():
    """Print current data bank status."""
    print("\n" + "=" * 60)
    print("  DATA BANK STATUS")
    print("=" * 60)
    yesterday = get_yesterday()

    # Time-series data banks
    for name, date_col in [('orders', 'order_date'),
                            ('ads_campaigns', 'date'),
                            ('ads_products', 'date'),
                            ('ads_campaigns_daily', 'date'),
                            ('ads_products_daily', 'date'),
                            ('fc_ledger', 'date')]:
        latest = get_latest_date(name, date_col)
        df = load_bank(name)
        rows = len(df)
        if rows == 0:
            earliest = None
        else:
            dates = pd.to_datetime(df[date_col], errors='coerce').dropna() if date_col in df.columns else pd.Series()
            earliest = dates.min().date() if not dates.empty else None
        span = f"({earliest} .. {latest})" if earliest and latest else ""
        status = "FRESH" if latest and latest >= yesterday else "STALE" if latest else "EMPTY"
        print(f"  {name:25s} | {rows:>8,} rows | {status:5s} | {span}")

    # Snapshot data banks
    for name in ['fba_inventory', 'inventory_by_fc']:
        path = _bank_path(name)
        if os.path.exists(path):
            df = load_bank(name)
            mod = datetime.fromtimestamp(os.path.getmtime(path)).strftime('%Y-%m-%d %H:%M')
            print(f"  {name:25s} | {len(df):>8,} rows | SNAP  | updated {mod}")
        else:
            print(f"  {name:25s} |        0 rows | EMPTY |")

    print("=" * 60)
