/**
 * PATCH /api/pincode-monitoring/products/[id]/remove
 *
 * PRODUCT_SPEC.md sec5.4/sec11: soft removal only, via
 * `remove_pincode_monitored_products` -- never a DELETE route. `[id]` in
 * the URL is the primary product to remove; the body may optionally supply
 * `productIds` for a genuine atomic bulk removal across multiple products
 * in one RPC call (the RPC natively takes an array) -- same design
 * rationale as the pause/resume handler's `targetIds` override, documented
 * there and in the PR description.
 */
import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { jsonError, mapRemoveResult, type RemoveRpcResult } from '@/lib/pincode-monitoring/responses'
import { removeProducts, PincodeRpcTransportError } from '@/lib/pincode-monitoring/rpc'
import { isValidMarketplaceId, isValidUuid, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  productIds?: unknown
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

  let productIds: string[]
  if (body.productIds === undefined) {
    productIds = [id]
  } else if (Array.isArray(body.productIds) && body.productIds.every(isValidUuid) && body.productIds.length > 0) {
    productIds = body.productIds
  } else {
    return jsonError(400, 'invalid_parameters', 'productIds, when provided, must be a non-empty array of valid UUIDs.')
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  const admin = createAdminClient()

  try {
    const rpcResult = await removeProducts(admin, {
      workspaceId: access.context.workspaceId,
      marketplaceId: access.context.marketplaceId,
      monitoredProductIds: productIds,
    })
    return mapRemoveResult(rpcResult as RemoveRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', 'Could not remove tracking right now.')
    }
    throw error
  }
}
