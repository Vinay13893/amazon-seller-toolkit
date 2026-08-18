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
  /** Set once at insert time, default `now()`, same immutability guarantee as startedAt — see latestExactDayRun's doc comment for why this is a tie-break, not the primary key. */
  createdAt: string
}

/** A multi-day run is never eligible to certify a SKU-day, full stop — this is the entire gate. */
export function isExactDayRun(run: SalesRunRecord, targetDate: string): boolean {
  return run.dateFrom === targetDate && run.dateTo === targetDate
}

/**
 * The single latest exact-day attempt for `targetDate`, or null if none
 * exists. Ordered `startedAt DESC, createdAt DESC, id DESC` (mirrors the
 * SQL exactly — see migration 066's `_sku_perf_sales_day_confirmed` header
 * comment for the full rationale, checked against the actual schema and
 * every INSERT call site rather than assumed):
 *   1. startedAt (primary) — immutable, insert-time-defaulted, the same
 *      column every other "most recent run" query in this codebase
 *      already orders by.
 *   2. createdAt (secondary tie-break) — same immutability guarantee as
 *      startedAt. In this codebase's actual write paths neither column is
 *      ever explicitly overridden, so both default to the identical
 *      `now()` for every row that exists today — this tie-break is a
 *      genuine no-op right now, kept as defense-in-depth for a future
 *      write path that might legitimately set startedAt to something
 *      other than true insertion time.
 *   3. id (final tie-break) — a random UUID, not chronological; exists
 *      only to guarantee one deterministic, repeatable answer for the
 *      vanishingly-rare case where startedAt AND createdAt are both
 *      exactly equal. An exact-timestamp tie at steps 1-2 cannot itself
 *      produce a WRONG authority choice (both candidates are equally
 *      "latest" by every real signal available) — id DESC just picks one
 *      of them consistently instead of depending on undefined order.
 * `finished_at` is deliberately never used — a currently-running attempt
 * has none yet.
 */
export function latestExactDayRun(runs: SalesRunRecord[], targetDate: string): SalesRunRecord | null {
  const exactDayRuns = runs.filter(r => isExactDayRun(r, targetDate))
  if (exactDayRuns.length === 0) return null
  return [...exactDayRuns].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
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

export type SalesDayCoverageState = 'BEFORE_HISTORY' | 'SOURCE_NOT_COMPLETE' | 'UNKNOWN' | 'REPORTED_VALUE' | 'CONFIRMED_ZERO'
export type SalesDayCoverageResult = { state: SalesDayCoverageState; value: number | null }

/**
 * Mirrors `get_sku_performance_daily`'s CORRECTED `daily_states` CASE
 * ordering (migration 066, amended round). This exact ordering is the fix
 * for the daily raw-value-leak defect: the FIRST version of this
 * migration checked `rawValue !== null -> REPORTED_VALUE` BEFORE checking
 * authority at all, so a physically-present row (an old corrupted row, or
 * the correct+stale mix a crash between upsert and stale-delete leaves
 * behind) still surfaced as REPORTED_VALUE regardless of whether the
 * exact-day authoritative run actually confirmed that date.
 *
 * Order now matches the locked invariant exactly:
 *   A. before history                       -> BEFORE_HISTORY,       null
 *   B. not authoritative, some run covers it -> SOURCE_NOT_COMPLETE, null
 *   C. not authoritative, no run at all      -> UNKNOWN,              null
 *   D. authoritative, raw row exists         -> REPORTED_VALUE,       rawValue
 *   E. authoritative, no raw row             -> CONFIRMED_ZERO,       0
 * A raw value is NEVER read/exposed unless the exact-day authoritative
 * run for that date actually succeeded (B and C both return null
 * regardless of `rawValue` — the whole point of this fix).
 */
export function classifySalesDayCoverage(input: {
  runs: SalesRunRecord[]
  targetDate: string
  isBeforeHistory: boolean
  /** The stored row's value for this exact SKU + date, or null if no row exists. */
  rawValue: number | null
}): SalesDayCoverageResult {
  if (input.isBeforeHistory) return { state: 'BEFORE_HISTORY', value: null }
  if (!isSalesDayConfirmed(input.runs, input.targetDate)) {
    return { state: hasAnyCoveringRun(input.runs, input.targetDate) ? 'SOURCE_NOT_COMPLETE' : 'UNKNOWN', value: null }
  }
  return input.rawValue !== null ? { state: 'REPORTED_VALUE', value: input.rawValue } : { state: 'CONFIRMED_ZERO', value: 0 }
}

/**
 * Mirrors the new `get_sku_performance_sales_freshness_date` SQL function
 * (migration 066, third amended round) — the narrow freshness-badge fix.
 * The MAX date among every distinct exact-day date on file whose LATEST
 * attempt is authoritatively confirmed (isSalesDayConfirmed), or null if
 * none ever was. This is what `summary.ts` uses to override the legacy
 * `salesLatestAcceptedCompleteDate` field before it reaches
 * `classifySourceHealth` — closing the "badge says healthy while the
 * per-value gate says source_not_complete" contradiction, because
 * `classifySourceHealth` already treats a null accepted-complete date as
 * 'stale' unconditionally (see source-health.ts), before ever consulting
 * the still-unfixed lastRunStatus fields.
 */
export function latestSalesAuthoritativeCompleteDate(runs: SalesRunRecord[]): string | null {
  const exactDayDates = [...new Set(runs.filter(r => r.dateFrom === r.dateTo).map(r => r.dateFrom))]
  const confirmedDates = exactDayDates.filter(d => isSalesDayConfirmed(runs, d))
  if (confirmedDates.length === 0) return null
  return confirmedDates.sort().at(-1) as string
}
