"""
Amazon India Fulfillment Plan Generator
========================================
Analyzes last 30 days sales data (SKU + State-wise) and generates
a comprehensive fulfillment/replenishment plan as Excel output.

Sections:
1. SKU-Level Performance Analysis
2. State/Region Demand Mapping
3. Cancellation & Return Analysis
4. Fulfillment Health Scorecard
5. FBA Replenishment Recommendations
6. Regional Coverage Gaps
"""

import pandas as pd
import numpy as np
from datetime import datetime
import re
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# ─── Configuration ───────────────────────────────────────────────
INPUT_FILE = r"e:\Emount\Stock Reports\Claude\Store Replenish Auto\Last 30 Days SKU and State Wise Orders Data.xlsx"
OUTPUT_FILE = r"e:\Emount\Stock Reports\Claude\Store Replenish Auto\Fulfillment_Plan_{}.xlsx".format(
    datetime.now().strftime("%Y%m%d_%H%M")
)

# Indian states list for detection
INDIAN_STATES = {
    'ANDAMAN AND NICOBAR', 'ANDHRA PRADESH', 'ARUNACHAL PRADESH', 'ASSAM',
    'BIHAR', 'CHANDIGARH', 'CHHATTISGARH', 'DADRA AND NAGAR HAVELI',
    'DAMAN AND DIU', 'DELHI', 'GOA', 'GUJARAT', 'HARYANA', 'HIMACHAL PRADESH',
    'JAMMU & KASHMIR', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'LAKSHADWEEP',
    'MADHYA PRADESH', 'MAHARASHTRA', 'MANIPUR', 'MEGHALAYA', 'MIZORAM',
    'NAGALAND', 'ODISHA', 'PUDUCHERRY', 'PUNJAB', 'RAJASTHAN', 'SIKKIM',
    'TAMIL NADU', 'TELANGANA', 'TRIPURA', 'UTTAR PRADESH', 'UTTARAKHAND',
    'WEST BENGAL'
}

# Amazon FBA warehouse regions in India (approximate zone mapping)
FBA_ZONES = {
    'North': ['DELHI', 'HARYANA', 'UTTAR PRADESH', 'PUNJAB', 'RAJASTHAN',
              'UTTARAKHAND', 'HIMACHAL PRADESH', 'JAMMU & KASHMIR', 'CHANDIGARH'],
    'South': ['KARNATAKA', 'TAMIL NADU', 'TELANGANA', 'ANDHRA PRADESH',
              'KERALA', 'PUDUCHERRY'],
    'East': ['WEST BENGAL', 'BIHAR', 'ODISHA', 'JHARKHAND', 'ASSAM',
             'MEGHALAYA', 'MANIPUR', 'TRIPURA', 'NAGALAND', 'MIZORAM',
             'ARUNACHAL PRADESH', 'SIKKIM', 'ANDAMAN AND NICOBAR'],
    'West': ['MAHARASHTRA', 'GUJARAT', 'GOA', 'MADHYA PRADESH',
             'CHHATTISGARH', 'DADRA AND NAGAR HAVELI', 'DAMAN AND DIU', 'LAKSHADWEEP']
}

# Reverse mapping: state -> zone
STATE_TO_ZONE = {}
for zone, states in FBA_ZONES.items():
    for state in states:
        STATE_TO_ZONE[state] = zone


def is_state(val):
    """Check if a row label is a state name (not a SKU)."""
    if pd.isna(val):
        return False
    val = str(val).strip().upper()
    return val in INDIAN_STATES


def is_sku(val):
    """Check if a row label is a SKU (not a state or Grand Total)."""
    if pd.isna(val):
        return False
    val = str(val).strip()
    if val == 'Grand Total':
        return False
    if val.upper() in INDIAN_STATES:
        return False
    # Some misspelled states in the data (Maharahstra, Telengana, TamilNadu etc.)
    misspelled = {'MAHARAHSTRA', 'TELENGANA', 'TAMILNADU', 'UTTARPRADESH',
                  'ANDHRAPRADESH', 'MADHYAPRADESH', 'HIMACHALPRADESH',
                  'WESTBENGAL', 'JAMMUKASHMIR'}
    if val.upper().replace(' ', '') in misspelled:
        return False
    return True


