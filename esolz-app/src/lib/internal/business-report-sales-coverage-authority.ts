/**
 * Business Report sales-grain fix — Sales coverage-trust follow-up.
 *
 * Pure, tested mirror of the exact-day authoritative-run predicate added
 * in supabase/migrations/066_sku_performance_sales_authoritative_run_coverage.sql
 * (`_sku_perf_sales_day_confirmed`, and the `is_confirmed_zero` branch it
 * feeds inside `_sku_perf_window_coverage`/`get_sku_performance_daily`).
 * The real enforcement lives in SQL (there is no live Postgres available
 * in this session to execute pgTAP/DO-block tests against), so this
 * module exists purely as an executable specification: every rule the SQL
 * must follow is expressed here in a form `node --test` can actually run,
 * so the invariant has real regression coverage independent of DB access,
 * and so a future edit to the SQL has a companion spec to check itself
 * against.
 *
 * Confirmed defect this closes: migration 065's coverage predicate was a
 * bare EXISTS over any run whose date_from..date_to range merely overlaps
 * a date — satisfied by the 35+ pre-fix multi-day rolling-window runs
 * already in production (2026-07-20 alone has 11 such rows), regardless
 * of what any new single-day-grain reprocessing attempt does, is doing,
 * or fails at. The invariant below requires BOTH an exact single-day scope
 * AND latest-attempt semantics before a date may ever read as confirmed.
 */

export type SalesRunRecord = {
  id: string
  dateFrom: string
  dateTo: string
  status: string
  rowsRejected: number
  startedAt: string
}

/** A multi-day run is never eligible to certify a SKU-day, full stop — this is the entire gate. */
export function isExactDayRun(run: SalesRunRecord, targetDate: string): boolean {
  return run.dateFrom === targetDate && run.dateTo === targetDate
}

/**
 * The single latest exact-day attempt for `targetDate`, or null if none
 * exists. Ordered by `startedAt` DESC, then `id` DESC as a deterministic
 * tie-breaker (mirrors the SQL's `ORDER BY started_at DESC, id DESC`) —
 * `finished_at` is deliberately never used for ordering since a currently-
 * running attempt has none yet, and `started_at` is set once at insert
 * time and never mutated by any later UPDATE in this codebase, making it
 * a safe, immutable ordering key. The tie-break only needs to be
 * deterministic and repeatable, not chronologically meaningful — a random
 * UUID compared lexicographically satisfies that.
 */
export function latestExactDayRun(runs: SalesRunRecord[], targetDate: string): SalesRunRecord | null {
  const exactDayRuns = runs.filter(r => isExactDayRun(r, targetDate))
  if (exactDayRuns.length === 0) return null
  return [...exactDayRuns].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1
    return a.id < b.id ? 1 : -1
  })[0]
}

/**
 * The locked invariant: a date is Sales-confirmed only when (1) an exact-
 * day attempt exists for it at all, AND (2) the LATEST such attempt has
 * status 'success' and rows_rejected = 0. An older exact-day success is
 * superseded the instant a newer exact-day attempt begins — there is no
 * fallback to it while the newer attempt is running, failed, or
 * partial_success, and no fallback to it ever again if the newer attempt
 * fails outright (a still-newer attempt must itself succeed).
 */
export function isSalesDayConfirmed(runs: SalesRunRecord[], targetDate: string): boolean {
  const latest = latestExactDayRun(runs, targetDate)
  if (!latest) return false
  return latest.status === 'success' && latest.rowsRejected === 0
}

/**
 * Deliberately UNCHANGED semantics from migration 065: "was there ANY
 * attempt at all covering this date" still counts a multi-day run as a
 * real attempt (that is a true fact about history) — it just no longer
 * counts as CONFIRMING the date (see isSalesDayConfirmed above). This is
 * what makes a historical date covered only by old multi-day runs
 * classify as source_not_complete rather than unknown.
 */
export function hasAnyCoveringRun(runs: SalesRunRecord[], targetDate: string): boolean {
  return runs.some(r => r.dateFrom <= targetDate && r.dateTo >= targetDate)
}
