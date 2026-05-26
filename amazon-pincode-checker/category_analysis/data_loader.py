"""
Data Loader — Category Analysis
=================================
Loads and merges all data sources:
  1. Ads CSV reports (ASIN-level, campaign-level)
  2. SP-API order data (total sales per SKU/ASIN)
  3. SP-API FBA inventory
  4. Cost prices from Excel
"""

import os
import pandas as pd
from . import sp_api_client
from .categories import classify_asin, classify_campaign, CATEGORIES

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
CSV_DIR = os.path.join(PROJECT_DIR, "csv_reports")

# Excel data sources on E: drive
CP_SHEET = r"e:\Emount\Stock Reports\Emount Stock SKU wise CP Sheet.xlsx"
CATEGORY_MAP_SHEET = r"e:\Emount\Stock Reports\Amazon SKU Wise Category List.xlsx"


# ─── Ads Data ──────────────────────────────────────────────────
def load_ads_asin_data():
    """Load the latest ASIN analysis CSV from ads reports."""
    # Find the latest asin_analysis file
    files = [f for f in os.listdir(CSV_DIR) if f.startswith("asin_analysis_") and f.endswith(".csv")]
    if not files:
        raise FileNotFoundError(f"No asin_analysis CSV found in {CSV_DIR}")
    latest = sorted(files)[-1]
    path = os.path.join(CSV_DIR, latest)
    print(f"  Loading ads ASIN data: {latest}")
    df = pd.read_csv(path)
    # Classify each ASIN
    df['CategoryKey'] = df.apply(
        lambda r: classify_asin(str(r.get('ASIN', '')), str(r.get('SKU', ''))), axis=1
    )
    print(f"    {len(df)} ASINs loaded")
    return df


def load_ads_campaign_data():
    """Load the latest campaign analysis CSV."""
    files = [f for f in os.listdir(CSV_DIR) if f.startswith("campaign_analysis_") and f.endswith(".csv")]
    if not files:
        raise FileNotFoundError(f"No campaign_analysis CSV found in {CSV_DIR}")
    latest = sorted(files)[-1]
    path = os.path.join(CSV_DIR, latest)
    print(f"  Loading ads campaign data: {latest}")
    df = pd.read_csv(path)
    df['CategoryKey'] = df['Campaign'].apply(classify_campaign)
    print(f"    {len(df)} campaigns loaded")
    return df


# ─── SP-API Order Data ────────────────────────────────────────
def load_orders_data(days=30, use_cache=True):
    """Fetch or load cached order data from SP-API."""
    cache_path = os.path.join(SCRIPT_DIR, f"cache_orders_{days}d.csv")

    if use_cache and os.path.exists(cache_path):
        mod_time = os.path.getmtime(cache_path)
        from datetime import datetime
        age_hours = (datetime.now().timestamp() - mod_time) / 3600
        if age_hours < 12:
            print(f"  Loading cached order data ({age_hours:.1f}h old)")
            return pd.read_csv(cache_path)

    # Fetch fresh from SP-API
    df = sp_api_client.fetch_orders_data(days=days)
    df.to_csv(cache_path, index=False)
    print(f"  Cached order data to {cache_path}")
    return df


def summarize_orders_by_asin(orders_df):
    """Aggregate order data by ASIN: total units, total revenue, net units."""
    if orders_df.empty or 'asin' not in orders_df.columns:
        return pd.DataFrame(columns=['asin', 'total_units', 'total_revenue',
                                     'shipped_units', 'cancelled_units'])

    # Map statuses to shipped/cancelled/pending
    shipped_statuses = {'Shipped', 'Delivered', 'Shipped - Delivered to Buyer',
                        'Shipped - Out for Delivery', 'Shipped - Picked Up'}
    cancelled_statuses = {'Cancelled', 'Canceled', 'Buyer-Cancelled', 'Seller-Cancelled',
                          'Unfulfillable'}

    orders_df = orders_df.copy()
    orders_df['is_shipped'] = orders_df['item_status'].isin(shipped_statuses)
    orders_df['is_cancelled'] = orders_df['item_status'].isin(cancelled_statuses)

    agg = orders_df.groupby('asin').agg(
        total_units=('quantity', 'sum'),
        total_revenue=('item_price', 'sum'),
        shipped_units=('quantity', lambda x: x[orders_df.loc[x.index, 'is_shipped']].sum()),
        cancelled_units=('quantity', lambda x: x[orders_df.loc[x.index, 'is_cancelled']].sum()),
    ).reset_index()

    return agg