def parse_hierarchical_data(df):
    """
    Parse the hierarchical Excel data where:
    - SKU rows contain overall totals for that SKU
    - Following state rows contain state-wise breakdown until next SKU
    """
    records = []
    current_sku = None

    for _, row in df.iterrows():
        label = str(row['Row Labels']).strip()

        if label == 'Grand Total':
            continue

        if is_sku(label):
            current_sku = label
            # This row has SKU-level totals
            records.append({
                'sku': label,
                'state': '__TOTAL__',
                'cancelled': row.get('Cancelled', 0) or 0,
                'pending': (row.get('Pending', 0) or 0) + (row.get('Pending - Waiting for Pick Up', 0) or 0),
                'shipped_intransit': row.get('Shipped', 0) or 0,
                'delivered': row.get('Shipped - Delivered to Buyer', 0) or 0,
                'out_for_delivery': row.get('Shipped - Out for Delivery', 0) or 0,
                'picked_up': row.get('Shipped - Picked Up', 0) or 0,
                'rejected': row.get('Shipped - Rejected by Buyer', 0) or 0,
                'returned_to_seller': row.get('Shipped - Returned to Seller', 0) or 0,
                'returning': row.get('Shipped - Returning to Seller', 0) or 0,
                'grand_total': row.get('Grand Total', 0) or 0,
            })
        elif current_sku is not None:
            # State-wise breakdown under current SKU
            # Normalize state name
            state_name = label.upper().strip()
            # Fix common misspellings
            state_fixes = {
                'MAHARAHSTRA': 'MAHARASHTRA', 'TELENGANA': 'TELANGANA',
                'TAMILNADU': 'TAMIL NADU', 'UTTARPRADESH': 'UTTAR PRADESH',
            }
            state_name = state_fixes.get(state_name, state_name)

            records.append({
                'sku': current_sku,
                'state': state_name,
                'cancelled': row.get('Cancelled', 0) or 0,
                'pending': (row.get('Pending', 0) or 0) + (row.get('Pending - Waiting for Pick Up', 0) or 0),
                'shipped_intransit': row.get('Shipped', 0) or 0,
                'delivered': row.get('Shipped - Delivered to Buyer', 0) or 0,
                'out_for_delivery': row.get('Shipped - Out for Delivery', 0) or 0,
                'picked_up': row.get('Shipped - Picked Up', 0) or 0,
                'rejected': row.get('Shipped - Rejected by Buyer', 0) or 0,
                'returned_to_seller': row.get('Shipped - Returned to Seller', 0) or 0,
                'returning': row.get('Shipped - Returning to Seller', 0) or 0,
                'grand_total': row.get('Grand Total', 0) or 0,
            })

    return pd.DataFrame(records)


def build_sku_analysis(parsed, days=30):
    """Build SKU-level performance analysis."""
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()

    sku_totals['total_fulfilled'] = (
        sku_totals['delivered'] + sku_totals['out_for_delivery'] +
        sku_totals['shipped_intransit'] + sku_totals['picked_up']
    )
    sku_totals['total_returns'] = sku_totals['rejected'] + sku_totals['returned_to_seller'] + sku_totals['returning']

    sku_totals['cancellation_rate_%'] = np.where(
        sku_totals['grand_total'] > 0,
        (sku_totals['cancelled'] / sku_totals['grand_total'] * 100).round(1),
        0
    )
    sku_totals['delivery_rate_%'] = np.where(
        sku_totals['grand_total'] > 0,
        (sku_totals['delivered'] / sku_totals['grand_total'] * 100).round(1),
        0
    )
    sku_totals['return_rate_%'] = np.where(
        sku_totals['grand_total'] > 0,
        (sku_totals['total_returns'] / sku_totals['grand_total'] * 100).round(1),
        0
    )
    sku_totals['pending_rate_%'] = np.where(
        sku_totals['grand_total'] > 0,
        (sku_totals['pending'] / sku_totals['grand_total'] * 100).round(1),
        0
    )
    sku_totals['daily_run_rate'] = (sku_totals['grand_total'] / days).round(2)
    sku_totals['weekly_demand'] = (sku_totals['daily_run_rate'] * 7).round(0)
    sku_totals['monthly_demand_est'] = sku_totals['grand_total']

    # Velocity classification
    conditions = [
        sku_totals['grand_total'] >= 50,
        sku_totals['grand_total'] >= 20,
        sku_totals['grand_total'] >= 5,
    ]
    choices = ['A - Fast Mover', 'B - Medium', 'C - Slow Mover']
    sku_totals['velocity_class'] = np.select(conditions, choices, default='D - Very Slow')

    # Fulfillment health flag
    conditions_health = [
        sku_totals['cancellation_rate_%'] > 15,
        sku_totals['pending_rate_%'] > 10,
        sku_totals['return_rate_%'] > 5,
    ]
    choices_health = ['HIGH CANCEL RATE', 'ORDER STUCK - PENDING', 'HIGH RETURNS']
    sku_totals['fulfillment_flag'] = np.select(conditions_health, choices_health, default='OK')

    # Reorder suggestion (for 30-day buffer)
    sku_totals['suggested_reorder_qty'] = (sku_totals['daily_run_rate'] * 45).round(0)  # 45 days safety stock

    result = sku_totals[[
        'sku', 'grand_total', 'daily_run_rate', 'weekly_demand', 'monthly_demand_est',
        'velocity_class', 'cancelled', 'cancellation_rate_%', 'pending', 'pending_rate_%',
        'delivered', 'delivery_rate_%', 'shipped_intransit', 'total_returns', 'return_rate_%',
        'fulfillment_flag', 'suggested_reorder_qty'
    ]].sort_values('grand_total', ascending=False).reset_index(drop=True)

    result.columns = [
        'SKU', 'Total Orders (30d)', 'Daily Run Rate', 'Weekly Demand', 'Monthly Demand',
        'Velocity Class', 'Cancelled', 'Cancel Rate %', 'Pending', 'Pending %',
        'Delivered', 'Delivery Rate %', 'In Transit', 'Returns', 'Return Rate %',
        'Fulfillment Flag', 'Suggested Reorder Qty (45d)'
    ]
    return result


