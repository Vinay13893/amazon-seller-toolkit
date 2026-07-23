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
 * `get_sku_performance_summary` already returns (latest complete date,
 * most recent refresh-run status/timestamp), nothing more.
 *
 * Known, intentional scope limitation (recorded, not silently assumed):
 * this classifier never returns `auth_required` or `rate_limited` — both
 * require inspecting the underlying Amazon connection's own error code,
 * which is outside a `internal_data_refresh_runs` row. It only
 * distinguishes `not_configured` / `failed` / `stale` / `healthy`.
 */
import type { SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

const STALE_THRESHOLD_DAYS = 3

export interface SourceHealthInput {
  /** Either a plain date ('YYYY-MM-DD') or a full ISO timestamp — both parse correctly via `new Date(...)`. */
  latestCompleteDate: string | null
  lastRunStatus: string | null
  lastRunAt: string | null
}

export function classifySourceHealth(input: SourceHealthInput, nowIso: string = new Date().toISOString()): SourceHealthStatus {
  if (input.latestCompleteDate === null && input.lastRunStatus === null) {
    return 'not_configured'
  }
  if (input.lastRunStatus === 'failed') {
    return 'failed'
  }
  if (input.latestCompleteDate === null) {
    return 'stale'
  }
  const latest = new Date(input.latestCompleteDate).getTime()
  const now = new Date(nowIso).getTime()
  const ageDays = (now - latest) / (24 * 60 * 60 * 1000)
  if (Number.isNaN(ageDays) || ageDays > STALE_THRESHOLD_DAYS) {
    return 'stale'
  }
  return 'healthy'
}
