/**
 * Shared handler for PATCH .../products/[id]/pause and .../resume.
 *
 * Correction 6 (PR #55 review round): the prior round let a `targetIds`
 * body array silently act on targets belonging to OTHER products, turning
 * a product-scoped URL (`/products/A/pause`) into a hidden cross-product
 * bulk endpoint -- `POST /products/A/pause` with `targetIds` from products
 * B and C would have mutated B/C's targets too, never visible from the
 * URL alone. Fixed: this handler always resolves the URL product's own
 * target set first; an optional `targetIds` body array may only NARROW
 * that set (every supplied ID must already belong to the URL product,
 * verified against the resolved set, not merely against workspace/
 * marketplace scope) -- never widen it to another product. No dedicated
 * cross-product bulk endpoint exists in this PR; if genuine multi-product
 * bulk pause/resume is required, it needs its own explicitly-named route
 * and contract, not an overload of this one (per the correction's explicit
 * instruction not to claim bulk support without that contract existing).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from './access'
import { getPincodeMonitoringConfig } from './config'
import { jsonError, mapSetTrackingStateResult, type SetTrackingStateRpcResult } from './responses'
import { setTrackingState, PincodeRpcTransportError } from './rpc'
import { isValidMarketplaceId, isValidUuid, parseJsonBody } from './validation'

const MAX_TARGET_IDS = 500 // mirrors set_pincode_tracking_state's own MAX_TARGET_IDS ceiling (063/064 migration)

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  targetIds?: unknown
}

export type ScopedTargetIdsResult =
  | { ok: true; targetIds: string[] }
  | { ok: false; foreignTargetIds: string[] }

/**
 * Pure core of Correction 6: given the URL product's OWN target IDs and an
 * optional caller-requested subset, decides the final target-ID list this
 * request is allowed to act on -- or which requested IDs don't belong to
 * the URL product and must reject the whole call. Separated from the I/O
 * around it (the DB query for `productTargetIds`, the RPC call) so
 * `__tests__/pause-resume-handler.test.ts` can assert the actual security
 * property (a product-scoped URL cannot mutate another product's targets)
 * as a fast, pure-function test.
 */
export function resolveScopedTargetIds(productTargetIds: Set<string>, requestedTargetIds: string[] | null): ScopedTargetIdsResult {
  if (requestedTargetIds === null) {
    return { ok: true, targetIds: Array.from(productTargetIds) }
  }
  const foreign = requestedTargetIds.filter(id => !productTargetIds.has(id))
  if (foreign.length > 0) {
    return { ok: false, foreignTargetIds: foreign }
  }
  return { ok: true, targetIds: requestedTargetIds }
}

export async function handlePauseResume(request: Request, productId: string, action: 'pause' | 'resume') {
  if (!isValidUuid(productId)) {
    return jsonError(400, 'invalid_parameters', 'The product ID in the URL is not a valid UUID.')
  }

  const body = await parseJsonBody(request) as RequestBody | null
  if (!body || typeof body.workspaceId !== 'string' || !isValidMarketplaceId(body.marketplaceId)) {
    return jsonError(400, 'invalid_parameters', 'workspaceId and marketplaceId are required.')
  }

  let requestedTargetIds: string[] | null = null
  if (body.targetIds !== undefined) {
    if (!Array.isArray(body.targetIds) || body.targetIds.length === 0 || !body.targetIds.every(isValidUuid)) {
      return jsonError(400, 'invalid_parameters', 'targetIds, when provided, must be a non-empty array of valid UUIDs.')
    }
    if (body.targetIds.length > MAX_TARGET_IDS) {
      return jsonError(400, 'invalid_parameters', `A maximum of ${MAX_TARGET_IDS} target IDs is supported per request.`)
    }
    requestedTargetIds = Array.from(new Set(body.targetIds))
  }

  const access = await resolvePincodeAccess({
    workspaceId: body.workspaceId,
    marketplaceId: body.marketplaceId as string,
    requireWriteRole: true,
  })
  if (!access.ok) return access.response

  const admin = createAdminClient()

  // Correction 6: always resolve the URL product's OWN target set first --
  // this is the authoritative scope for this call, never expanded by the
  // request body.
  const { data: productTargets, error } = await admin
    .from('pincode_tracking_targets')
    .select('id')
    .eq('workspace_id', access.context.workspaceId)
    .eq('monitored_product_id', productId)

  if (error) return jsonError(500, 'targets_lookup_failed', 'Could not resolve this product\'s pincode targets.')
  const productTargetIds = new Set((productTargets ?? []).map(t => t.id as string))
  if (productTargetIds.size === 0) {
    return jsonError(404, 'not_found_or_scope_mismatch', 'This product has no pincode targets in this workspace.', { requestedCount: 0, validCount: 0 })
  }

  const scoped = resolveScopedTargetIds(productTargetIds, requestedTargetIds)
  if (!scoped.ok) {
    return jsonError(400, 'invalid_parameters', 'Every targetId must belong to the product named in the URL.', {
      reason: 'target_not_in_product',
      foreignTargetIds: scoped.foreignTargetIds,
    })
  }
  const targetIds = scoped.targetIds

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
