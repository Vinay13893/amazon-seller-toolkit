"""
Daily Dashboard Generator
==========================
Produces a comprehensive daily summary of your Amazon seller account.

Sections:
  1. SALES SNAPSHOT — Today's orders, revenue, units, avg order value
  2. ORDER STATUS MIX — Shipped, pending, cancelled breakdown
  3. TOP PERFORMERS — Top 10 ASINs by revenue (yesterday)
  4. SLOW MOVERS — ASINs with orders but low velocity
  5. FBA INVENTORY HEALTH — Stock levels, low-stock alerts, out-of-stock
  6. ADS PERFORMANCE — Total spend, ROAS, ACoS, top/bottom campaigns
  7. ADS vs ORGANIC — Ads-attributed sales vs total sales
  8. CATEGORY BREAKDOWN — Performance by product category
  9. ALERTS & ACTION ITEMS — Things that need attention
"""

import os
import sys
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Import categories if available
try:
    sys.path.insert(0, PARENT_DIR)
    from category_analysis.categories import CATEGORIES
except ImportError:
    CATEGORIES = {}


def _rupees(val):
    """Format as Indian Rupees."""
    if pd.isna(val) or val == 0:
        return "₹0"
    return f"₹{val:,.0f}"


def _pct(val):
    if pd.isna(val) or val == 0:
        return "0.0%"
    return f"{val:.1f}%"


def _classify_asin(sku, asin):
    """Map SKU/ASIN to a category."""
    sku_lower = (sku or '').lower()
    for cat_key, cat in CATEGORIES.items():
        # Check ASIN list first
        if asin in cat.get('asins', []):
            return cat_key
        # Check SKU patterns
        for pattern in cat.get('sku_patterns', []):
            if pattern.lower() in sku_lower:
                return cat_key
    return "Other"


