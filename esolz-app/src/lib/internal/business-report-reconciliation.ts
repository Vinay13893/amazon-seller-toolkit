/**
 * Business Report sales-grain fix — account-level (by-date) vs. summed
 * SKU-level (by-ASIN) reconciliation for exactly ONE already-single-day-
 * grain date. Used by the repair/reconciliation script's dry-run report
 * (spec Phase 6/7) to decide, and disclose, how close a corrected day's
 * SKU sum comes to that day's account-level total — NEVER to auto-approve
 * a write.
 *
 * Known, legitimate reasons a correctly single-day-grain SKU sum can still
 * differ slightly from the same day's account-level total (researched via
 * Amazon seller-community documentation of this exact report; this
 * session has no live Amazon report to empirically calibrate against —
 * see PROPOSED_SALES_TOLERANCE_PCT's caveat below):
 *   - Amazon's by-ASIN/by-SKU section only lists ASINs with at least one
 *     order that day; ASINs with zero orders are simply absent (this is
 *     NOT a source of sum mismatch — it's already handled by treating
 *     "absent" as zero for a structurally-complete day, not by a
 *     tolerance).
 *   - Independent per-row vs. per-day currency rounding: Amazon appears to
 *     compute each ASIN's monetary total and each date's monetary total
 *     as separate aggregations, not one always re-derived from the other,
 *     so cent/paisa-level rounding can differ by a few units of currency.
 *   - Sales that cannot be attributed to a specific still-existing
 *     ASIN/SKU (e.g. an order against a since-deleted/suppressed listing)
 *     may be counted in the account-level date total while having no
 *     corresponding row in the by-ASIN section at all.
 * This module does NOT attempt to model these individually — it reports
 * the raw absolute/percent difference and a verdict against a tolerance
 * that is explicitly a PROPOSAL requiring founder sign-off, plus a strict
 * 0%-tolerance diagnostic mode for exact-match auditing.
 */

export type ReconciliationTotals = {
  accountOrderedSales: number
  skuOrderedSalesSum: number
  accountUnits: number
  skuUnitsSum: number
}

export type ReconciliationDiff = {
  salesAbsDiff: number
  /** null when accountOrderedSales is 0 — a percentage of zero is undefined, never reported as 0% or Infinity. */
  salesPctDiff: number | null
  unitsAbsDiff: number
  unitsPctDiff: number | null
}

function pctDiff(account: number, sku: number): number | null {
  if (account === 0) return null
  return ((sku - account) / account) * 100
}

export function computeReconciliationDiff(totals: ReconciliationTotals): ReconciliationDiff {
  return {
    salesAbsDiff: totals.skuOrderedSalesSum - totals.accountOrderedSales,
    salesPctDiff: pctDiff(totals.accountOrderedSales, totals.skuOrderedSalesSum),
    unitsAbsDiff: totals.skuUnitsSum - totals.accountUnits,
    unitsPctDiff: pctDiff(totals.accountUnits, totals.skuUnitsSum),
  }
}

/**
 * PROPOSED default, NOT approved. A small percentage chosen conservatively
 * (tighter than the ~9x-23x inflation this fix corrects, by roughly three
 * orders of magnitude) to make an exceeds-tolerance verdict a meaningful
 * signal rather than noise, given the legitimate-mismatch causes listed
 * above are expected to be rounding-scale, not multi-percent. This has
 * NOT been empirically calibrated against a real corrected single-day
 * Amazon report in this session (no live SP-API credentials available —
 * see final report) and MUST be reviewed/approved by the founder before
 * any date is ever auto-classified safe-for-write against it.
 */
export const PROPOSED_SALES_TOLERANCE_PCT = 1
export const PROPOSED_UNITS_TOLERANCE_ABS = 0 // units are integers; any unit mismatch on a structurally-complete day is treated as exceeds-tolerance by default

export type ReconciliationVerdict = 'within_tolerance' | 'exceeds_tolerance' | 'unknown'

export type ReconciliationMode = { kind: 'tolerance'; salesTolerancePct: number } | { kind: 'strict_exact_match' }

/**
 * Never returns a verdict that implies a date is safe to write — this is a
 * reporting classification only. Callers (the repair script) must
 * separately gate any write on explicit founder approval of the tolerance
 * used, regardless of what verdict this returns.
 */
export function reconciliationVerdict(diff: ReconciliationDiff, mode: ReconciliationMode): ReconciliationVerdict {
  if (diff.salesPctDiff === null) {
    // Account total is exactly zero. A structurally-complete day with zero
    // account sales must also have zero SKU sum (CONFIRMED_ZERO territory,
    // not a percentage comparison).
    return diff.salesAbsDiff === 0 ? 'within_tolerance' : 'exceeds_tolerance'
  }
  const tolerancePct = mode.kind === 'strict_exact_match' ? 0 : mode.salesTolerancePct
  return Math.abs(diff.salesPctDiff) <= tolerancePct ? 'within_tolerance' : 'exceeds_tolerance'
}
