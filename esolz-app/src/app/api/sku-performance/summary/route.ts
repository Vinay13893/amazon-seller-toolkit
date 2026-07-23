/**
 * GET /api/sku-performance/summary
 *
 * SKU_DAILY_SALES_SPEND_IMPLEMENTATION_PLAN.md sec5: calls
 * `get_sku_performance_summary` (paginated, filtered, sorted, already
 * flagged — Correction 6, this route never computes a flag or re-sorts a
 * page itself). Auth: `getInternalAccessContext()`, the same gate as
 * `/api/internal/brahmastra-data-health` — not a new access-control module.
 *
 * `workspaceId` is never accepted as a query parameter — it comes only
 * from the authorized access context, so a caller can never request another
 * workspace's data by supplying an arbitrary id.
 */
import { NextRequest } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { fetchSkuPerformanceSummary } from '@/lib/sku-performance/summary'
import { jsonError, jsonOk, internalError, mapInvalidParameters } from '@/lib/sku-performance/responses'
import {
  isValidMarketplaceId, isValidDateString, isValidSort, isValidFilterString,
  clampLimit, clampOffset, optionalFilter, parseBooleanFlag,
} from '@/lib/sku-performance/validation'
import { SkuPerformanceRpcTransportError } from '@/lib/sku-performance/rpc'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  const marketplaceId = params.get('marketplaceId')
  if (!isValidMarketplaceId(marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'marketplaceId query parameter is required.')
  }

  const dateFrom = params.get('dateFrom')
  const dateTo = params.get('dateTo')
  if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) {
    return jsonError(400, 'invalid_parameters', 'dateFrom and dateTo query parameters (YYYY-MM-DD) are required.')
  }

  const asOf = params.get('asOf')
  if (!isValidDateString(asOf)) {
    return jsonError(400, 'invalid_parameters', 'asOf query parameter (YYYY-MM-DD) is required.')
  }

  const sortParam = params.get('sort') ?? 'attention_desc'
  if (!isValidSort(sortParam)) {
    return jsonError(400, 'invalid_parameters', 'sort query parameter is not a supported value.')
  }

  for (const [name, value] of [
    ['skuFilter', params.get('skuFilter')],
    ['asinFilter', params.get('asinFilter')],
    ['categoryFilter', params.get('categoryFilter')],
    ['brandFilter', params.get('brandFilter')],
  ] as const) {
    if (value !== null && !isValidFilterString(value)) {
      return jsonError(400, 'invalid_parameters', `${name} query parameter is too long.`)
    }
  }

  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return jsonError(401, 'unauthorized', 'Unauthorized')
  }

  try {
    const result = await fetchSkuPerformanceSummary({
      workspaceId: access.workspaceId,
      marketplaceId,
      dateFrom,
      dateTo,
      asOf,
      limit: clampLimit(params.get('limit')),
      offset: clampOffset(params.get('offset')),
      filters: {
        skuFilter: optionalFilter(params.get('skuFilter')),
        asinFilter: optionalFilter(params.get('asinFilter')),
        categoryFilter: optionalFilter(params.get('categoryFilter')),
        brandFilter: optionalFilter(params.get('brandFilter')),
        growingOnly: parseBooleanFlag(params.get('growingOnly')),
        decliningOnly: parseBooleanFlag(params.get('decliningOnly')),
        spendSpikeOnly: parseBooleanFlag(params.get('spendSpikeOnly')),
        noAttributedSalesOnly: parseBooleanFlag(params.get('noAttributedSalesOnly')),
        highTacosOnly: parseBooleanFlag(params.get('highTacosOnly')),
        unmappedOnly: parseBooleanFlag(params.get('unmappedOnly')),
        identityConflictOnly: parseBooleanFlag(params.get('identityConflictOnly')),
        sort: sortParam,
      },
    })

    if (result.result === 'invalid_parameters') {
      return mapInvalidParameters(result)
    }
    if (result.result === 'currency_mismatch') {
      return jsonError(409, 'currency_mismatch', 'The requested scope spans more than one currency and cannot be safely summed.')
    }
    return jsonOk(result)
  } catch (error) {
    if (error instanceof SkuPerformanceRpcTransportError) {
      return internalError('summary_rpc_failed', error.cause)
    }
    return internalError('summary_fetch_failed', error)
  }
}
