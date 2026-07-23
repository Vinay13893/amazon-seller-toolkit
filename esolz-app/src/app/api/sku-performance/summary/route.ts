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
 *
 * Fix 5 (P1-B correction round): limit/offset/boolean-flag parsing is now
 * strict (see validation.ts) — a malformed value is rejected with a 400,
 * never silently clamped or defaulted to something the caller didn't ask
 * for. A hard ceiling on the selected date range is also enforced here
 * (mirroring the same ceiling in the SQL RPC, for a consistent error before
 * the RPC round-trip).
 */
import { NextRequest } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { fetchSkuPerformanceSummary } from '@/lib/sku-performance/summary'
import { jsonError, jsonOk, internalError, mapInvalidParameters } from '@/lib/sku-performance/responses'
import {
  isValidMarketplaceId, isValidDateString, isValidSort, isValidFilterString,
  validateLimit, validateOffset, optionalFilter, validateBooleanFlag, MAX_SUMMARY_RANGE_DAYS,
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
  if (dateFrom > dateTo) {
    return jsonError(400, 'invalid_parameters', 'dateFrom must not be after dateTo.')
  }
  const rangeDays = (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (24 * 60 * 60 * 1000)
  if (rangeDays > MAX_SUMMARY_RANGE_DAYS) {
    return jsonError(400, 'invalid_parameters', `Date range must not exceed ${MAX_SUMMARY_RANGE_DAYS} days.`)
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

  const limitResult = validateLimit(params.get('limit'))
  if (!limitResult.ok) {
    return jsonError(400, 'invalid_parameters', 'limit query parameter must be a whole number in range.')
  }
  const offsetResult = validateOffset(params.get('offset'))
  if (!offsetResult.ok) {
    return jsonError(400, 'invalid_parameters', 'offset query parameter must be a non-negative whole number.')
  }

  const booleanFlagParams = [
    'growingOnly', 'decliningOnly', 'spendSpikeOnly', 'noAttributedSalesOnly',
    'highTacosOnly', 'unmappedOnly', 'identityConflictOnly',
  ] as const
  const booleanFlags: Record<(typeof booleanFlagParams)[number], boolean> = {
    growingOnly: false, decliningOnly: false, spendSpikeOnly: false, noAttributedSalesOnly: false,
    highTacosOnly: false, unmappedOnly: false, identityConflictOnly: false,
  }
  for (const name of booleanFlagParams) {
    const result = validateBooleanFlag(params.get(name))
    if (!result.ok) {
      return jsonError(400, 'invalid_parameters', `${name} query parameter must be true, false, 1, or 0.`)
    }
    booleanFlags[name] = result.value
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
      limit: limitResult.value,
      offset: offsetResult.value,
      filters: {
        skuFilter: optionalFilter(params.get('skuFilter')),
        asinFilter: optionalFilter(params.get('asinFilter')),
        categoryFilter: optionalFilter(params.get('categoryFilter')),
        brandFilter: optionalFilter(params.get('brandFilter')),
        growingOnly: booleanFlags.growingOnly,
        decliningOnly: booleanFlags.decliningOnly,
        spendSpikeOnly: booleanFlags.spendSpikeOnly,
        noAttributedSalesOnly: booleanFlags.noAttributedSalesOnly,
        highTacosOnly: booleanFlags.highTacosOnly,
        unmappedOnly: booleanFlags.unmappedOnly,
        identityConflictOnly: booleanFlags.identityConflictOnly,
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