def build_state_analysis(parsed):
    """Build state-level demand analysis."""
    state_data = parsed[parsed['state'] != '__TOTAL__'].copy()

    state_agg = state_data.groupby('state').agg({
        'grand_total': 'sum',
        'cancelled': 'sum',
        'pending': 'sum',
        'delivered': 'sum',
        'shipped_intransit': 'sum',
        'rejected': 'sum',
        'returned_to_seller': 'sum',
        'returning': 'sum',
    }).reset_index()

    state_agg['zone'] = state_agg['state'].map(STATE_TO_ZONE).fillna('Unknown')
    state_agg['total_returns'] = state_agg['rejected'] + state_agg['returned_to_seller'] + state_agg['returning']
    state_agg['cancel_rate_%'] = np.where(
        state_agg['grand_total'] > 0,
        (state_agg['cancelled'] / state_agg['grand_total'] * 100).round(1), 0
    )
    state_agg['delivery_rate_%'] = np.where(
        state_agg['grand_total'] > 0,
        (state_agg['delivered'] / state_agg['grand_total'] * 100).round(1), 0
    )
    state_agg['return_rate_%'] = np.where(
        state_agg['grand_total'] > 0,
        (state_agg['total_returns'] / state_agg['grand_total'] * 100).round(1), 0
    )
    state_agg['demand_share_%'] = (state_agg['grand_total'] / state_agg['grand_total'].sum() * 100).round(1)

    result = state_agg[[
        'state', 'zone', 'grand_total', 'demand_share_%', 'cancelled', 'cancel_rate_%',
        'delivered', 'delivery_rate_%', 'pending', 'total_returns', 'return_rate_%'
    ]].sort_values('grand_total', ascending=False).reset_index(drop=True)

    result.columns = [
        'State', 'FBA Zone', 'Total Orders', 'Demand Share %', 'Cancelled', 'Cancel Rate %',
        'Delivered', 'Delivery Rate %', 'Pending', 'Returns', 'Return Rate %'
    ]
    return result


def build_zone_analysis(parsed):
    """Build zone-level analysis for FBA placement strategy."""
    state_data = parsed[parsed['state'] != '__TOTAL__'].copy()
    state_data['zone'] = state_data['state'].map(STATE_TO_ZONE).fillna('Unknown')

    zone_agg = state_data.groupby('zone').agg({
        'grand_total': 'sum',
        'cancelled': 'sum',
        'pending': 'sum',
        'delivered': 'sum',
        'shipped_intransit': 'sum',
        'rejected': 'sum',
        'returned_to_seller': 'sum',
        'returning': 'sum',
    }).reset_index()

    total = zone_agg['grand_total'].sum()
    zone_agg['demand_share_%'] = (zone_agg['grand_total'] / total * 100).round(1)
    zone_agg['cancel_rate_%'] = np.where(
        zone_agg['grand_total'] > 0,
        (zone_agg['cancelled'] / zone_agg['grand_total'] * 100).round(1), 0
    )
    zone_agg['delivery_rate_%'] = np.where(
        zone_agg['grand_total'] > 0,
        (zone_agg['delivered'] / zone_agg['grand_total'] * 100).round(1), 0
    )

    # FBA stock split recommendation based on demand share
    zone_agg['recommended_fba_split_%'] = zone_agg['demand_share_%']

    zone_agg.columns = [
        'FBA Zone', 'Total Orders', 'Cancelled', 'Pending', 'Delivered',
        'In Transit', 'Rejected', 'Returned', 'Returning',
        'Demand Share %', 'Cancel Rate %', 'Delivery Rate %', 'Recommended FBA Split %'
    ]
    return zone_agg.sort_values('Total Orders', ascending=False).reset_index(drop=True)


