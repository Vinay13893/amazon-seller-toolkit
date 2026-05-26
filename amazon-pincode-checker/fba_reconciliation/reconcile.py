"""
FBA Reconciliation — Core Logic
=================================
Takes the raw DataFrames from sp_client and produces clean summary tables:

  1. ledger_summary   — per-SKU: opening / received / sold / returned / adjustments / closing
  2. returns_summary  — per-SKU: count & units by disposition
  3. unfulfillable    — stock stuck in unfulfillable (needs removal/disposal action)
  4. reimbursements_  — reimbursements grouped by SKU + reason
  5. inbound_discrepancies — shipments where received < shipped
  6. reconciliation   — month-end formula check (calculated vs actual)
"""

import pandas as pd
import numpy as np


# ─── Event-type maps for the Inventory Ledger ──────────────────
RECEIPT_EVENTS = {"receipts", "receipt", "inbound", "inbound-receipt"}
SALE_EVENTS    = {"shipments", "shipment", "fulfillment", "customer-shipment",
                  "ship", "fba-outbound"}
RETURN_EVENTS  = {"customer-returns", "customer-return", "returns", "return",
                  "customer_return"}
ADJUST_EVENTS  = {"adjustments", "adjustment", "inventory-adjustment",
                  "found", "lost", "damaged", "warehouse-damage"}
REMOVAL_EVENTS = {"removals", "removal", "disposal", "dispose", "liquidation"}
TRANSFER_EVENTS= {"transfers", "transfer", "fc-transfer"}


def _classify_event(event_type: str) -> str:
    e = (event_type or "").lower().strip().replace("_", "-")
    if e in RECEIPT_EVENTS:  return "receipt"
    if e in SALE_EVENTS:     return "sale"
    if e in RETURN_EVENTS:   return "return"
    if e in ADJUST_EVENTS:   return "adjustment"
    if e in REMOVAL_EVENTS:  return "removal"
    if e in TRANSFER_EVENTS: return "transfer"
    return "other"


