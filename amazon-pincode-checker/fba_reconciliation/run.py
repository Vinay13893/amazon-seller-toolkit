"""
FBA Reconciliation — Main Runner
==================================
Usage:
    python run.py                  # current month to date
    python run.py --month 2026-04  # specific month (YYYY-MM)
    python run.py --days 90        # last N days

Outputs a colour-coded Excel workbook to:
    fba_reconciliation/output/fba_reconciliation_<period>.xlsx
"""

import argparse
import os
import sys
import traceback
from datetime import datetime, timezone, timedelta
import calendar
import pandas as pd

# ─── Paths ─────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

sys.path.insert(0, SCRIPT_DIR)
from sp_client    import (
    fetch_inventory_ledger,
    fetch_customer_returns,
    fetch_reimbursements,
    fetch_inventory_snapshot,
    fetch_inbound_shipments,
)
from reconcile    import (
    build_ledger_summary,
    build_returns_summary,
    build_unfulfillable_report,
    build_reimbursements_summary,
    build_inbound_discrepancies,
    build_reconciliation,
)
from report_builder import build_excel


# ─── Period helpers ───────────────────────────────────────────
def _parse_period(args):
    if args.month:
        year, month = [int(x) for x in args.month.split("-")]
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end   = datetime(year, month,
                         calendar.monthrange(year, month)[1],
                         tzinfo=timezone.utc)
        label = f"{start.strftime('%B %Y')}"
    else:
        days  = args.days or 30
        end   = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(seconds=1)
        start = end - timedelta(days=days - 1)
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        label = f"Last {days} days (up to {end.date()})"
    return start, end, label