def build_top_sku_state_matrix(parsed):
    """Build a matrix of top SKUs vs top states for demand heatmap."""
    state_data = parsed[parsed['state'] != '__TOTAL__'].copy()
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()

    top_skus = sku_totals.nlargest(30, 'grand_total')['sku'].tolist()
    state_data_top = state_data[state_data['sku'].isin(top_skus)]

    matrix = state_data_top.pivot_table(
        index='sku', columns='state', values='grand_total',
        aggfunc='sum', fill_value=0
    )

    # Only keep states with orders
    matrix = matrix.loc[:, matrix.sum() > 0]
    # Sort columns by total orders
    matrix = matrix[matrix.sum().sort_values(ascending=False).index]
    # Sort rows by total
    matrix['__total'] = matrix.sum(axis=1)
    matrix = matrix.sort_values('__total', ascending=False)
    matrix = matrix.drop('__total', axis=1)

    return matrix


def build_cancellation_analysis(parsed):
    """Deep dive into cancellation patterns."""
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()
    cancelled = sku_totals[sku_totals['cancelled'] > 0].copy()
    cancelled['cancel_rate_%'] = (cancelled['cancelled'] / cancelled['grand_total'] * 100).round(1)
    cancelled = cancelled.sort_values('cancelled', ascending=False)

    result = cancelled[['sku', 'grand_total', 'cancelled', 'cancel_rate_%', 'pending']].copy()
    result.columns = ['SKU', 'Total Orders', 'Cancelled', 'Cancel Rate %', 'Pending Orders']

    # Add risk classification
    result['Risk Level'] = np.where(
        result['Cancel Rate %'] > 20, 'CRITICAL',
        np.where(result['Cancel Rate %'] > 10, 'HIGH',
                 np.where(result['Cancel Rate %'] > 5, 'MEDIUM', 'LOW'))
    )
    return result.reset_index(drop=True)


def build_replenishment_plan(parsed, days=30):
    """Generate actionable replenishment plan per SKU with zone split."""
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()
    state_data = parsed[parsed['state'] != '__TOTAL__'].copy()
    state_data['zone'] = state_data['state'].map(STATE_TO_ZONE).fillna('Unknown')

    # Get zone demand proportions per SKU
    sku_zone = state_data.groupby(['sku', 'zone'])['grand_total'].sum().unstack(fill_value=0)
    sku_zone_pct = sku_zone.div(sku_zone.sum(axis=1), axis=0).round(3)

    records = []
    for _, row in sku_totals.iterrows():
        sku = row['sku']
        total = row['grand_total']
        daily_rate = total / days
        reorder_qty = int(np.ceil(daily_rate * 45))  # 45-day buffer

        # Zone split
        if sku in sku_zone_pct.index:
            zones = sku_zone_pct.loc[sku]
        else:
            zones = pd.Series({'North': 0.25, 'South': 0.25, 'East': 0.25, 'West': 0.25})

        north_pct = zones.get('North', 0)
        south_pct = zones.get('South', 0)
        east_pct = zones.get('East', 0)
        west_pct = zones.get('West', 0)
        # Handle NaN values
        north_qty = int(np.ceil(reorder_qty * (north_pct if not pd.isna(north_pct) else 0)))
        south_qty = int(np.ceil(reorder_qty * (south_pct if not pd.isna(south_pct) else 0)))
        east_qty = int(np.ceil(reorder_qty * (east_pct if not pd.isna(east_pct) else 0)))
        west_qty = int(np.ceil(reorder_qty * (west_pct if not pd.isna(west_pct) else 0)))

        # Priority based on velocity
        if total >= 50:
            priority = 'P1 - URGENT'
        elif total >= 20:
            priority = 'P2 - HIGH'
        elif total >= 5:
            priority = 'P3 - MEDIUM'
        else:
            priority = 'P4 - LOW'

        # Action flags
        cancel_rate = (row['cancelled'] / total * 100) if total > 0 else 0
        action = []
        if cancel_rate > 15:
            action.append('Investigate high cancellations')
        if row['pending'] > daily_rate * 3:
            action.append('Clear pending backlog')
        if reorder_qty > 0:
            action.append(f'Replenish {reorder_qty} units')
        if not action:
            action.append('Monitor')

        records.append({
            'SKU': sku,
            'Priority': priority,
            'Total Orders (30d)': total,
            'Daily Rate': round(daily_rate, 1),
            'Reorder Qty (45d buffer)': reorder_qty,
            'North Zone Qty': north_qty,
            'South Zone Qty': south_qty,
            'East Zone Qty': east_qty,
            'West Zone Qty': west_qty,
            'Cancel Rate %': round(cancel_rate, 1),
            'Action Items': ' | '.join(action),
        })

    plan_df = pd.DataFrame(records)
    plan_df = plan_df.sort_values(['Priority', 'Total Orders (30d)'], ascending=[True, False])
    return plan_df.reset_index(drop=True)


