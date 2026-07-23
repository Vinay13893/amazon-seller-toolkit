/**
 * SKU Performance P1-B — narrow, typed, hardcoded-name RPC wrappers.
 *
 * Mirrors `esolz-app/src/lib/pincode-monitoring/rpc.ts`'s convention: exactly
 * the two Postgres RPCs this feature is allowed to call, never a generic
 * `.rpc(name, params)` passthrough. Both RPCs are called only through the
 * admin (service-role) client — see the route handlers.
 */
import type { SkuPerformanceDailyResult, SkuPerformanceSummaryResult } from './types'
import type { SortValue } from './validation'

export interface RpcClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export class SkuPerformanceRpcTransportError extends Error {
  rpcName: string
  cause: unknown
  constructor(rpcName: string, cause: unknown) {
    super(`RPC ${rpcName} failed`)
    this.name = 'SkuPerformanceRpcTransportError'
    this.rpcName = rpcName
    this.cause = cause
  }
}

export interface SummaryFilters {
  skuFilter: string | null
  asinFilter: string | null
  categoryFilter: string | null
  brandFilter: string | null
  growingOnly: boolean
  decliningOnly: boolean
  spendSpikeOnly: boolean
  noAttributedSalesOnly: boolean
  highTacosOnly: boolean
  unmappedOnly: boolean
  identityConflictOnly: boolean
  sort: SortValue
}

export interface GetSummaryArgs {
  workspaceId: string
  marketplaceId: string
  dateFrom: string
  dateTo: string
  asOf: string
  limit: number
  offset: number
  filters: SummaryFilters
}

export async function getSkuPerformanceSummary(client: RpcClient, args: GetSummaryArgs): Promise<SkuPerformanceSummaryResult> {
  const { data, error } = await client.rpc('get_sku_performance_summary', {
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_date_from: args.dateFrom,
    p_date_to: args.dateTo,
    p_as_of: args.asOf,
    p_limit: args.limit,
    p_offset: args.offset,
    p_sku_filter: args.filters.skuFilter,
    p_asin_filter: args.filters.asinFilter,
    p_category_filter: args.filters.categoryFilter,
    p_brand_filter: args.filters.brandFilter,
    p_growing_only: args.filters.growingOnly,
    p_declining_only: args.filters.decliningOnly,
    p_spend_spike_only: args.filters.spendSpikeOnly,
    p_no_attributed_sales_only: args.filters.noAttributedSalesOnly,
    p_high_tacos_only: args.filters.highTacosOnly,
    p_unmapped_only: args.filters.unmappedOnly,
    p_identity_conflict_only: args.filters.identityConflictOnly,
    p_sort: args.filters.sort,
  })
  if (error) throw new SkuPerformanceRpcTransportError('get_sku_performance_summary', error)
  return data as SkuPerformanceSummaryResult
}

export interface GetDailyArgs {
  workspaceId: string
  marketplaceId: string
  sku: string
  dateFrom: string
  dateTo: string
}

export async function getSkuPerformanceDaily(client: RpcClient, args: GetDailyArgs): Promise<SkuPerformanceDailyResult> {
  const { data, error } = await client.rpc('get_sku_performance_daily', {
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_sku: args.sku,
    p_date_from: args.dateFrom,
    p_date_to: args.dateTo,
  })
  if (error) throw new SkuPerformanceRpcTransportError('get_sku_performance_daily', error)
  return data as SkuPerformanceDailyResult
}
