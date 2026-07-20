/**
 * PATCH /api/pincode-monitoring/products/[id]/remove
 *
 * PRODUCT_SPEC.md sec5.4/sec11: soft removal only, via
 * `remove_pincode_monitored_products` -- never a DELETE route.
 *
 * Correction 6 (PR #55 review round): the prior round accepted an optional
 * body array of extra product IDs that could remove products OTHER than
 * the one named in the URL -- a product-scoped URL silently acting as a hidden
 * cross-product bulk endpoint. Removed: this route now ALWAYS acts on
 * exactly the URL's `[id]`, nothing else. No dedicated cross-product bulk
 * removal endpoint exists in this PR; if genuine multi-product bulk
 * removal is required, it needs its own explicitly-named route and
 * contract (per the correction's explicit instruction not to claim bulk
 * support without that contract existing).
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
      monitoredProductIds: [id],
    })
    return mapRemoveResult(rpcResult as RemoveRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', 'Could not remove tracking right now.')
    }
    throw error
  }
}