def build_fulfillment_scorecard(parsed, days=30):
    """Generate overall fulfillment health scorecard."""
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()

    total_orders = sku_totals['grand_total'].sum()
    total_cancelled = sku_totals['cancelled'].sum()
    total_delivered = sku_totals['delivered'].sum()
    total_pending = sku_totals['pending'].sum()
    total_intransit = sku_totals['shipped_intransit'].sum()
    total_returns = (sku_totals['rejected'] + sku_totals['returned_to_seller'] + sku_totals['returning']).sum()
    total_fulfilled = total_delivered + sku_totals['out_for_delivery'].sum() + total_intransit + sku_totals['picked_up'].sum()

    metrics = {
        'Metric': [
            f'Total Orders ({days} days)',
            'Total Fulfilled (Shipped + Delivered)',
            'Total Delivered to Buyer',
            'Total Cancelled',
            'Total Pending',
            'Total In Transit',
            'Total Returns + Rejections',
            '',
            'Cancellation Rate',
            'Delivery Rate (Delivered / Total)',
            'Fulfillment Rate (Fulfilled / Total)',
            'Return Rate',
            'Pending Rate',
            '',
            'Active SKUs',
            'Fast Movers (50+ orders)',
            'Medium Movers (20-49)',
            'Slow Movers (5-19)',
            'Very Slow (<5 orders)',
            '',
            'OVERALL HEALTH SCORE',
        ],
        'Value': [
            int(total_orders),
            int(total_fulfilled),
            int(total_delivered),
            int(total_cancelled),
            int(total_pending),
            int(total_intransit),
            int(total_returns),
            '',
            f"{total_cancelled / total_orders * 100:.1f}%",
            f"{total_delivered / total_orders * 100:.1f}%",
            f"{total_fulfilled / total_orders * 100:.1f}%",
            f"{total_returns / total_orders * 100:.1f}%",
            f"{total_pending / total_orders * 100:.1f}%",
            '',
            len(sku_totals),
            len(sku_totals[sku_totals['grand_total'] >= 50]),
            len(sku_totals[(sku_totals['grand_total'] >= 20) & (sku_totals['grand_total'] < 50)]),
            len(sku_totals[(sku_totals['grand_total'] >= 5) & (sku_totals['grand_total'] < 20)]),
            len(sku_totals[sku_totals['grand_total'] < 5]),
            '',
            '',
        ],
        'Benchmark / Note': [
            '',
            '',
            'Target: 80%+ of total orders',
            'Target: <5%',
            'Target: <2%',
            'Normal if recent orders',
            'Target: <3%',
            '',
            'CRITICAL if >10%' if total_cancelled / total_orders > 0.10 else 'Acceptable if <10%',
            'CRITICAL - needs FBA optimization' if total_delivered / total_orders < 0.5 else 'OK',
            '',
            'OK' if total_returns / total_orders < 0.03 else 'Needs attention',
            'ACTION NEEDED' if total_pending / total_orders > 0.02 else 'OK',
            '',
            '',
            'Focus replenishment here',
            'Regular replenishment cycle',
            'Evaluate if worth stocking at FBA',
            'Consider removing from FBA',
            '',
            '',
        ]
    }

    # Calculate health score (0-100)
    cancel_score = max(0, 100 - (total_cancelled / total_orders * 100) * 5)  # Penalize cancellations heavily
    delivery_score = (total_delivered / total_orders * 100) * 1.0
    pending_score = max(0, 100 - (total_pending / total_orders * 100) * 10)
    return_score = max(0, 100 - (total_returns / total_orders * 100) * 10)
    health_score = int((cancel_score * 0.3 + delivery_score * 0.35 + pending_score * 0.2 + return_score * 0.15))

    if health_score >= 80:
        grade = 'A - EXCELLENT'
    elif health_score >= 60:
        grade = 'B - GOOD'
    elif health_score >= 40:
        grade = 'C - NEEDS IMPROVEMENT'
    else:
        grade = 'D - CRITICAL'

    metrics['Value'][-1] = f"{health_score}/100 — {grade}"
    metrics['Benchmark / Note'][-1] = 'Target: 80+'

    return pd.DataFrame(metrics)