# ─── FBA Inventory ─────────────────────────────────────────────
def load_fba_inventory(use_cache=True):
    """Fetch or load cached FBA inventory from SP-API."""
    cache_path = os.path.join(SCRIPT_DIR, "cache_fba_inventory.csv")

    if use_cache and os.path.exists(cache_path):
        mod_time = os.path.getmtime(cache_path)
        from datetime import datetime
        age_hours = (datetime.now().timestamp() - mod_time) / 3600
        if age_hours < 12:
            print(f"  Loading cached FBA inventory ({age_hours:.1f}h old)")
            return pd.read_csv(cache_path)

    df = sp_api_client.fetch_fba_inventory()
    df.to_csv(cache_path, index=False)
    print(f"  Cached FBA inventory to {cache_path}")
    return df


# ─── Cost Prices from Excel ───────────────────────────────────
def load_cost_prices():
    """Load cost prices from the CP Sheet Excel on E: drive."""
    if not os.path.exists(CP_SHEET):
        print(f"  WARNING: CP sheet not found at {CP_SHEET}")
        return pd.DataFrame(columns=['sku', 'cost_price'])

    print(f"  Loading cost prices from Excel ...")
    try:
        df = pd.read_excel(CP_SHEET)
        # Expected columns: MSKU, QTY, Price/unit, CP total
        df.columns = [c.strip() for c in df.columns]

        # Try to find the relevant columns
        sku_col = None
        cp_col = None
        for c in df.columns:
            cl = c.lower()
            if 'msku' in cl or 'sku' in cl:
                sku_col = c
            if 'price/unit' in cl or 'price per unit' in cl or 'cp per' in cl:
                cp_col = c
            if cp_col is None and 'price' in cl and 'total' not in cl:
                cp_col = c

        if sku_col and cp_col:
            result = pd.DataFrame({
                'sku': df[sku_col].astype(str).str.strip(),
                'cost_price': pd.to_numeric(df[cp_col], errors='coerce').fillna(0),
            })
            result = result[result['sku'].str.len() > 0]
            print(f"    {len(result)} SKUs with cost prices loaded")
            return result
        else:
            print(f"    Could not find SKU/price columns in: {list(df.columns)}")
            return pd.DataFrame(columns=['sku', 'cost_price'])
    except Exception as e:
        print(f"    Error reading CP sheet: {e}")
        return pd.DataFrame(columns=['sku', 'cost_price'])


# ─── Category Mapping from Excel ──────────────────────────────
def load_category_mapping():
    """Load ASIN-to-category mapping from the official Excel file."""
    if not os.path.exists(CATEGORY_MAP_SHEET):
        print(f"  WARNING: Category mapping sheet not found at {CATEGORY_MAP_SHEET}")
        return {}

    print(f"  Loading category mapping from Excel ...")
    try:
        df = pd.read_excel(CATEGORY_MAP_SHEET)
        df.columns = [c.strip().lower() for c in df.columns]

        asin_col = None
        cat_col = None
        for c in df.columns:
            if 'asin' in c:
                asin_col = c
            if 'category' in c:
                cat_col = c

        if asin_col and cat_col:
            mapping = {}
            for _, row in df.iterrows():
                asin = str(row[asin_col]).strip()
                cat = str(row[cat_col]).strip()
                if asin and cat and asin != 'nan':
                    mapping[asin] = cat
            print(f"    {len(mapping)} ASIN→category mappings loaded")
            return mapping
        else:
            print(f"    Could not find ASIN/Category columns in: {list(df.columns)}")
            return {}
    except Exception as e:
        print(f"    Error reading category mapping: {e}")
        return {}


