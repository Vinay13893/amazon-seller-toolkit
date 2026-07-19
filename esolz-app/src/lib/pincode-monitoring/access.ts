/**
 * Pincode Monitoring P0-B — the one access-control gate every route calls.
 *
 * DATA_MODEL.md sec6 locks the check order: (1) authenticated session
 * exists, (2) caller is a member of the target workspace_id (never trusted
 * from the request body/query string alone), (3) caller's role is
 * owner/admin/member for a mutating route (viewer -> 403). IMPLEMENTATION_
 * PLAN.md sec6's round-3 Correction 12 additionally requires every route to
 * independently reject a non-allowlisted workspace, not merely rely on the
 * UI being hidden.
 *
 * `decidePincodeAccess` is the pure decision function (input facts in,
 * accept/reject out) -- deliberately separated from the Supabase I/O below
 * it so `__tests__/access.test.ts` can exercise every required scenario
 * (unauthenticated, non-member, viewer read allowed, viewer mutation
 * rejected, non-allowlisted workspace rejected, feature disabled rejected)
 * as fast, pure-function assertions, without a live database.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getPincodeMonitoringConfig, isWorkspaceAllowlisted } from './config'
import { jsonError } from './responses'

export type PincodeRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface AccessDecisionInput {
  authenticated: boolean
  /** null means: no workspace_members row for (this user, the requested workspace) -- not a member. */
  membershipRole: PincodeRole | null
  /** false for read-only (GET) routes; true for every mutating route. */
  requireWriteRole: boolean
  featureEnabled: boolean
  workspaceAllowlisted: boolean
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; status: number; errorCode: string; error: string }

export function decidePincodeAccess(input: AccessDecisionInput): AccessDecision {
  if (!input.authenticated) {
    return { ok: false, status: 401, errorCode: 'unauthorized', error: 'Unauthorized' }
  }
  if (input.membershipRole === null) {
    return { ok: false, status: 403, errorCode: 'not_a_member', error: 'You are not a member of this workspace.' }
  }
  // Feature-flag/allowlist checked before the role check: an unallowlisted
  // workspace is rejected the same way for every role, including owner --
  // there is no role that bypasses the rollout gate (IMPLEMENTATION_PLAN.md
  // sec6, round-3 Correction 12).
  if (!input.featureEnabled || !input.workspaceAllowlisted) {
    return { ok: false, status: 403, errorCode: 'pincode_monitoring_disabled', error: 'Pincode monitoring is not enabled for this workspace.' }
  }
  if (input.requireWriteRole && input.membershipRole === 'viewer') {
    return { ok: false, status: 403, errorCode: 'viewer_forbidden', error: 'Viewer-role members cannot perform this action.' }
  }
  return { ok: true }
}

export interface PincodeRequestContext {
  userId: string
  workspaceId: string
  marketplaceId: string
  role: PincodeRole
}

export type PincodeAccessResult =
  | { ok: true; context: PincodeRequestContext }
  | { ok: false; response: NextResponse }

/**
 * Full I/O-backed access resolution: authenticates the session, verifies
 * workspace membership by looking up the SPECIFIC requested workspace_id
 * (never inferring "the caller's workspace" or trusting an unverified
 * value), applies the feature-flag/allowlist gate, and checks role for
 * mutating routes. `workspaceId`/`marketplaceId` must already be extracted
 * (and, for workspaceId, only loosely shape-checked) by the calling route
 * from the query string or JSON body -- this function is what turns "a
 * string the client sent" into "a workspace_id this session is actually
 * allowed to act on."
 */
export async function resolvePincodeAccess(args: {
  workspaceId: string
  marketplaceId: string
  requireWriteRole: boolean
}): Promise<PincodeAccessResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let membershipRole: PincodeRole | null = null
  if (user) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    membershipRole = (membership?.role as PincodeRole | undefined) ?? null
  }

  const config = getPincodeMonitoringConfig()
  const decision = decidePincodeAccess({
    authenticated: Boolean(user),
    membershipRole,
    requireWriteRole: args.requireWriteRole,
    featureEnabled: config.enabled,
    workspaceAllowlisted: isWorkspaceAllowlisted(config, args.workspaceId),
  })

  if (!decision.ok) {
    return { ok: false, response: jsonError(decision.status, decision.errorCode, decision.error) }
  }

  return {
    ok: true,
    context: { userId: user!.id, workspaceId: args.workspaceId, marketplaceId: args.marketplaceId, role: membershipRole! },
  }
}