def build_action_summary(parsed):
    """Generate prioritized action items."""
    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()
    total_orders = sku_totals['grand_total'].sum()
    total_cancelled = sku_totals['cancelled'].sum()
    total_pending = sku_totals['pending'].sum()
    total_delivered = sku_totals['delivered'].sum()

    actions = []
    action_id = 1

    # 1. Address high cancellation rate
    if total_cancelled / total_orders > 0.05:
        high_cancel_skus = sku_totals[
            (sku_totals['cancelled'] / sku_totals['grand_total']) > 0.15
        ]['sku'].tolist()
        actions.append({
            'Priority': 'P0 - IMMEDIATE',
            'Action': 'Reduce Cancellation Rate',
            'Details': f"Current: {total_cancelled/total_orders*100:.1f}%. Target: <5%. "
                       f"{len(high_cancel_skus)} SKUs have >15% cancel rate. "
                       f"Check: stock availability, listing accuracy, pricing, delivery estimates.",
            'Impact': 'HIGH - Direct revenue loss',
            'SKUs Affected': ', '.join(high_cancel_skus[:10]) if high_cancel_skus else 'N/A',
        })
        action_id += 1

    # 2. Clear pending orders
    if total_pending > 0:
        pending_skus = sku_totals[sku_totals['pending'] > 0].nlargest(10, 'pending')
        actions.append({
            'Priority': 'P0 - IMMEDIATE',
            'Action': 'Clear Pending Orders Backlog',
            'Details': f"{int(total_pending)} orders stuck in Pending. "
                       f"Ship within 24 hrs or risk auto-cancellation and account health impact.",
            'Impact': 'CRITICAL - Account health risk',
            'SKUs Affected': ', '.join(pending_skus['sku'].tolist()),
        })
        action_id += 1

    # 3. FBA enrollment for top SKUs
    fast_movers = sku_totals[sku_totals['grand_total'] >= 50]['sku'].tolist()
    if fast_movers:
        actions.append({
            'Priority': 'P1 - THIS WEEK',
            'Action': 'Ensure Top SKUs are FBA-enrolled',
            'Details': f"{len(fast_movers)} SKUs have 50+ orders/month. "
                       f"These MUST be in FBA for Prime badge & faster delivery. "
                       f"Create FBA inbound shipment for any not already enrolled.",
            'Impact': 'HIGH - Conversion & delivery improvement',
            'SKUs Affected': ', '.join(fast_movers[:15]),
        })
        action_id += 1

    # 4. Regional stock placement
    actions.append({
        'Priority': 'P1 - THIS WEEK',
        'Action': 'Optimize FBA Regional Placement',
        'Details': "Send inventory to Amazon FBA warehouses in all 4 zones (North/South/East/West) "
                   "proportional to demand. See Zone Analysis sheet for split. "
                   "This reduces delivery time and cancellations.",
        'Impact': 'HIGH - Faster delivery, lower RTO',
        'SKUs Affected': 'All FBA SKUs',
    })
    action_id += 1

    # 5. Low delivery rate fix
    if total_delivered / total_orders < 0.3:
        actions.append({
            'Priority': 'P1 - THIS WEEK',
            'Action': 'Investigate Low Delivery Rate',
            'Details': f"Only {total_delivered/total_orders*100:.1f}% orders show as Delivered. "
                       f"Check: Are you using Easy Ship / FBA? Self-ship has lowest delivery rates. "
                       f"Move top SKUs to FBA immediately.",
            'Impact': 'CRITICAL - Customer satisfaction & account metrics',
            'SKUs Affected': 'All SKUs',
        })
        action_id += 1

    # 6. Replenish stock
    actions.append({
        'Priority': 'P2 - THIS MONTH',
        'Action': 'Execute Replenishment Plan',
        'Details': "Follow the Replenishment Plan sheet. Send 45-day buffer stock to FBA. "
                   "Split quantities across zones as recommended. "
                   "Prioritize P1 SKUs first.",
        'Impact': 'MEDIUM - Prevent stockouts',
        'SKUs Affected': 'See Replenishment Plan sheet',
    })

    # 7. Slow mover cleanup
    very_slow = sku_totals[sku_totals['grand_total'] < 3]['sku'].tolist()
    if very_slow:
        actions.append({
            'Priority': 'P3 - NEXT MONTH',
            'Action': 'Review Very Slow SKUs',
            'Details': f"{len(very_slow)} SKUs have fewer than 3 orders in 30 days. "
                       f"Consider: removal from FBA (saves storage fees), listing optimization, "
                       f"or discontinuation.",
            'Impact': 'LOW - Cost optimization',
            'SKUs Affected': ', '.join(very_slow[:15]) + (f' + {len(very_slow)-15} more' if len(very_slow) > 15 else ''),
        })

    return pd.DataFrame(actions)


