/**
 * Shared handler for PATCH .../products/[id]/pause and .../resume --
 * IMPLEMENTATION_PLAN.md sec9's route map lists both as product-scoped URLs
 * (`/products/[id]/pause`), but `set_pincode_tracking_state` itself (DATA_
 * MODEL.md sec3a) operates on an array of TARGET (pincode) IDs, not a
 * single product ID -- there is no product-level pause/resume RPC, only a
 * "UI convenience that bulk-pauses its child targets" (PRODUCT_SPEC.md
 * sec7's Paused-state row).
 *
 * Implementation decision (not literally pinned down by any spec document,
 * called out here and in the PR description): the URL's `[id]` names the
 * product whose targets this call defaults to acting on. The request body
 * may optionally supply `targetIds` to scope the action to specific
 * pincodes within that product (the per-pincode single-target case, sec5.4)
 * or, when a caller supplies target IDs that belong to OTHER products too,
 * a genuine cross-product bulk action in one RPC call (the multi-select-bar
 * case, sec5.4 item 3) -- `set_pincode_tracking_state` itself doesn't care
 * which product a target belongs to, only that every target resolves
 * within the caller's workspace/marketplace, which the RPC's own complete-
 * batch validation already enforces. If `targetIds` is omitted, this
 * handler resolves it to every current target of the URL's product.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from './access'
import { getPincodeMonitoringConfig } from './config'
import { jsonError, mapSetTrackingStateResult, type SetTrackingStateRpcResult } from './responses'
import { setTrackingState, PincodeRpcTransportError } from './rpc'
import { isValidMarketplaceId, isValidUuid, parseJsonBody } from './validation'

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  targetIds?: unknown
}

export async function handlePauseResume(request: Request, productId: string, action: 'pause' | 'resume') {
  if (!isValidUuid(productId)) {
    return jsonError(400, 'invalid_parameters', 'The product ID in the URL is not a valid UUID.')
  }

  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId are required.')
  }

  let targetIds: string[]
  if (body.targetIds === undefined) {
    targetIds = [] // resolved below, after the access check, against the real table
  } else if (Array.isArray(body.targetIds) && body.targetIds.every(isValidUuid) && body.targetIds.length > 0) {
    targetIds = body.targetIds
  } else {
    return jsonError(400, 'invalid_parameters', 'targetIds, when provided, must be a non-empty array of valid UUIDs.')
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  const admin = createAdminClient()

  if (targetIds.length === 0) {
    const { data: targets, error } = await admin
      .from('pincode_tracking_targets')
      .select('id')
      .eq('workspace_id', access.context.workspaceId)
      .eq('monitored_product_id', productId)

    if (error) return jsonError(500, 'targets_lookup_failed', 'Could not resolve this product\'s pincode targets.')
    targetIds = (targets ?? []).map(t => t.id as string)
    if (targetIds.length === 0) {
      return jsonError(404, 'not_found_or_scope_mismatch', 'This product has no pincode targets in this workspace.', { requestedCount: 0, validCount: 0 })
    }
  }

  const config = getPincodeMonitoringConfig()

  try {
    const rpcResult = await setTrackingState(admin, {
      workspaceId: access.context.workspaceId,
      marketplaceId: access.context.marketplaceId,
      targetIds,
      action,
      quotaLimit: config.quotaPerWorkspaceMarketplace,
    })
    return mapSetTrackingStateResult(rpcResult as SetTrackingStateRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', `Could not ${action} tracking right now.`)
    }
    throw error
  }
}
