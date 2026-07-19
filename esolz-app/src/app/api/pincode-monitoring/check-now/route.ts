/**
 * POST /api/pincode-monitoring/check-now
 *
 * PRODUCT_SPEC.md sec11: Manual Check Now for a single pincode target,
 * queued via `queue_pincode_manual_check` -- never runs the checker
 * synchronously in this request. A `202` (or `200` for the already-
 * queued/already-checking coalesced cases) means genuinely queued, never a
 * fire-and-hope call this request blocked on.
 */
import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePincodeAccess } from '@/lib/pincode-monitoring/access'
import { getPincodeMonitoringConfig } from '@/lib/pincode-monitoring/config'
import { jsonError, mapQueueManualCheckResult, type QueueManualCheckRpcResult } from '@/lib/pincode-monitoring/responses'
import { queueManualCheck, PincodeRpcTransportError } from '@/lib/pincode-monitoring/rpc'
import { isValidMarketplaceId, isValidUuid, parseJsonBody } from '@/lib/pincode-monitoring/validation'

export const runtime = 'nodejs'

interface RequestBody {
  workspaceId?: unknown
  marketplaceId?: unknown
  targetId?: unknown
}

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request) as RequestBody | null
  if (
    !body ||
    typeof body.workspaceId !== 'string' ||
    !isValidMarketplaceId(body.marketplaceId) ||
    !isValidUuid(body.targetId)
  ) {
    return jsonError(400, 'invalid_parameters', 'workspaceId, marketplaceId, and a valid targetId are required.')
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
    const rpcResult = await queueManualCheck(admin, {
      targetId: body.targetId as string,
      workspaceId: access.context.workspaceId,
      marketplaceId: access.context.marketplaceId,
      userId: access.context.userId,
      cooldownSeconds: config.manualCheckCooldownSeconds,
      manualPendingLimit: config.manualMaxOutstandingPerWorkspaceMarketplace,
    })
    return mapQueueManualCheckResult(rpcResult as QueueManualCheckRpcResult)
  } catch (error) {
    if (error instanceof PincodeRpcTransportError) {
      return jsonError(500, 'rpc_transport_error', 'Could not queue a manual check right now.')
    }
    throw error
  }
}