# ─── Master Merge ──────────────────────────────────────────────
def build_master_dataset(days=30, use_cache=True, skip_sp_api=False):
    """
    Build the master ASIN-level dataset combining all sources.
    Returns a DataFrame with ads metrics, total sales, inventory, and category.
    """
    print("\n" + "=" * 60)
    print("  BUILDING MASTER DATASET")
    print("=" * 60)

    # 1. Ads ASIN data (primary)
    ads_df = load_ads_asin_data()

    # 2. SP-API data (optional — can be slow)
    if not skip_sp_api:
        orders_summary = pd.DataFrame()
        fba_df = pd.DataFrame()

        try:
            orders_df = load_orders_data(days=days, use_cache=use_cache)
            orders_summary = summarize_orders_by_asin(orders_df)
            print(f"  Order summary: {len(orders_summary)} ASINs with order data")
        except Exception as e:
            print(f"\n  SP-API order fetch failed: {e}")
            print("  Continuing without order revenue data.\n")

        try:
            fba_df = load_fba_inventory(use_cache=use_cache)
            print(f"  FBA inventory: {len(fba_df)} SKUs")
        except Exception as e:
            print(f"\n  SP-API FBA fetch failed: {e}")
            print("  Continuing without inventory data.\n")
    else:
        print("  Skipping SP-API (--skip-sp-api flag)")
        orders_summary = pd.DataFrame()
        fba_df = pd.DataFrame()

    # 3. Cost prices
    cp_df = load_cost_prices()

    # 4. Merge: Ads + Orders
    master = ads_df.copy()
    if not orders_summary.empty and 'asin' in orders_summary.columns:
        master = master.merge(
            orders_summary, left_on='ASIN', right_on='asin', how='left', suffixes=('', '_orders')
        )
        master.drop(columns=['asin'], errors='ignore', inplace=True)
    else:
        master['total_units'] = None
        master['total_revenue'] = None
        master['shipped_units'] = None
        master['cancelled_units'] = None

    # 5. Merge: + FBA Inventory (by SKU or ASIN)
    if not fba_df.empty:
        if 'asin' in fba_df.columns:
            master = master.merge(
                fba_df[['asin', 'fba_available', 'fba_inbound', 'fba_total']],
                left_on='ASIN', right_on='asin', how='left'
            )
            master.drop(columns=['asin'], errors='ignore', inplace=True)
        elif 'sku' in fba_df.columns:
            master = master.merge(
                fba_df[['sku', 'fba_available', 'fba_inbound', 'fba_total']],
                left_on='SKU', right_on='sku', how='left'
            )
            master.drop(columns=['sku'], errors='ignore', inplace=True)
    else:
        master['fba_available'] = None
        master['fba_inbound'] = None
        master['fba_total'] = None

    # 6. Merge: + Cost Prices (by SKU)
    if not cp_df.empty:
        master = master.merge(cp_df, left_on='SKU', right_on='sku', how='left')
        master.drop(columns=['sku'], errors='ignore', inplace=True)
    else:
        master['cost_price'] = None

    # 7. Computed columns
    # Organic sales = total revenue - ad sales
    master['total_revenue'] = pd.to_numeric(master.get('total_revenue', 0), errors='coerce').fillna(0)
    master['organic_sales'] = master['total_revenue'] - master['Sales'].fillna(0)
    master['organic_sales'] = master['organic_sales'].clip(lower=0)

    # Blended ROAS = total revenue / ad spend
    master['blended_roas'] = master.apply(
        lambda r: r['total_revenue'] / r['Cost'] if r['Cost'] > 0 else 0, axis=1
    )

    # Ad contribution % = ad sales / total revenue
    master['ad_contribution_pct'] = master.apply(
        lambda r: (r['Sales'] / r['total_revenue'] * 100)
        if r['total_revenue'] > 0 else 0, axis=1
    )

    print(f"\n  Master dataset: {len(master)} ASINs")
    cat_counts = master['CategoryKey'].value_counts()
    for cat, cnt in cat_counts.items():
        label = CATEGORIES.get(cat, {}).get('display_name', cat)
        print(f"    {cat:15s} ({label}): {cnt} ASINs")

    return master
