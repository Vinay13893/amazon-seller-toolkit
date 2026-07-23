/**
 * SKU Performance P1-B — source-health classification.
 *
 * Reuses the SourceHealthStatus vocabulary already established by
 * `esolz-app/src/lib/internal/brahmastra-data-health.ts` (type import
 * only — that module's real classifier, `evaluateSyncedSource`, is a
 * private, non-exported helper tightly coupled to connection/OAuth-error
 * inspection this feature has no access to). Duplicating a second full
 * copy of that connection-aware logic here would be exactly the kind of
 * reinvention the Product Spec says to avoid, so this classifier is
 * deliberately narrower: it derives a status from the raw facts
 * `get_sku_performance_summary` already returns (latest ACCEPTED complete
 * date, most recent refresh-run status/timestamp/rows-rejected), nothing
 * more.
 *
 * Known, intentional scope limitation (recorded, not silently assumed):
 * this classifier never returns `auth_required` or `rate_limited` — both
 * require inspecting the underlying Amazon connection's own error code,
 * which is outside a `internal_data_refresh_runs` row. It only
 * distinguishes `not_configured` / `failed` / `stale` / `healthy`.
 *
 * Fix 6 (P1-B correction round): freshness is now judged against
 * `latestAcceptedCompleteDate` (an ACCEPTED — status='success',
 * rows_rejected=0 — run's date_to), never the plain "latest row seen"
 * date, and every run status is mapped conservatively so partial data is
 * never reported as healthy:
 *   - failed                       -> failed
 *   - partial_success               -> stale (an attempt happened but did
 *                                      not fully succeed; there is no
 *                                      dedicated "incomplete" state in the
 *                                      existing SourceHealthStatus
 *                                      vocabulary, so this maps to the
 *                                      closest existing one, stale)
 *   - running                       -> stale (no "in_progress" state
 *                                      exists in the existing vocabulary
 *                                      either; a run in flight is not yet
 *                                      trustworthy, so it is never healthy)
 *   - skipped                       -> stale, unless the accepted-complete
 *                                      date is itself fresh (skipped only
 *                                      means "nothing to do because
 *                                      already current" when there is
 *                                      recent accepted evidence backing
 *                                      that claim)
 *   - success with rows_rejected>0  -> stale (accepted date exists, but
 *                                      the run itself was not fully clean)
 *   - success, accepted, current    -> healthy
 */
import type { SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

const STALE_THRESHOLD_DAYS = 3

export interface SourceHealthInput {
  /** The latest ACCEPTED-complete date (status='success', rows_rejected=0) — never the plain "latest row seen" date. Either a plain date ('YYYY-MM-DD') or a full ISO timestamp — both parse correctly via `new Date(...)`. */
  latestAcceptedCompleteDate: string | null
  lastRunStatus: string | null
  lastRunAt: string | null
  lastRunRowsRejected: number | null
}

function isFresh(dateStr: string, nowIso: string): boolean {
  const latest = new Date(dateStr).getTime()
  const now = new Date(nowIso).getTime()
  const ageDays = (now - latest) / (24 * 60 * 60 * 1000)
  return !Number.isNaN(ageDays) && ageDays <= STALE_THRESHOLD_DAYS
}

export function classifySourceHealth(input: SourceHealthInput, nowIso: string = new Date().toISOString()): SourceHealthStatus {
  if (input.latestAcceptedCompleteDate === null && input.lastRunStatus === null) {
    return 'not_configured'
  }
  if (input.lastRunStatus === 'failed') {
    return 'failed'
  }
  if (input.lastRunStatus === 'running') {
    return 'stale'
  }
  if (input.lastRunStatus === 'partial_success') {
    return 'stale'
  }
  if (input.latestAcceptedCompleteDate === null) {
    return 'stale'
  }
  if (!isFresh(input.latestAcceptedCompleteDate, nowIso)) {
    return 'stale'
  }
  // A success run that rejected rows never counts as fully healthy, even
  // when the accepted-complete date itself is fresh (a fresh accepted date
  // can only come from a DIFFERENT, earlier fully-clean run in this case).
  if (input.lastRunStatus === 'success' && (input.lastRunRowsRejected ?? 0) > 0) {
    return 'stale'
  }
  // 'skipped' (and any other non-failure status) with a fresh accepted-
  // complete date and no rejected rows is treated as healthy: skipped only
  // means "nothing to do because already current," which is only
  // trustworthy when there is fresh accepted evidence backing that claim.
  return 'healthy'
}
