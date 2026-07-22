/**
 * GET/PUT /api/pincode-monitoring/default-pincodes
 *
 * PRODUCT_SPEC.md sec5.3/sec11: workspace default-pincode management. PUT
 * replaces the full active default list for (workspace, marketplace) in
 * one call -- add/remove/reorder are all expressed as "here is the new
 * complete list," matching sec5.3's "add one, remove one, bulk-paste" UX as
 * one idempotent write rather than three separate mutation endpoints.
 * Saving defaults never retroactively changes an existing enrollment's own
 * pincode list (sec5.3 item 3) -- this route only ever touches
 * `workspace_default_pincodes`, never `pincode_tracking_targets`.
 */
import { NextRequest } from 'next/server'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { jsonError, jsonOk, internalError, mapReplaceDefaultsResult } from '@/lib/pincode-monitoring/responses'
import { fetchActiveDefaults, replaceActiveDefaults } from '@/lib/pincode-monitoring/defaults'
import { isValidMarketplaceId, isValidPincode, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspaceId')
  const marketplaceId = request.nextUrl.searchParams.get('marketplaceId')
  if (!workspaceId || !isValidMarketplaceId(marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId query parameters are required.')
  }

  const access = await resolvePincodeAccess({ workspaceId, marketplaceId, requireWriteRole: false })
  if (!access.ok) return access.response

  try {
    const defaults = await fetchActiveDefaults(access.context.workspaceId, access.context.marketplaceId)
    return jsonOk({ defaults })
  } catch (error) {
    return internalError('defaults_fetch_failed', error)
  }
}

interface RequestPincode {
  pincode?: unknown
  displayOrder?: unknown
}

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  pincodes?: unknown
}

const MAX_DEFAULT_PINCODES = 200 // generous bound above PRODUCT_SPEC.md sec5.3's P1 confirmation-threshold discussion (20) -- this is a hard request-size ceiling, not the UX confirmation threshold
const MIN_DISPLAY_ORDER = 0
const MAX_DISPLAY_ORDER = 100_000 // Correction 7 (PR #55 review round): displayOrder must be bounded, not merely "an integer"

export async function PUT(request: NextRequest) {
  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId) || !Array.isArray(body.pincodes)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId, marketplaceId, and a pincodes array are required.')
  }
  if (body.pincodes.length > MAX_DEFAULT_PINCODES) {
    return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_DEFAULT_PINCODES} default pincodes is supported per request.`)
  }

  const seen = new Set<string>()
  const pincodes: { pincode: string; displayOrder: number }[] = []
  for (const raw of body.pincodes as RequestPincode[]) {
    if (
      !isValidPincode(raw?.pincode) ||
      typeof raw?.displayOrder !== 'number' ||
      !Number.isInteger(raw.displayOrder) ||
      raw.displayOrder < MIN_DISPLAY_ORDER ||
      raw.displayOrder > MAX_DISPLAY_ORDER
    ) {
      return jsonError(400, 'invalid_parameters', `Each entry requires a valid 6-digit pincode and an integer displayOrder between ${MIN_DISPLAY_ORDER} and ${MAX_DISPLAY_ORDER}.`, { pincode: raw?.pincode })
    }
    if (seen.has(raw.pincode)) {
      return jsonError(400, 'invalid_parameters', 'Duplicate pincode in request.', { pincode: raw.pincode })
    }
    seen.add(raw.pincode)
    pincodes.push({ pincode: raw.pincode, displayOrder: raw.displayOrder })
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  try {
    const result = await replaceActiveDefaults(access.context.workspaceId, access.context.marketplaceId, pincodes)
    if (!result.ok) return mapReplaceDefaultsResult(result.rpcResult)
    return jsonOk({ defaults: result.defaults })
  } catch (error) {
    return internalError('defaults_replace_failed', error)
  }
}
