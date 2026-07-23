/**
 * SKU Performance P1-B — summary data-access.
 *
 * Thin real-I/O wrapper around `rpc.ts`'s `getSkuPerformanceSummary`: calls
 * the admin (service-role) client, then merges in the source-health
 * classification (`salesSourceState`/`adsSourceState`/`catalogSourceState`
 * and the row-level `dataDelayed` flag) that the RPC deliberately does not
 * compute itself — see `source-health.ts`'s header comment for why.
 *
 * Fix 6 (P1-B correction round): `dataDelayed` (and the per-source states
 * it is derived from) is now computed from `salesLatestAcceptedCompleteDate`
 * / `adsLatestAcceptedCompleteDate` — an ACCEPTED (status='success',
 * rows_rejected=0) refresh run's date_to — never from the plain "latest
 * row seen" date (`salesLatestDataDate`/`adsLatestDataDate`), which can
 * exist even when every run covering it failed or rejected rows.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getSkuPerformanceSummary as callSummaryRpc, type GetSummaryArgs } from './rpc'
import { classifySourceHealth } from './source-health'
import type { SkuPerformanceSummaryResult } from './types'

export async function fetchSkuPerformanceSummary(args: GetSummaryArgs): Promise<SkuPerformanceSummaryResult> {
  const admin = createAdminClient()
  const result = await callSummaryRpc(admin, args)

  if (result.result !== 'success') {
    return result
  }

  const salesSourceState = classifySourceHealth({
    latestAcceptedCompleteDate: result.summary.salesLatestAcceptedCompleteDate,
    lastRunStatus: result.summary.salesLastRunStatus,
    lastRunAt: result.summary.salesLastRunAt,
    lastRunRowsRejected: result.summary.salesLastRunRowsRejected,
  })
  const adsSourceState = classifySourceHealth({
    latestAcceptedCompleteDate: result.summary.adsLatestAcceptedCompleteDate,
    lastRunStatus: result.summary.adsLastRunStatus,
    lastRunAt: result.summary.adsLastRunAt,
    lastRunRowsRejected: result.summary.adsLastRunRowsRejected,
  })
  const catalogSourceState = classifySourceHealth({
    latestAcceptedCompleteDate: result.summary.catalogLastSyncedAt,
    lastRunStatus: null,
    lastRunAt: null,
    lastRunRowsRejected: null,
  })

  // Product Spec sec6.4#7: "Data delayed" is a source-level fact, never a
  // per-SKU fact derived from row absence — the same value is merged into
  // every row's flags, never independently re-derived per row. Fix 6: this
  // now reflects ACCEPTED-complete coverage (via salesSourceState/
  // adsSourceState above), not merely the presence of a recent row.
  const dataDelayed = salesSourceState !== 'healthy' || adsSourceState !== 'healthy'

  return {
    ...result,
    summary: { ...result.summary, salesSourceState, adsSourceState, catalogSourceState },
    rows: result.rows.map((row) => ({ ...row, flags: { ...row.flags, dataDelayed } })),
  }
}