def build_inventory_comparison(parsed, inventory_df, days=30):
    """Compare current FBA inventory with demand-based requirements."""
    if inventory_df is None or inventory_df.empty:
        return None

    sku_totals = parsed[parsed['state'] == '__TOTAL__'].copy()
    sku_totals['daily_rate'] = sku_totals['grand_total'] / days
    sku_totals['required_stock_45d'] = (sku_totals['daily_rate'] * 45).round(0).astype(int)

    merged = sku_totals[['sku', 'grand_total', 'daily_rate', 'required_stock_45d']].merge(
        inventory_df[['sku', 'fba_available', 'fba_inbound', 'fba_reserved', 'fba_total']],
        on='sku', how='outer'
    )

    for col in ['grand_total', 'daily_rate', 'required_stock_45d']:
        merged[col] = merged[col].fillna(0)
    for col in ['fba_available', 'fba_inbound', 'fba_reserved', 'fba_total']:
        merged[col] = merged[col].fillna(0).astype(int)

    merged['stock_gap'] = (merged['required_stock_45d'] - merged['fba_available']).astype(int)
    merged['days_of_stock'] = np.where(
        merged['daily_rate'] > 0,
        (merged['fba_available'] / merged['daily_rate']).round(1),
        999
    )

    merged['urgency'] = np.where(
        merged['days_of_stock'] <= 7, 'CRITICAL - Restock NOW',
        np.where(merged['days_of_stock'] <= 14, 'URGENT - Restock this week',
                 np.where(merged['days_of_stock'] <= 30, 'PLAN - Restock this month',
                          'OK'))
    )

    result = merged[[
        'sku', 'grand_total', 'daily_rate', 'fba_available', 'fba_inbound',
        'fba_reserved', 'fba_total', 'required_stock_45d', 'stock_gap',
        'days_of_stock', 'urgency'
    ]].sort_values('stock_gap', ascending=False).reset_index(drop=True)

    result.columns = [
        'SKU', 'Orders (30d)', 'Daily Rate', 'FBA Available', 'FBA Inbound',
        'FBA Reserved', 'FBA Total', 'Required (45d)', 'Stock Gap',
        'Days of Stock', 'Urgency'
    ]

    return result