# ─── Main ─────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="FBA Inventory Reconciliation Tool")
    parser.add_argument("--month",  help="Month to analyse  e.g. 2026-04")
    parser.add_argument("--days",   type=int, help="Analyse last N days  (default: 30)")
    parser.add_argument("--skip-ledger",     action="store_true",
                        help="Skip inventory ledger (faster, loses reconciliation formula)")
    parser.add_argument("--skip-inbound",    action="store_true",
                        help="Skip inbound shipment API call")
    args = parser.parse_args()

    start_dt, end_dt, period_label = _parse_period(args)
    print(f"\n{'='*60}")
    print(f"  FBA Reconciliation — {period_label}")
    print(f"  Period: {start_dt.date()} → {end_dt.date()}")
    print(f"{'='*60}")

    errors = {}

    # ── 1. Inventory Ledger ────────────────────────────────────
    ledger_df = pd.DataFrame()
    if not args.skip_ledger:
        try:
            ledger_df = fetch_inventory_ledger(start_dt, end_dt)
        except Exception as e:
            errors["Inventory Ledger"] = str(e)
            print(f"  ⚠ Inventory Ledger failed: {e}")

    # ── 2. Customer Returns ────────────────────────────────────
    returns_df = pd.DataFrame()
    try:
        returns_df = fetch_customer_returns(start_dt, end_dt)
    except Exception as e:
        errors["Customer Returns"] = str(e)
        print(f"  ⚠ Customer Returns failed: {e}")

    # ── 3. Reimbursements ─────────────────────────────────────
    reimb_df = pd.DataFrame()
    try:
        reimb_df = fetch_reimbursements(start_dt, end_dt)
    except Exception as e:
        errors["Reimbursements"] = str(e)
        print(f"  ⚠ Reimbursements failed: {e}")

    # ── 4. Current Inventory Snapshot ─────────────────────────
    inventory_df = pd.DataFrame()
    try:
        inventory_df = fetch_inventory_snapshot()
    except Exception as e:
        errors["Inventory Snapshot"] = str(e)
        print(f"  ⚠ Inventory Snapshot failed: {e}")

    # ── 5. Inbound Shipments ───────────────────────────────────
    inbound_df = pd.DataFrame()
    if not args.skip_inbound:
        try:
            inbound_df = fetch_inbound_shipments()
        except Exception as e:
            # Non-critical — inbound check is advisory
            print(f"  ⚠ Inbound Shipments skipped: {e}")

    # ── Analysis ───────────────────────────────────────────────
    print("\n  Running reconciliation analysis ...")

    ledger_summary  = build_ledger_summary(ledger_df)
    returns_summary = build_returns_summary(returns_df)
    unfulfillable   = build_unfulfillable_report(returns_df, inventory_df)
    reimb_detail, reimb_totals = (
        build_reimbursements_summary(reimb_df)
        if not reimb_df.empty
        else (pd.DataFrame(), pd.DataFrame())
    )
    inbound_discrepancies = build_inbound_discrepancies(inbound_df)
    reconciliation  = build_reconciliation(ledger_summary, inventory_df, returns_summary)

    # ── Print console summary ──────────────────────────────────
    print(f"\n  {'─'*50}")
    print(f"  SUMMARY")
    print(f"  {'─'*50}")

    if not reconciliation.empty:
        total_sold  = reconciliation["units_sold"].sum()       if "units_sold"  in reconciliation else 0
        total_avail = reconciliation["actual_available"].sum() if "actual_available" in reconciliation else 0
        total_unf   = reconciliation["unfulfillable"].sum()    if "unfulfillable" in reconciliation else 0
        under       = (reconciliation["variance"] < 0).sum()  if "variance" in reconciliation else 0
        print(f"  Units Sold:          {total_sold:,}")
        print(f"  Available Stock:     {total_avail:,}")
        print(f"  Unfulfillable Stock: {total_unf:,}   ← needs action!")
        print(f"  SKUs with variance:  {under} under")

    if not returns_summary.empty:
        total_ret  = returns_summary["total_returns"].sum()    if "total_returns"    in returns_summary else 0
        total_sell = returns_summary["returned_sellable"].sum() if "returned_sellable" in returns_summary else 0
        total_dam  = returns_summary["total_unsellable"].sum() if "total_unsellable" in returns_summary else 0
        print(f"\n  Total Returns:       {int(total_ret):,}")
        print(f"    Sellable (back):   {int(total_sell):,}")
        print(f"    Unsellable (stuck):{int(total_dam):,}   ← file claim or remove!")

    if not reimb_totals.empty and "total_amount" in reimb_totals:
        total_reimb = reimb_totals["total_amount"].sum()
        print(f"\n  Total Reimbursed:    ₹{total_reimb:,.0f}")

    if not inbound_discrepancies.empty and "discrepancy" in inbound_discrepancies:
        short_units = abs(inbound_discrepancies["discrepancy"].sum())
        print(f"\n  Short-Received:      {int(short_units):,} units across {len(inbound_discrepancies)} shipment lines")

    if errors:
        print(f"\n  ⚠ The following sections had errors:")
        for section, err in errors.items():
            print(f"    • {section}: {err}")

    # ── Excel Output ───────────────────────────────────────────
    timestamp    = datetime.now().strftime("%Y%m%d_%H%M")
    period_slug  = period_label.replace(" ", "_").replace("/", "-")[:30]
    output_path  = os.path.join(OUTPUT_DIR, f"fba_reconciliation_{period_slug}_{timestamp}.xlsx")

    try:
        build_excel(
            output_path    = output_path,
            recon_df       = reconciliation,
            returns_detail_df = returns_df,
            returns_total_df  = returns_summary,
            unfulfillable_df  = unfulfillable,
            reimb_detail_df   = reimb_detail,
            reimb_total_df    = reimb_totals,
            inbound_df        = inbound_discrepancies,
            period_label      = period_label,
        )
        print(f"\n  ✓ Excel report: {output_path}")
    except Exception as e:
        print(f"\n  ✗ Excel build failed: {e}")
        traceback.print_exc()

    print(f"\n  Done.")


if __name__ == "__main__":
    main()
