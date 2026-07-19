/**
 * GET /api/pincode-monitoring/tracker
 *
 * PRODUCT_SPEC.md sec5.4/sec11: paginated, product-row + nested
 * pincode-row tracker data. `view` selects the lifecycle filter -- 'active'
 * is the standing tracking view (parent lifecycle active; the derived
 * Paused/Failed/Partially-active/Active labels are computed per-row and
 * returned as `trackerState`), 'archived' and 'removed' are the two
 * separate, never-conflated filters PRODUCT_SPEC.md sec7 requires.
 */
import { NextRequest } from 'next/server'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { jsonError, jsonOk } from '@/lib/pincode-monitoring/responses'
import { fetchTrackerPage, type TrackerView } from '@/lib/pincode-monitoring/tracker'
import { isValidMarketplaceId } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const VALID_VIEWS: TrackerView[] = ['active', 'archived', 'removed']

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const workspaceId = params.get('workspaceId')
  const marketplaceId = params.get('marketplaceId')
  if (!workspaceId || !isValidMarketplaceId(marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId query parameters are required.')
  }

  const viewParam = params.get('view') ?? 'active'
  if (!VALID_VIEWS.includes(viewParam as TrackerView)) {
    return jsonError(400, 'invalid_parameters', 'view must be one of: active, archived, removed.')
  }
  const view = viewParam as TrackerView

  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
  const requestedLimit = Number.parseInt(params.get('limit') ?? '', 10)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit || DEFAULT_PAGE_SIZE))

  const access = await resolvePincodeAccess({ workspaceId, marketplaceId, requireWriteRole: false })
  if (!access.ok) return access.response

  const page = await fetchTrackerPage({
    workspaceId: access.context.workspaceId,
    marketplaceId: access.context.marketplaceId,
    view,
    offset,
    limit,
  })

  return jsonOk({ ...page, view })
}
