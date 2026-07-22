/**
 * PATCH /api/pincode-monitoring/products/[id]/pincodes
 *
 * Correction 2 (PR #55 review round): the "Edit Pincodes" route from the
 * locked route map (PRODUCT_SPEC.md sec11) -- was missing entirely. Whole-
 * list replacement for the URL product's configured pincodes, via
 * `replace_pincode_product_targets`. An empty list is rejected outright
 * (P0 decision, recorded in DATA_MODEL.md): use `PATCH .../remove` to
 * remove the entire product instead.
 */
import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { getPincodeMonitoringConfig } from '@/lib/pincode-monitoring/config'
import { jsonError, mapReplaceProductTargetsResult, type ReplaceProductTargetsRpcResult } from '@/lib/pincode-monitoring/responses'
import { replaceProductTargets, PincodeRpcTransportError } from '@/lib/pincode-monitoring/rpc'
import { isValidMarketplaceId, isValidUuid, normalizePincodeList, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

const MAX_PINCODES = 100

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  pincodes?: unknown
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUuid(id)) {
    return jsonError(400, 'invalid_parameters', 'The product ID in the URL is not a valid UUID.')
  }

  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId are required.')
  }
  const pincodes = normalizePincodeList(body.pincodes)
  if (!pincodes) {
    return jsonError(400, 'invalid_parameters', 'pincodes must be a non-empty array of valid 6-digit pincodes. To remove this product entirely, use PATCH .../remove instead.')
  }
  if (pincodes.length > MAX_PINCODES) {
    return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_PINCODES} pincodes is supported per product.`)
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  const config = getPincodeMonitoringConfig()
  const admin = createAdminClient()

  try {
    const rpcResult = await replaceProductTargets(admin, {
      workspaceId: access.context.workspaceId,
      marketplaceId: access.context.marketplaceId,
      monitoredProductId: id,
      pincodes,
      quotaLimit: config.quotaPerWorkspaceMarketplace,
    })
    return mapReplaceProductTargetsResult(rpcResult as ReplaceProductTargetsRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', 'Could not update the pincode list right now.')
    }
    throw error
  }
}