def generate_report(use_api=False, days=30):
    """Main function to generate the full fulfillment plan Excel report."""
    print("=" * 60)
    print(f"  AMAZON INDIA FULFILLMENT PLAN GENERATOR ({days}-DAY ANALYSIS)")
    print("=" * 60)

    # 1. Load data
    inventory_df = None
    if use_api:
        from amazon_api import fetch_orders_data, fetch_fba_inventory
        print(f"\n[1/9] Fetching {days}-day order data from Amazon SP-API...")
        raw_df = fetch_orders_data(days=days)
        print(f"      Loaded {len(raw_df)} rows from API")

        print("[2/9] Fetching FBA inventory from API...")
        try:
            inventory_df = fetch_fba_inventory()
            print(f"      Loaded {len(inventory_df)} inventory records")
        except Exception as e:
            print(f"      WARNING: Could not fetch inventory: {e}")
            inventory_df = None
    else:
        print("\n[1/8] Loading sales data...")
        raw_df = pd.read_excel(INPUT_FILE)
        print(f"      Loaded {len(raw_df)} rows from Excel")

    # 2. Parse hierarchical data
    print("[2/8] Parsing SKU & state hierarchical data...")
    parsed = parse_hierarchical_data(raw_df)
    sku_count = len(parsed[parsed['state'] == '__TOTAL__'])
    state_records = len(parsed[parsed['state'] != '__TOTAL__'])
    print(f"      Found {sku_count} SKUs with {state_records} state-level records")

    # 3. Build analyses
    print("[3/8] Building SKU performance analysis...")
    sku_analysis = build_sku_analysis(parsed, days=days)

    print("[4/8] Building state demand analysis...")
    state_analysis = build_state_analysis(parsed)

    print("[5/8] Building zone analysis & FBA placement strategy...")
    zone_analysis = build_zone_analysis(parsed)

    print("[6/8] Building replenishment plan...")
    replenishment = build_replenishment_plan(parsed, days=days)

    print("[7/8] Building cancellation analysis...")
    cancel_analysis = build_cancellation_analysis(parsed)

    print("[8/8] Generating fulfillment scorecard & action plan...")
    scorecard = build_fulfillment_scorecard(parsed, days=days)
    actions = build_action_summary(parsed)

    # Also build top SKU x State matrix
    sku_state_matrix = build_top_sku_state_matrix(parsed)

    # ─── Write Excel ────────────────────────────────────────────
    print(f"\nWriting report to: {OUTPUT_FILE}")

    with pd.ExcelWriter(OUTPUT_FILE, engine='openpyxl') as writer:
        # Sheet 1: Scorecard
        scorecard.to_excel(writer, sheet_name='Fulfillment Scorecard', index=False)

        # Sheet 2: Action Plan
        actions.to_excel(writer, sheet_name='Action Plan', index=False)

        # Sheet 3: SKU Analysis
        sku_analysis.to_excel(writer, sheet_name='SKU Performance', index=False)

        # Sheet 4: Replenishment Plan
        replenishment.to_excel(writer, sheet_name='Replenishment Plan', index=False)

        # Sheet 5: State Demand
        state_analysis.to_excel(writer, sheet_name='State Demand', index=False)

        # Sheet 6: Zone Analysis
        zone_analysis.to_excel(writer, sheet_name='Zone Analysis', index=False)

        # Sheet 7: Cancellation Deep Dive
        cancel_analysis.to_excel(writer, sheet_name='Cancellation Analysis', index=False)

        # Sheet 8: SKU x State Matrix
        sku_state_matrix.to_excel(writer, sheet_name='SKU-State Matrix')

        # Sheet 9: Inventory vs Demand (API mode only)
        if inventory_df is not None:
            inv_comparison = build_inventory_comparison(parsed, inventory_df, days=days)
            if inv_comparison is not None:
                inv_comparison.to_excel(writer, sheet_name='Inventory vs Demand', index=False)

        # ─── Format sheets ──────────────────────────────────────
        for sheet_name in writer.sheets:
            ws = writer.sheets[sheet_name]
            # Auto-fit column widths (approximate)
            for col in ws.columns:
                max_len = 0
                col_letter = col[0].column_letter
                for cell in col:
                    try:
                        if cell.value:
                            max_len = max(max_len, len(str(cell.value)))
                    except:
                        pass
                ws.column_dimensions[col_letter].width = min(max_len + 3, 50)

    print("\n" + "=" * 60)
    print("  REPORT GENERATED SUCCESSFULLY!")
    print("=" * 60)
    print(f"\n  File: {OUTPUT_FILE}")
    sheet_count = 9 if inventory_df is not None else 8
    print(f"  Sheets: {sheet_count}")
    print(f"  SKUs analyzed: {sku_count}")
    print(f"  States covered: {state_analysis.shape[0]}")

    # Print quick summary
    print("\n  ── QUICK SUMMARY ──")
    for _, row in scorecard.head(14).iterrows():
        if row['Metric'] and row['Value'] != '':
            note = f"  ← {row['Benchmark / Note']}" if row['Benchmark / Note'] else ''
            print(f"  {row['Metric']}: {row['Value']}{note}")

    # Print health score
    health_row = scorecard[scorecard['Metric'] == 'OVERALL HEALTH SCORE']
    if not health_row.empty:
        print(f"\n  >>> {health_row.iloc[0]['Metric']}: {health_row.iloc[0]['Value']} <<<")

    print("\n  ── TOP 3 ACTIONS ──")
    for i, (_, row) in enumerate(actions.head(3).iterrows(), 1):
        print(f"  {i}. [{row['Priority']}] {row['Action']}")

    return OUTPUT_FILE


if __name__ == '__main__':
    use_api = '--api' in sys.argv
    days = 30
    for arg in sys.argv:
        if arg.startswith('--days='):
            days = int(arg.split('=')[1])
    generate_report(use_api=use_api, days=days)
