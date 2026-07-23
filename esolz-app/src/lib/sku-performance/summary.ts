/**
 * SKU Performance P1-B — summary data-access.
 *
 * Thin real-I/O wrapper around `rpc.ts`'s `getSkuPerformanceSummary`: calls
 * the admin (service-role) client, then merges in the source-health
 * classification (`salesSourceState`/`adsSourceState`/`catalogSourceState`
 * and the row-level `dataDelayed` flag) that the RPC deliberately does not
 * compute itself — see `source-health.ts`'s header comment for why.
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
    latestCompleteDate: result.summary.salesSourceLatestCompleteDate,
    lastRunStatus: result.summary.salesLastRunStatus,
    lastRunAt: result.summary.salesLastRunAt,
  })
  const adsSourceState = classifySourceHealth({
    latestCompleteDate: result.summary.adsSourceLatestCompleteDate,
    lastRunStatus: result.summary.adsLastRunStatus,
    lastRunAt: result.summary.adsLastRunAt,
  })
  const catalogSourceState = classifySourceHealth({
    latestCompleteDate: result.summary.catalogLastSyncedAt,
    lastRunStatus: null,
    lastRunAt: null,
  })

  // Product Spec sec6.4#7: "Data delayed" is a source-level fact, never a
  // per-SKU fact derived from row absence — the same value is merged into
  // every row's flags, never independently re-derived per row.
  const dataDelayed = salesSourceState !== 'healthy' || adsSourceState !== 'healthy'

  return {
    ...result,
    summary: { ...result.summary, salesSourceState, adsSourceState, catalogSourceState },
    rows: result.rows.map((row) => ({ ...row, flags: { ...row.flags, dataDelayed } })),
  }
}
