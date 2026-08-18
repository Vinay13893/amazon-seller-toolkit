/**
 * Business Report sales-grain fix — truthful per-day ingestion outcome.
 *
 * Root cause this replaces: scripts/sync-business-reports.ts's success path
 * used to hardcode `rows_rejected: 0` unconditionally (see the old
 * `internal_data_refresh_runs` update at the end of `main()`), so a run
 * could be recorded 'success' with zero rejected rows even when the
 * destination table ended up with no matching row for the date at all
 * (07-28 was found exactly this way by the prior audit). Every downstream
 * consumer of coverage (migration 065's `_sku_perf_window_coverage`,
 * `_sku_perf_rollup_state`) already keys "confirmed complete" off
 * `status = 'success' AND rows_rejected = 0` — that logic was already
 * correct, it was just being fed lies. This module computes the truthful
 * inputs; no schema change and no RPC change are needed to fix this.
 *
 * `internal_data_refresh_runs.status` already allows
 * ('running','success','partial_success','failed') (migration 046) — this
 * module maps a single day's ingestion result onto that existing
 * vocabulary; it does not need a new column or a new enum value.
 */

export type SkuRawRowLike = {
  parentAsin: string | null
  childAsin: string | null
  sku: string | null
  orderedProductSales: number
  unitsOrdered: number
}

export type SkuRowRejectionReason =
  | 'no_identity'
  | 'non_finite_ordered_product_sales'
  | 'negative_ordered_product_sales'
  | 'non_finite_units_ordered'
  | 'negative_units_ordered'

export type SkuRowRejection = { index: number; reason: SkuRowRejectionReason }

export type SkuRowValidationResult<T> = { accepted: T[]; rejected: SkuRowRejection[] }

/**
 * Row-level structural validation for one parsed salesAndTrafficByAsin
 * row. Never invents/repairs a bad value — anything that fails is
 * rejected outright with a named, truthful reason (never silently
 * coerced, never silently dropped without being counted).
 */
export function validateSkuRows<T extends SkuRawRowLike>(rows: T[]): SkuRowValidationResult<T> {
  const accepted: T[] = []
  const rejected: SkuRowRejection[] = []
  rows.forEach((row, index) => {
    if (!row.sku && !row.childAsin && !row.parentAsin) {
      rejected.push({ index, reason: 'no_identity' })
      return
    }
    if (!Number.isFinite(row.orderedProductSales)) {
      rejected.push({ index, reason: 'non_finite_ordered_product_sales' })
      return
    }
    if (row.orderedProductSales < 0) {
      rejected.push({ index, reason: 'negative_ordered_product_sales' })
      return
    }
    if (!Number.isFinite(row.unitsOrdered)) {
      rejected.push({ index, reason: 'non_finite_units_ordered' })
      return
    }
    if (row.unitsOrdered < 0) {
      rejected.push({ index, reason: 'negative_units_ordered' })
      return
    }
    accepted.push(row)
  })
  return { accepted, rejected }
}

export type IngestionStatus = 'success' | 'partial_success' | 'failed'

export type StructuralCompletenessReason =
  | 'missing_by_date_row_for_requested_date'
  | 'multiple_by_date_rows_for_single_day_request'
  | 'sku_rows_rejected'
  | 'positive_sales_but_no_sku_breakdown'

export type StructuralCompletenessInput = {
  /** How many salesAndTrafficByDate rows matched the single requested date exactly. Must be exactly 1 for a well-formed single-day report. */
  byDateMatchCount: number
  /** The matched by-date row's orderedProductSales, when byDateMatchCount === 1. */
  byDateOrderedProductSales: number | null
  /** Total salesAndTrafficByAsin rows Amazon returned for this single-day request, before validation. */
  skuRowsFetched: number
  /** How many of those rows validateSkuRows() rejected. */
  skuRowsRejected: number
}

export type StructuralCompletenessResult = { status: IngestionStatus; reason: StructuralCompletenessReason | null }

/**
 * Decides whether a single calendar day's ingestion attempt may be
 * recorded 'success' (the ONLY status the downstream RPC coverage logic
 * treats as "confirmed complete", and only when paired with
 * rows_rejected = 0). Fails closed in every ambiguous case — never
 * "success" just because the Amazon report call itself reached DONE.
 *
 *  - No by-date row at all for the requested date -> 'failed'. A report
 *    that doesn't even confirm the day's account-level total tells us
 *    nothing trustworthy about that day's SKU breakdown either.
 *  - More than one by-date row matched a single-day request -> 'failed'.
 *    This should be structurally impossible for dateFrom === dateTo; if it
 *    happens, something about the request or the parser is wrong, and
 *    picking one row arbitrarily would be a silent guess.
 *  - Any SKU row failed validation -> 'partial_success' (never 'success')
 *    — some of what Amazon sent could not be trusted, so this day is not
 *    "confirmed complete" even though it must never invent zeros.
 *  - A day with positive account-level sales but ZERO SKU rows at all is
 *    structurally suspicious (every SKU with sales should appear in the
 *    by-SKU section) -> 'partial_success', not silently accepted.
 *  - Otherwise -> 'success'.
 */
export function classifyStructuralCompleteness(input: StructuralCompletenessInput): StructuralCompletenessResult {
  if (input.byDateMatchCount === 0) {
    return { status: 'failed', reason: 'missing_by_date_row_for_requested_date' }
  }
  if (input.byDateMatchCount > 1) {
    return { status: 'failed', reason: 'multiple_by_date_rows_for_single_day_request' }
  }
  if (input.skuRowsRejected > 0) {
    return { status: 'partial_success', reason: 'sku_rows_rejected' }
  }
  if ((input.byDateOrderedProductSales ?? 0) > 0 && input.skuRowsFetched === 0) {
    return { status: 'partial_success', reason: 'positive_sales_but_no_sku_breakdown' }
  }
  return { status: 'success', reason: null }
}

/**
 * Idempotent gap-fill decision for the daily sync script's rolling-window
 * re-run: given the most recent `internal_data_refresh_runs` row already
 * on file for this exact (workspace, marketplace, source, date), should
 * this date be skipped (no Amazon report request at all) this run?
 *
 * Only a date that is ALREADY 'confirmed complete' by the same rule the
 * downstream RPC coverage logic uses (status = 'success' AND
 * rows_rejected = 0 — migration 065's `_sku_perf_window_coverage`) is
 * skipped. Anything else (no prior run, 'failed', 'partial_success', or a
 * 'success' that still had rejected rows) is re-requested, so a gap or a
 * previously-partial day is naturally retried by the next scheduled run
 * without needing a separate backfill step. `--force-refresh` always
 * re-requests regardless, for an explicit correction re-run.
 *
 * This keeps the switch to one-Amazon-report-per-day from multiplying
 * Amazon Reports API call volume by the full rolling-window length every
 * single day forever — a 14-day window's already-confirmed days cost zero
 * extra calls on the next run; only genuinely new/incomplete days do.
 */
export function shouldSkipAlreadyConfirmedDate(
  existingRun: { status: string; rowsRejected: number } | null,
  forceRefresh: boolean,
): boolean {
  if (forceRefresh) return false
  if (!existingRun) return false
  return existingRun.status === 'success' && existingRun.rowsRejected === 0
}
