/**
 * GET /api/sku-performance/[sku]/daily
 *
 * SKU_DAILY_SALES_SPEND_IMPLEMENTATION_PLAN.md sec5: calls
 * `get_sku_performance_daily`, one SKU, bounded range. Same auth gate as
 * the summary route; `workspaceId` is never accepted as a query parameter.
 *
 * Fix 5 (P1-B correction round): Next.js already URL-decodes dynamic route
 * segments before `params` resolves — this route used to run that decode a
 * second time on top of it, double-decoding the value. A literal SKU
 * containing a `%` (e.g. one ending in a two-hex-digit sequence) would
 * either mis-decode silently or throw an uncaught `URIError` for a segment
 * that was never actually percent-encoded twice. The resolved `sku` is
 * used as-is now, with no further decode step.
 */
import { NextRequest } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { fetchSkuPerformanceDaily } from '@/lib/sku-performance/daily'
import { jsonError, jsonOk, internalError, mapInvalidParameters } from '@/lib/sku-performance/responses'
import { isValidMarketplaceId, isValidDateString, isValidSkuString, MAX_DAILY_RANGE_DAYS, isRangeWithinInclusiveDays } from '@/lib/sku-performance/validation'
import { SkuPerformanceRpcTransportError } from '@/lib/sku-performance/rpc'

export const runtime = 'nodejs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ sku: string }> }) {
  const { sku } = await params
  if (!isValidSkuString(sku)) {
    return jsonError(400, 'invalid_parameters', 'A valid sku path segment is required.')
  }

  const searchParams = request.nextUrl.searchParams
  const marketplaceId = searchParams.get('marketplaceId')
  if (!isValidMarketplaceId(marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'marketplaceId query parameter is required.')
  }

  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) {
    return jsonError(400, 'invalid_parameters', 'dateFrom and dateTo query parameters (YYYY-MM-DD) are required.')
  }
  if (dateFrom > dateTo) {
    return jsonError(400, 'invalid_parameters', 'dateFrom must not be after dateTo.')
  }
  if (!isRangeWithinInclusiveDays(dateFrom, dateTo, MAX_DAILY_RANGE_DAYS)) {
    return jsonError(400, 'invalid_parameters', `Date range must not exceed ${MAX_DAILY_RANGE_DAYS} inclusive days.`)
  }

  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return jsonError(401, 'unauthorized', 'Unauthorized')
  }

  try {
    const result = await fetchSkuPerformanceDaily({
      workspaceId: access.workspaceId,
      marketplaceId,
      sku,
      dateFrom,
      dateTo,
    })

    if (result.result === 'invalid_parameters') {
      return mapInvalidParameters(result)
    }
    return jsonOk(result)
  } catch (error) {
    if (error instanceof SkuPerformanceRpcTransportError) {
      return internalError('daily_rpc_failed', error.cause)
    }
    return internalError('daily_fetch_failed', error)
  }
}
