"""
Category Analysis Runner — EMOUNT Ventures
============================================
Runs the full category-wise analysis combining:
  - Ads performance data
  - SP-API total sales (organic + ads)
  - FBA inventory health
  - Cost prices / margins
  - Category ROI targets vs actual

Usage:
  python -m category_analysis.run_analysis                    # Full run with SP-API
  python -m category_analysis.run_analysis --skip-sp-api      # Ads data only (fast)
  python -m category_analysis.run_analysis --days 60          # Last 60 days of orders
"""

import os
import sys
import argparse
from datetime import datetime

import pandas as pd

# Add parent to path so we can import the package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from category_analysis.data_loader import build_master_dataset, load_ads_campaign_data
from category_analysis.categories import CATEGORIES

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")


def ensure_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)


def analyze_category(cat_key, cat_asins_df):
    """Analyze a single category and return a summary dict."""
    cat = CATEGORIES.get(cat_key, {})
    display = cat.get('display_name', cat_key)
    target_acos = cat.get('target_acos', 20)
    target_ads_roi = cat.get('target_ads_roi', 5)
    target_blended = cat.get('target_blended_roi', 10)

    n = len(cat_asins_df)
    total_spend = cat_asins_df['Cost'].sum()
    total_ad_sales = cat_asins_df['Sales'].sum()
    total_orders = cat_asins_df['Orders'].sum()
    total_units = cat_asins_df['Units'].sum()
    total_impressions = cat_asins_df['Impressions'].sum()
    total_clicks = cat_asins_df['Clicks'].sum()

    # Ads metrics
    acos = (total_spend / total_ad_sales * 100) if total_ad_sales > 0 else 0
    ads_roas = (total_ad_sales / total_spend) if total_spend > 0 else 0
    ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
    cvr = (total_orders / total_clicks * 100) if total_clicks > 0 else 0
    cpc = (total_spend / total_clicks) if total_clicks > 0 else 0

    # Total revenue from SP-API
    total_revenue = cat_asins_df['total_revenue'].sum() if 'total_revenue' in cat_asins_df else 0
    organic_sales = cat_asins_df['organic_sales'].sum() if 'organic_sales' in cat_asins_df else 0
    blended_roas = (total_revenue / total_spend) if total_spend > 0 else 0

    # FBA stock
    fba_avail = cat_asins_df['fba_available'].sum() if 'fba_available' in cat_asins_df else 0
    fba_inbound = cat_asins_df['fba_inbound'].sum() if 'fba_inbound' in cat_asins_df else 0

    # Status assessment
    ads_status = "ON TARGET" if ads_roas >= target_ads_roi else (
        "CLOSE" if ads_roas >= target_ads_roi * 0.8 else "BELOW TARGET"
    )
    blended_status = "ON TARGET" if blended_roas >= target_blended else (
        "CLOSE" if blended_roas >= target_blended * 0.8 else (
            "BELOW TARGET" if total_revenue > 0 else "NO SP-API DATA"
        )
    )

    # Top/bottom ASIN performance
    top_asins = cat_asins_df.nlargest(3, 'Sales')[['ASIN', 'SKU', 'Sales', 'Cost', 'ROAS', 'ACoS%']].to_dict('records')
    losers = cat_asins_df[cat_asins_df['Sales'] == 0]
    low_roas = cat_asins_df[(cat_asins_df['Sales'] > 0) & (cat_asins_df['ROAS'] < target_ads_roi * 0.5)]

    return {
        'category': cat_key,
        'display_name': display,
        'asin_count': n,
        # Ads metrics
        'ad_spend': round(total_spend, 2),
        'ad_sales': round(total_ad_sales, 2),
        'ad_orders': int(total_orders),
        'ad_units': int(total_units),
        'acos': round(acos, 2),
        'ads_roas': round(ads_roas, 2),
        'ctr': round(ctr, 2),
        'cvr': round(cvr, 2),
        'cpc': round(cpc, 2),
        # Targets
        'target_acos': target_acos,
        'target_ads_roi': target_ads_roi,
        'target_blended_roi': target_blended,
        # SP-API
        'total_revenue': round(total_revenue, 2),
        'organic_sales': round(organic_sales, 2),
        'blended_roas': round(blended_roas, 2),
        # Stock
        'fba_available': int(fba_avail) if pd.notna(fba_avail) else 0,
        'fba_inbound': int(fba_inbound) if pd.notna(fba_inbound) else 0,
        # Status
        'ads_status': ads_status,
        'blended_status': blended_status,
        # Details
        'top_asins': top_asins,
        'zero_sale_asins': len(losers),
        'low_roas_asins': len(low_roas),
        'impressions': int(total_impressions),
        'clicks': int(total_clicks),
    }


