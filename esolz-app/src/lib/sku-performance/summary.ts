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
 *
 * Sales coverage-trust follow-up (migration 066): `get_sku_performance_summary`'s
 * own `salesLatestAcceptedCompleteDate` is computed from ANY successful
 * run (no exact-day scope) — the same category of defect the coverage-
 * trust fix closed for salesCoverageState, just not yet closed at the
 * source (redefining that ~900-line function was judged too risky to do
 * blind, with no live Postgres available to verify it — see migration
 * 066's header). Closed here instead, narrowly, at the API layer: a
 * second, small RPC (`get_sku_performance_sales_freshness_date`) computes
 * the authoritative-run-only date, and its result OVERRIDES the legacy
 * field before classifySourceHealth ever sees it — so the freshness badge
 * and the per-value salesCoverageState gate can never disagree. Ads
 * freshness is untouched (Ads never had this bug).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getSkuPerformanceSummary as callSummaryRpc, getSkuPerformanceSalesFreshnessDate, type GetSummaryArgs } from './rpc'
import { classifySourceHealth } from './source-health'
import type { SkuPerformanceSummaryResult } from './types'

export async function fetchSkuPerformanceSummary(args: GetSummaryArgs): Promise<SkuPerformanceSummaryResult> {
  const admin = createAdminClient()
  const result = await callSummaryRpc(admin, args)

  if (result.result !== 'success') {
    return result
  }

  // Narrow override: never trust the legacy salesLatestAcceptedCompleteDate
  // (any successful run, no exact-day scope) for the health badge -- only
  // the authoritative-run-only date from the dedicated RPC. A transport
  // failure on this SECOND call must not silently fall back to the
  // untrustworthy legacy value either -- it propagates like any other RPC
  // failure (SkuPerformanceRpcTransportError), rather than risking a
  // healthy-looking badge built on unverified data.
  const authoritativeSalesFreshnessDate = await getSkuPerformanceSalesFreshnessDate(admin, {
    workspaceId: args.workspaceId,
    marketplaceId: args.marketplaceId,
  })
  result.summary.salesLatestAcceptedCompleteDate = authoritativeSalesFreshnessDate

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