def generate_dashboard(orders_df, inventory_df, ads_campaigns_df, ads_products_df):
    """Generate the daily dashboard text report. Returns the report string."""
    today = datetime.now()
    yesterday = (today - timedelta(days=1)).date()

    lines = []
    lines.append("=" * 70)
    lines.append(f"  EMOUNT VENTURES — DAILY AMAZON DASHBOARD")
    lines.append(f"  Generated: {today.strftime('%Y-%m-%d %H:%M')} IST")
    lines.append(f"  Data through: {yesterday}")
    lines.append("=" * 70)

    # ── 1. SALES SNAPSHOT ──────────────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  1. SALES SNAPSHOT (Yesterday vs 7-Day Avg)")
    lines.append("─" * 70)

    if not orders_df.empty and 'order_date' in orders_df.columns:
        orders_df = orders_df.copy()
        orders_df['date'] = pd.to_datetime(orders_df['order_date'], errors='coerce').dt.date

        # Filter out cancelled
        active_orders = orders_df[~orders_df['item_status'].isin(['Cancelled', 'Canceled', 'Unfulfillable'])] if 'item_status' in orders_df.columns else orders_df

        # Yesterday
        yday = active_orders[active_orders['date'] == yesterday]
        yday_revenue = yday['item_price'].sum() if 'item_price' in yday.columns else 0
        yday_units = yday['quantity'].sum() if 'quantity' in yday.columns else len(yday)
        yday_orders = len(yday)
        yday_aov = yday_revenue / max(yday_orders, 1)

        # 7-day average
        week_ago = yesterday - timedelta(days=6)
        week = active_orders[(active_orders['date'] >= week_ago) & (active_orders['date'] <= yesterday)]
        days_in_week = max((yesterday - week_ago).days + 1, 1)
        week_daily_rev = week['item_price'].sum() / days_in_week if 'item_price' in week.columns else 0
        week_daily_units = week['quantity'].sum() / days_in_week if 'quantity' in week.columns else 0

        rev_delta = ((yday_revenue / max(week_daily_rev, 1)) - 1) * 100 if week_daily_rev > 0 else 0
        unit_delta = ((yday_units / max(week_daily_units, 1)) - 1) * 100 if week_daily_units > 0 else 0

        rev_arrow = "▲" if rev_delta >= 0 else "▼"
        unit_arrow = "▲" if unit_delta >= 0 else "▼"

        lines.append(f"  Revenue (yesterday):  {_rupees(yday_revenue)}  {rev_arrow} {abs(rev_delta):.0f}% vs 7d avg ({_rupees(week_daily_rev)}/day)")
        lines.append(f"  Units sold:           {yday_units:,}  {unit_arrow} {abs(unit_delta):.0f}% vs 7d avg ({week_daily_units:.0f}/day)")
        lines.append(f"  Order lines:          {yday_orders:,}")
        lines.append(f"  Avg order value:      {_rupees(yday_aov)}")

        # 30-day total
        month_ago = yesterday - timedelta(days=29)
        month = active_orders[(active_orders['date'] >= month_ago) & (active_orders['date'] <= yesterday)]
        month_rev = month['item_price'].sum() if 'item_price' in month.columns else 0
        month_units = month['quantity'].sum() if 'quantity' in month.columns else 0
        lines.append(f"\n  30-Day Total:         {_rupees(month_rev)} revenue | {month_units:,} units")
    else:
        lines.append("  No order data available.")

    # ── 2. ORDER STATUS MIX ───────────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  2. ORDER STATUS MIX (Yesterday)")
    lines.append("─" * 70)

    if not orders_df.empty and 'item_status' in orders_df.columns and 'date' in orders_df.columns:
        yday_all = orders_df[orders_df['date'] == yesterday]
        status_counts = yday_all.groupby('item_status').agg(
            count=('quantity', 'size'),
            revenue=('item_price', 'sum')
        ).sort_values('revenue', ascending=False)
        for status, row in status_counts.iterrows():
            lines.append(f"  {status:35s}  {int(row['count']):>5} orders  {_rupees(row['revenue']):>12}")
    else:
        lines.append("  No status data available.")

    # ── 3. TOP PERFORMERS ─────────────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  3. TOP 10 ASINs BY REVENUE (Yesterday)")
    lines.append("─" * 70)

    if not orders_df.empty and 'date' in orders_df.columns:
        yday_active = orders_df[
            (orders_df['date'] == yesterday) &
            (~orders_df.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled', 'Unfulfillable']))
        ] if 'item_status' in orders_df.columns else orders_df[orders_df['date'] == yesterday]

        if not yday_active.empty:
            top = yday_active.groupby(['asin', 'sku']).agg(
                revenue=('item_price', 'sum'),
                units=('quantity', 'sum'),
            ).sort_values('revenue', ascending=False).head(10)

            lines.append(f"  {'ASIN':<14} {'SKU':<35} {'Revenue':>10} {'Units':>6}")
            lines.append(f"  {'─'*14} {'─'*35} {'─'*10} {'─'*6}")
            for (asin, sku), row in top.iterrows():
                sku_short = sku[:33] + '..' if len(sku) > 35 else sku
                lines.append(f"  {asin:<14} {sku_short:<35} {_rupees(row['revenue']):>10} {int(row['units']):>6}")
    else:
        lines.append("  No data.")

    # ── 4. FBA INVENTORY HEALTH ───────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  4. FBA INVENTORY HEALTH")
    lines.append("─" * 70)

    if not inventory_df.empty:
        total_skus = len(inventory_df)
        in_stock = len(inventory_df[inventory_df.get('fba_available', pd.Series(dtype=int)) > 0]) if 'fba_available' in inventory_df.columns else 0
        out_of_stock = len(inventory_df[inventory_df.get('fba_available', pd.Series(dtype=int)) == 0]) if 'fba_available' in inventory_df.columns else 0
        total_units = inventory_df['fba_available'].sum() if 'fba_available' in inventory_df.columns else 0
        inbound = (inventory_df.get('fba_inbound_working', 0).sum() + inventory_df.get('fba_inbound_shipped', 0).sum()) if 'fba_inbound_working' in inventory_df.columns else 0

        lines.append(f"  Total SKUs:       {total_skus}")
        lines.append(f"  In Stock:         {in_stock}  |  Out of Stock: {out_of_stock}")
        lines.append(f"  Available Units:  {int(total_units):,}")
        lines.append(f"  Inbound Units:    {int(inbound):,}")

        # Low stock alerts (< 10 units available but selling)
        if 'fba_available' in inventory_df.columns:
            low_stock = inventory_df[
                (inventory_df['fba_available'] > 0) &
                (inventory_df['fba_available'] <= 10)
            ].sort_values('fba_available')

            if not low_stock.empty:
                lines.append(f"\n  ⚠️  LOW STOCK ALERTS ({len(low_stock)} SKUs ≤ 10 units):")
                for _, row in low_stock.head(15).iterrows():
                    name = str(row.get('product_name', row.get('sku', '')))[:40]
                    lines.append(f"     {row.get('sku',''):30s}  {int(row['fba_available']):>3} units  {name}")

            # Out of stock items (available = 0, but has a product name → was previously stocked)
            oos = inventory_df[inventory_df['fba_available'] == 0]
            if not oos.empty and len(oos) <= 30:
                lines.append(f"\n  🔴 OUT OF STOCK ({len(oos)} SKUs):")
                for _, row in oos.head(15).iterrows():
                    name = str(row.get('product_name', row.get('sku', '')))[:45]
                    inb = int(row.get('fba_inbound_shipped', 0)) + int(row.get('fba_inbound_working', 0))
                    inb_str = f"(inbound: {inb})" if inb > 0 else ""
                    lines.append(f"     {row.get('sku',''):30s}  {name}  {inb_str}")
    else:
        lines.append("  No inventory data available.")

    # ── 5. ADS PERFORMANCE ────────────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  5. ADS PERFORMANCE (Latest Period)")
    lines.append("─" * 70)

    if not ads_campaigns_df.empty:
        total_spend = ads_campaigns_df['cost'].sum()
        total_sales = ads_campaigns_df['sales1d'].sum()
        total_clicks = ads_campaigns_df['clicks'].sum()
        total_impressions = ads_campaigns_df['impressions'].sum()
        total_orders = ads_campaigns_df['purchases1d'].sum()
        total_units = ads_campaigns_df['unitsSoldClicks1d'].sum() if 'unitsSoldClicks1d' in ads_campaigns_df.columns else 0

        roas = total_sales / max(total_spend, 1)
        acos = (total_spend / max(total_sales, 1)) * 100
        ctr = (total_clicks / max(total_impressions, 1)) * 100
        cpc = total_spend / max(total_clicks, 1)
        cvr = (total_orders / max(total_clicks, 1)) * 100

        lines.append(f"  Ad Spend:      {_rupees(total_spend)}")
        lines.append(f"  Ad Sales:      {_rupees(total_sales)}")
        lines.append(f"  ROAS:          {roas:.2f}x")
        lines.append(f"  ACoS:          {_pct(acos)}")
        lines.append(f"  Impressions:   {int(total_impressions):,}")
        lines.append(f"  Clicks:        {int(total_clicks):,}")
        lines.append(f"  CTR:           {_pct(ctr)}")
        lines.append(f"  CPC:           {_rupees(cpc)}")
        lines.append(f"  CVR:           {_pct(cvr)}")
        lines.append(f"  Ad Orders:     {int(total_orders):,}")
        lines.append(f"  Ad Units:      {int(total_units):,}")

        # Top 5 campaigns by sales
        lines.append(f"\n  TOP 5 CAMPAIGNS (by Ad Sales):")
        top_camps = ads_campaigns_df.nlargest(5, 'sales1d')
        lines.append(f"  {'Campaign':40s} {'Spend':>10} {'Sales':>10} {'ROAS':>6} {'ACoS':>6}")
        lines.append(f"  {'─'*40} {'─'*10} {'─'*10} {'─'*6} {'─'*6}")
        for _, row in top_camps.iterrows():
            name = str(row.get('campaignName', ''))[:38]
            camp_roas = row['sales1d'] / max(row['cost'], 1)
            camp_acos = (row['cost'] / max(row['sales1d'], 1)) * 100
            lines.append(f"  {name:40s} {_rupees(row['cost']):>10} {_rupees(row['sales1d']):>10} {camp_roas:>5.1f}x {_pct(camp_acos):>6}")

        # Bleeding campaigns (ACoS > 30%)
        bleeders = ads_campaigns_df[
            (ads_campaigns_df['cost'] > 500) &
            (ads_campaigns_df['sales1d'] > 0) &
            ((ads_campaigns_df['cost'] / ads_campaigns_df['sales1d']) > 0.30)
        ].copy()
        if not bleeders.empty:
            bleeders['acos'] = (bleeders['cost'] / bleeders['sales1d']) * 100
            bleeders = bleeders.sort_values('acos', ascending=False)
            lines.append(f"\n  ⚠️  BLEEDING CAMPAIGNS (ACoS > 30%, spend > ₹500):")
            for _, row in bleeders.head(5).iterrows():
                name = str(row.get('campaignName', ''))[:38]
                lines.append(f"     {name:40s}  ACoS: {_pct(row['acos'])}  Spend: {_rupees(row['cost'])}")

        # Zero-sales campaigns with spend
        zero_sales = ads_campaigns_df[
            (ads_campaigns_df['cost'] > 200) &
            (ads_campaigns_df['sales1d'] == 0)
        ]
        if not zero_sales.empty:
            total_wasted = zero_sales['cost'].sum()
            lines.append(f"\n  🔴 ZERO-SALES CAMPAIGNS (spend > ₹200): {len(zero_sales)} campaigns, {_rupees(total_wasted)} wasted")
            for _, row in zero_sales.nlargest(5, 'cost').iterrows():
                name = str(row.get('campaignName', ''))[:45]
                lines.append(f"     {name:47s}  {_rupees(row['cost'])} spent  {int(row['clicks'])} clicks")
    else:
        lines.append("  No ads data available.")

    # ── 6. ADS vs ORGANIC ─────────────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  6. ADS vs ORGANIC SPLIT")
    lines.append("─" * 70)

    if not orders_df.empty and not ads_campaigns_df.empty and 'date' in orders_df.columns:
        # Get the date range of ads data
        ads_date = ads_campaigns_df['date'].iloc[0] if 'date' in ads_campaigns_df.columns else str(yesterday)
        total_ad_sales = ads_campaigns_df['sales1d'].sum()

        # Total order revenue for yesterday
        yday_active = orders_df[
            (orders_df['date'] == yesterday) &
            (~orders_df.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled']))
        ] if 'item_status' in orders_df.columns else orders_df[orders_df['date'] == yesterday]
        total_revenue = yday_active['item_price'].sum() if not yday_active.empty else 0

        organic_rev = max(0, total_revenue - total_ad_sales) if total_revenue > total_ad_sales else 0
        ad_pct = (total_ad_sales / max(total_revenue, 1)) * 100 if total_revenue > 0 else 0
        organic_pct = 100 - ad_pct if total_revenue > 0 else 0

        lines.append(f"  Total Revenue:    {_rupees(total_revenue)}")
        lines.append(f"  Ad-attributed:    {_rupees(total_ad_sales)} ({_pct(ad_pct)})")
        lines.append(f"  Organic:          {_rupees(organic_rev)} ({_pct(organic_pct)})")
        if total_ad_sales > 0:
            blended_roas = total_revenue / max(ads_campaigns_df['cost'].sum(), 1)
            lines.append(f"  Blended ROAS:     {blended_roas:.1f}x")
    else:
        lines.append("  Insufficient data for ads/organic split.")

    # ── 7. CATEGORY BREAKDOWN ─────────────────────────────────
    if CATEGORIES and not orders_df.empty and 'date' in orders_df.columns:
        lines.append("\n" + "─" * 70)
        lines.append("  7. CATEGORY BREAKDOWN (Yesterday)")
        lines.append("─" * 70)

        yday_active = orders_df[
            (orders_df['date'] == yesterday) &
            (~orders_df.get('item_status', pd.Series()).isin(['Cancelled', 'Canceled']))
        ] if 'item_status' in orders_df.columns else orders_df[orders_df['date'] == yesterday]

        if not yday_active.empty:
            yday_active = yday_active.copy()
            yday_active['category'] = yday_active.apply(
                lambda r: _classify_asin(r.get('sku', ''), r.get('asin', '')), axis=1
            )

            cat_summary = yday_active.groupby('category').agg(
                revenue=('item_price', 'sum'),
                units=('quantity', 'sum'),
                orders=('quantity', 'size'),
            ).sort_values('revenue', ascending=False)

            lines.append(f"  {'Category':20s} {'Revenue':>10} {'Units':>6} {'Orders':>7}")
            lines.append(f"  {'─'*20} {'─'*10} {'─'*6} {'─'*7}")
            for cat, row in cat_summary.iterrows():
                lines.append(f"  {cat:20s} {_rupees(row['revenue']):>10} {int(row['units']):>6} {int(row['orders']):>7}")

    # ── 8. ALERTS & ACTION ITEMS ──────────────────────────────
    lines.append("\n" + "─" * 70)
    lines.append("  8. ALERTS & ACTION ITEMS")
    lines.append("─" * 70)

    alerts = []

    # Revenue drop alert
    if not orders_df.empty and 'date' in orders_df.columns:
        if 'rev_delta' in dir() and rev_delta < -20:
            alerts.append(f"⚠️  Revenue dropped {abs(rev_delta):.0f}% vs 7-day average")

    # Out of stock on selling items
    if not inventory_df.empty and not orders_df.empty and 'fba_available' in inventory_df.columns:
        oos_skus = set(inventory_df[inventory_df['fba_available'] == 0]['sku'].str.strip())
        if 'sku' in orders_df.columns and 'date' in orders_df.columns:
            recent = orders_df[orders_df['date'] >= yesterday - timedelta(days=7)]
            recent_selling = set(recent[recent.get('item_status', pd.Series()) != 'Cancelled']['sku'].str.strip()) if 'item_status' in recent.columns else set(recent['sku'].str.strip())
            oos_and_selling = oos_skus & recent_selling
            if oos_and_selling:
                alerts.append(f"🔴 {len(oos_and_selling)} actively-selling SKUs are OUT OF STOCK!")
                for sku in list(oos_and_selling)[:5]:
                    alerts.append(f"   → {sku}")

    # High ACoS campaigns alert
    if not ads_campaigns_df.empty:
        high_acos = ads_campaigns_df[
            (ads_campaigns_df['cost'] > 1000) &
            (ads_campaigns_df['sales1d'] > 0) &
            ((ads_campaigns_df['cost'] / ads_campaigns_df['sales1d']) > 0.35)
        ]
        if not high_acos.empty:
            alerts.append(f"⚠️  {len(high_acos)} campaigns with ACoS > 35% and spend > ₹1,000")

    if alerts:
        for alert in alerts:
            lines.append(f"  {alert}")
    else:
        lines.append("  ✅ No major alerts. All looking good!")

    lines.append("\n" + "=" * 70)
    lines.append("  END OF DAILY DASHBOARD")
    lines.append("=" * 70)

    return "\n".join(lines)


def save_dashboard(report_text):
    """Save dashboard to output file."""
    today = datetime.now().strftime('%Y-%m-%d')
    filepath = os.path.join(OUTPUT_DIR, f"dashboard_{today}.txt")
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(report_text)
    print(f"\n  Dashboard saved → {filepath}")
    return filepath