def build_ledger_summary(ledger_df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate ledger rows per SKU → opening, received, sold, returns,
    adjustments, removals, closing.
    """
    if ledger_df.empty:
        return pd.DataFrame()

    df = ledger_df.copy()
    df["event_class"] = df["event_type"].apply(_classify_event)
    df["qty"]         = df["quantity"]  # already int

    group = df.groupby(["asin", "sku", "title"])

    def _agg(g):
        receipts    =  g.loc[g["event_class"] == "receipt",    "qty"].sum()
        sales       = -g.loc[g["event_class"] == "sale",       "qty"].sum()   # ledger records as negative
        returns     =  g.loc[g["event_class"] == "return",     "qty"].sum()
        adjustments =  g.loc[g["event_class"] == "adjustment", "qty"].sum()
        removals    = -g.loc[g["event_class"] == "removal",    "qty"].sum()
        transfers   =  g.loc[g["event_class"] == "transfer",   "qty"].sum()
        other       =  g.loc[g["event_class"] == "other",      "qty"].sum()

        # Opening balance = everything that happened before the period (not available directly
        # from the ledger — Amazon includes it as first row with event "Beginning Balance" or
        # event qty at start). We sum all +ve events minus all -ve to get the net change.
        net_change = receipts + sales + returns + adjustments + removals + transfers + other
        return pd.Series({
            "units_received":    int(receipts),
            "units_sold":        int(abs(sales)),
            "units_returned":    int(returns),
            "adjustments_net":   int(adjustments),
            "units_removed":     int(abs(removals)),
            "net_ledger_change": int(net_change),
        })

    summary = group.apply(_agg).reset_index()
    return summary


def build_returns_summary(returns_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-SKU breakdown of returns by disposition.
    Sellable → goes back to available stock (good).
    Everything else → stuck in unfulfillable (action needed).
    """
    if returns_df.empty:
        return pd.DataFrame()

    df = returns_df.copy()
    # Pivot dispositions into columns
    pivot = (
        df.groupby(["asin", "sku", "title", "disposition"])["quantity"]
        .sum()
        .unstack(fill_value=0)
        .reset_index()
    )

    # Ensure standard columns exist
    for col in ["SELLABLE", "CUSTOMER_DAMAGED", "DEFECTIVE",
                "WAREHOUSE_DAMAGED", "CARRIER_DAMAGED", "EXPIRED", "UNSELLABLE"]:
        if col not in pivot.columns:
            pivot[col] = 0

    # Total unsellable (stuck in warehouse)
    unsellable_cols = [c for c in pivot.columns
                       if c not in ["asin", "sku", "title", "SELLABLE"]]
    pivot["total_unsellable"] = pivot[unsellable_cols].sum(axis=1)
    pivot["total_returns"]    = pivot["SELLABLE"] + pivot["total_unsellable"]

    pivot = pivot.rename(columns={
        "SELLABLE":         "returned_sellable",
        "CUSTOMER_DAMAGED": "customer_damaged",
        "DEFECTIVE":        "defective",
        "WAREHOUSE_DAMAGED":"warehouse_damaged",
        "CARRIER_DAMAGED":  "carrier_damaged",
        "EXPIRED":          "expired",
        "UNSELLABLE":       "unsellable_other",
    })
    return pivot


def build_unfulfillable_report(
        returns_df: pd.DataFrame,
        inventory_df: pd.DataFrame
) -> pd.DataFrame:
    """
    Combine current unfulfillable stock (from inventory snapshot) with
    return disposition data to understand what is stuck and why.
    """
    rows = []

    # From inventory snapshot — current unfulfillable per SKU
    if not inventory_df.empty:
        unsell = inventory_df[inventory_df["unfulfillable"] > 0].copy()
        for _, row in unsell.iterrows():
            rows.append({
                "asin":              row.get("asin", ""),
                "sku":               row.get("sku",  ""),
                "title":             row.get("title",""),
                "unfulfillable_qty": int(row["unfulfillable"]),
                "action_needed":     "REMOVE or DISPOSE",
                "note": (
                    "Stock is sitting idle in unfulfillable. "
                    "Place a removal order or disposal order to act on it."
                ),
            })

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # Enrich with return disposition breakdown if available
    if not returns_df.empty:
        damage_summary = (
            returns_df[returns_df["disposition"] != "SELLABLE"]
            .groupby(["asin", "sku"])["quantity"]
            .sum()
            .reset_index()
            .rename(columns={"quantity": "returned_unsellable_units"})
        )
        df = df.merge(damage_summary, on=["asin", "sku"], how="left")
        df["returned_unsellable_units"] = df["returned_unsellable_units"].fillna(0).astype(int)
    else:
        df["returned_unsellable_units"] = 0

    df = df.sort_values("unfulfillable_qty", ascending=False)
    return df


def build_reimbursements_summary(reimb_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-SKU reimbursement breakdown: total cash reimbursed, unit reimbursements,
    and reason breakdown.
    """
    if reimb_df.empty:
        return pd.DataFrame()

    by_sku = (
        reimb_df.groupby(["asin", "sku", "title", "reason"])
        .agg(
            total_amount=("amount",        "sum"),
            qty_cash=    ("qty_cash",      "sum"),
            qty_inventory=("qty_inventory","sum"),
            qty_total=   ("qty_total",     "sum"),
            event_count= ("amount",        "count"),
        )
        .reset_index()
    )

    # Also a totals row per SKU (across reasons)
    totals = (
        reimb_df.groupby(["asin", "sku", "title"])
        .agg(
            total_amount=  ("amount",        "sum"),
            total_qty=     ("qty_total",     "sum"),
            event_count=   ("amount",        "count"),
        )
        .reset_index()
    )
    return by_sku, totals


def build_inbound_discrepancies(inbound_df: pd.DataFrame) -> pd.DataFrame:
    """
    Flag shipment lines where qty_received < qty_shipped.
    These are potential cases for reimbursement claims.
    """
    if inbound_df.empty:
        return pd.DataFrame()

    df = inbound_df.copy()

    # Group by shipment + SKU (may have dupes across pages)
    df = (
        df.groupby(["shipment_id", "shipment_name", "status", "destination_fc", "sku", "fnsku"])
        .agg(qty_shipped=("qty_shipped","sum"), qty_received=("qty_received","sum"))
        .reset_index()
    )
    df["discrepancy"]    = df["qty_received"] - df["qty_shipped"]
    df["pct_received"]   = np.where(
        df["qty_shipped"] > 0,
        (df["qty_received"] / df["qty_shipped"] * 100).round(1),
        100.0
    )

    short    = df[df["discrepancy"] < 0].copy()
    short    = short.sort_values("discrepancy")
    short["action"] = short.apply(
        lambda r: (
            "CLAIM REIMBURSEMENT — units not received by Amazon"
            if r["status"] == "CLOSED"
            else "SHIPMENT STILL OPEN — monitor for full receipt"
        ), axis=1
    )
    return short


def build_reconciliation(
        ledger_summary: pd.DataFrame,
        inventory_df: pd.DataFrame,
        returns_summary: pd.DataFrame,
) -> pd.DataFrame:
    """
    Month-end formula per SKU:
        Opening + Received − Sold + Returns(Sellable) + Adjustments = Closing(Calculated)
        Compare against Actual FBA Available.
    """
    if ledger_summary.empty or inventory_df.empty:
        return pd.DataFrame()

    # Merge ledger summary with current snapshot
    inv = inventory_df[["asin", "sku", "available", "unfulfillable",
                         "reserved", "inbound", "total"]].copy()
    merged = ledger_summary.merge(inv, on=["asin", "sku"], how="outer")
    merged["available"]    = merged["available"].fillna(0).astype(int)
    merged["unfulfillable"]= merged["unfulfillable"].fillna(0).astype(int)

    # Add sellable returns
    if returns_summary is not None and not returns_summary.empty:
        sel_ret = returns_summary[["asin", "sku", "returned_sellable"]].copy()
        merged  = merged.merge(sel_ret, on=["asin", "sku"], how="left")
        merged["returned_sellable"] = merged["returned_sellable"].fillna(0).astype(int)
    else:
        merged["returned_sellable"] = 0

    # Calculated closing = net_ledger_change (already computed in build_ledger_summary)
    # But we want the formula displayed clearly. We recompute:
    merged["calculated_closing"] = (
        merged["units_received"]
        - merged["units_sold"]
        + merged["returned_sellable"]
        + merged["adjustments_net"]
        - merged["units_removed"]
    )

    merged["actual_available"] = merged["available"]
    merged["variance"]         = merged["actual_available"] - merged["calculated_closing"]

    merged["status"] = merged["variance"].apply(
        lambda v: (
            "OK" if v == 0
            else "UNDER (Amazon owes you units)" if v < 0
            else "OVER (check for duplicate counts)"
        )
    )

    cols = [
        "asin", "sku", "title",
        "units_received", "units_sold",
        "returned_sellable", "adjustments_net", "units_removed",
        "calculated_closing", "actual_available",
        "unfulfillable", "reserved", "inbound",
        "variance", "status",
    ]
    # keep only cols that exist
    cols = [c for c in cols if c in merged.columns]
    return merged[cols].sort_values("units_sold", ascending=False)