def generate_report(summaries, master_df):
    """Generate a formatted text + CSV report."""
    ensure_output_dir()
    ts = datetime.now().strftime('%Y%m%d_%H%M')

    lines = []
    lines.append("=" * 70)
    lines.append("  EMOUNT VENTURES — CATEGORY PERFORMANCE ANALYSIS")
    lines.append(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("=" * 70)

    # Overall summary
    total_spend = sum(s['ad_spend'] for s in summaries)
    total_ad_sales = sum(s['ad_sales'] for s in summaries)
    total_revenue = sum(s['total_revenue'] for s in summaries)
    overall_acos = (total_spend / total_ad_sales * 100) if total_ad_sales > 0 else 0
    overall_roas = (total_ad_sales / total_spend) if total_spend > 0 else 0
    overall_blended = (total_revenue / total_spend) if total_spend > 0 else 0

    lines.append(f"\n  OVERALL PORTFOLIO:")
    lines.append(f"    Total Ad Spend:     ₹{total_spend:>12,.2f}")
    lines.append(f"    Total Ad Sales:     ₹{total_ad_sales:>12,.2f}")
    lines.append(f"    Total Revenue:      ₹{total_revenue:>12,.2f}" if total_revenue > 0 else "    Total Revenue:      (SP-API data not available)")
    lines.append(f"    Overall ACoS:        {overall_acos:>10.2f}%")
    lines.append(f"    Overall Ads ROAS:    {overall_roas:>10.2f}x")
    if total_revenue > 0:
        lines.append(f"    Overall Blended:     {overall_blended:>10.2f}x")

    # Per-category sections
    for s in sorted(summaries, key=lambda x: x['ad_spend'], reverse=True):
        lines.append(f"\n{'─' * 70}")
        lines.append(f"  {s['display_name']}  ({s['category']})")
        lines.append(f"{'─' * 70}")

        lines.append(f"  ASINs in portfolio:  {s['asin_count']}")
        lines.append(f"")

        # Ads performance
        lines.append(f"  ADS PERFORMANCE:")
        lines.append(f"    Spend:           ₹{s['ad_spend']:>12,.2f}")
        lines.append(f"    Ad Sales:        ₹{s['ad_sales']:>12,.2f}")
        lines.append(f"    Orders / Units:   {s['ad_orders']:>6d} / {s['ad_units']}")
        lines.append(f"    ACoS:             {s['acos']:>8.2f}%   (Target: {s['target_acos']}%)")
        lines.append(f"    Ads ROAS:         {s['ads_roas']:>8.2f}x   (Target: {s['target_ads_roi']}x)")
        lines.append(f"    CTR / CVR:        {s['ctr']:.2f}% / {s['cvr']:.2f}%")
        lines.append(f"    Avg CPC:          ₹{s['cpc']:.2f}")

        # Status indicator
        ads_icon = "✓" if s['ads_status'] == "ON TARGET" else ("~" if s['ads_status'] == "CLOSE" else "✗")
        lines.append(f"    Status:           [{ads_icon}] {s['ads_status']}")

        # Blended (if available)
        if s['total_revenue'] > 0:
            lines.append(f"")
            lines.append(f"  BLENDED PERFORMANCE (Ads + Organic):")
            lines.append(f"    Total Revenue:   ₹{s['total_revenue']:>12,.2f}")
            lines.append(f"    Organic Sales:   ₹{s['organic_sales']:>12,.2f}")
            ad_pct = (s['ad_sales'] / s['total_revenue'] * 100) if s['total_revenue'] > 0 else 0
            lines.append(f"    Ad % of Revenue:  {ad_pct:.1f}%")
            lines.append(f"    Blended ROAS:     {s['blended_roas']:>8.2f}x   (Target: {s['target_blended_roi']}x)")
            bl_icon = "✓" if s['blended_status'] == "ON TARGET" else ("~" if s['blended_status'] == "CLOSE" else "✗")
            lines.append(f"    Status:           [{bl_icon}] {s['blended_status']}")

        # Stock
        if s['fba_available'] > 0 or s['fba_inbound'] > 0:
            lines.append(f"")
            lines.append(f"  FBA STOCK:")
            lines.append(f"    Available:        {s['fba_available']:>6d} units")
            lines.append(f"    Inbound:          {s['fba_inbound']:>6d} units")
            # Days of stock estimate
            if s['ad_units'] > 0:
                daily_rate = s['ad_units'] / 30  # approximate
                dos = s['fba_available'] / daily_rate if daily_rate > 0 else 999
                lines.append(f"    Est. Days of Stock: {dos:>4.0f} days (based on ad velocity)")
                if dos < 14:
                    lines.append(f"    ⚠  LOW STOCK WARNING — restock urgently!")
                elif dos < 30:
                    lines.append(f"    ⚠  Stock running low — plan replenishment")

        # Problem areas
        problems = []
        if s['zero_sale_asins'] > 0:
            problems.append(f"{s['zero_sale_asins']} ASIN(s) with zero ad sales (wasted spend)")
        if s['low_roas_asins'] > 0:
            problems.append(f"{s['low_roas_asins']} ASIN(s) with ROAS < {s['target_ads_roi']*0.5:.1f}x (half of target)")
        if s['ads_status'] == "BELOW TARGET":
            gap = s['target_ads_roi'] - s['ads_roas']
            problems.append(f"Ads ROAS {gap:.2f}x below target")

        if problems:
            lines.append(f"")
            lines.append(f"  ISSUES:")
            for p in problems:
                lines.append(f"    • {p}")

        # Top ASINs
        if s['top_asins']:
            lines.append(f"")
            lines.append(f"  TOP PERFORMERS:")
            for a in s['top_asins']:
                sku = a.get('SKU', '')[:40]
                sales = a.get('Sales', 0)
                roas = a.get('ROAS', 0)
                lines.append(f"    {a['ASIN']}  {sku:40s}  Sales ₹{sales:>10,.2f}  ROAS {roas:.2f}x")

    # Recommendations
    lines.append(f"\n{'=' * 70}")
    lines.append(f"  STRATEGIC RECOMMENDATIONS")
    lines.append(f"{'=' * 70}")

    for s in sorted(summaries, key=lambda x: x['ad_spend'], reverse=True):
        lines.append(f"\n  {s['category']} ({s['display_name']}):")
        if s['ads_status'] == "ON TARGET":
            lines.append(f"    → Performing well. Consider scaling budget by 15-20%.")
            if s['zero_sale_asins'] > 0:
                lines.append(f"    → Pause {s['zero_sale_asins']} zero-sale ASIN(s) to reduce waste.")
        elif s['ads_status'] == "CLOSE":
            lines.append(f"    → Close to target. Optimize keywords and bids.")
            lines.append(f"    → Focus on top-converting ASINs, cut bids on underperformers.")
        else:
            lines.append(f"    → Below target ROAS ({s['ads_roas']:.2f}x vs {s['target_ads_roi']}x target).")
            lines.append(f"    → Review search terms for irrelevant traffic. Add negatives.")
            lines.append(f"    → Consider pausing worst performers and reallocating budget.")
            if s['cpc'] > 10:
                lines.append(f"    → High CPC (₹{s['cpc']:.2f}). Check bid strategy and competition.")

    report_text = "\n".join(lines)

    # Save report
    report_path = os.path.join(OUTPUT_DIR, f"category_report_{ts}.txt")
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report_text)
    print(f"\n  Report saved: {report_path}")

    # Save summary CSV
    summary_rows = []
    for s in summaries:
        row = {k: v for k, v in s.items() if k != 'top_asins'}
        summary_rows.append(row)
    summary_df = pd.DataFrame(summary_rows)
    csv_path = os.path.join(OUTPUT_DIR, f"category_summary_{ts}.csv")
    summary_df.to_csv(csv_path, index=False)
    print(f"  Summary CSV: {csv_path}")

    # Save master ASIN-level data
    master_path = os.path.join(OUTPUT_DIR, f"master_asin_data_{ts}.csv")
    master_df.to_csv(master_path, index=False)
    print(f"  Master ASIN data: {master_path}")

    return report_text


def run(days=30, skip_sp_api=False):
    """Main entry point."""
    master = build_master_dataset(days=days, use_cache=True, skip_sp_api=skip_sp_api)

    # Run per-category analysis
    summaries = []
    for cat_key in list(CATEGORIES.keys()) + ['UNCATEGORIZED']:
        cat_df = master[master['CategoryKey'] == cat_key]
        if len(cat_df) == 0:
            continue
        summary = analyze_category(cat_key, cat_df)
        summaries.append(summary)

    # Generate report
    report = generate_report(summaries, master)
    print(report)

    return summaries, master


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='EMOUNT Category Analysis')
    parser.add_argument('--days', type=int, default=30, help='Days of order data to fetch')
    parser.add_argument('--skip-sp-api', action='store_true', help='Skip SP-API calls (ads only)')
    args = parser.parse_args()

    run(days=args.days, skip_sp_api=args.skip_sp_api)
