/**
 * Pincode Monitoring P0-B — the one access-control gate every route calls.
 *
 * DATA_MODEL.md sec6 locks the check order: (1) authenticated session
 * exists, (2) caller is a member of the target workspace_id (never trusted
 * from the request body/query string alone), (3) caller's role is
 * owner/admin/member for a mutating route (viewer -> 403). IMPLEMENTATION_
 * PLAN.md sec6's round-3 Correction 12 additionally requires every route to
 * independently reject a non-allowlisted workspace.
 *
 * Correction 5 (PR #55 review round) adds three more checks the original
 * round missed:
 * - `workspaceId` must be a syntactically valid UUID BEFORE it ever reaches
 *   a database query (a malformed value previously reached PostgREST as a
 *   raw string filter, which errors, but as an uncontrolled 500-shaped
 *   failure rather than a clean, intentional 400).
 * - The requested `marketplaceId` must be authorized for the EXACT
 *   workspace, not merely well-formed. The canonical source, found by
 *   direct inspection (not assumed): `amazon_connections` has a UNIQUE
 *   index on `workspace_id` (006 migration, "one connection record per
 *   workspace") with its own `marketplace_id` column populated after
 *   OAuth -- a workspace is authorized for exactly the one marketplace_id
 *   recorded on its own connection row. No row (never connected) or a
 *   requested marketplace that doesn't match the recorded one both fail
 *   closed.
 * - Roles are checked against an explicit runtime allowlist
 *   (`WRITE_ROLES`/`KNOWN_ROLES`), not "anything that isn't literally the
 *   string 'viewer'" -- an unrecognized role value (a future role added to
 *   the enum without this module being updated, or a data anomaly) is
 *   rejected outright, never silently treated as writable.
 *
 * `decidePincodeAccess` is the pure decision function (input facts in,
 * accept/reject out) -- deliberately separated from the Supabase I/O below
 * it so `__tests__/access.test.ts` can exercise every required scenario as
 * fast, pure-function assertions, without a live database.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getPincodeMonitoringConfig, isWorkspaceAllowlisted } from './config'
import { jsonError } from './responses'
import { isValidUuid } from './validation'

export type PincodeRole = 'owner' | 'admin' | 'member' | 'viewer'

// Correction 5: explicit runtime allowlists, not an implicit "anything
// that isn't 'viewer' is writable" inference. `KNOWN_ROLES` matches the
// actual database enum (public.member_role, 001_initial_schema.sql:16)
// exactly -- confirmed by direct inspection, not assumed.
const KNOWN_ROLES = new Set<string>(['owner', 'admin', 'member', 'viewer'])
const WRITE_ROLES = new Set<string>(['owner', 'admin', 'member'])

export interface AccessDecisionInput {
  authenticated: boolean
  /** null means: no workspace_members row for (this user, the requested workspace) -- not a member. */
  membershipRole: string | null
  /** false for read-only (GET) routes; true for every mutating route. */
  requireWriteRole: boolean
  featureEnabled: boolean
  workspaceAllowlisted: boolean
  /** true only when amazon_connections has an active row for this workspace whose OWN marketplace_id matches the requested one. */
  marketplaceAuthorized: boolean
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
  // Correction 5: an unrecognized role is rejected outright, for every
  // route (read or write) -- never treated as either a valid viewer or a
  // valid writer by default.
  if (!KNOWN_ROLES.has(input.membershipRole)) {
    return { ok: false, status: 403, errorCode: 'unknown_role', error: 'Your workspace role could not be recognized.' }
  }
  // Feature-flag/allowlist checked before role/marketplace: an
  // unallowlisted workspace is rejected the same way for every role,
  // including owner -- there is no role or marketplace state that bypasses
  // the rollout gate (IMPLEMENTATION_PLAN.md sec6, round-3 Correction 12).
  if (!input.featureEnabled || !input.workspaceAllowlisted) {
    return { ok: false, status: 403, errorCode: 'pincode_monitoring_disabled', error: 'Pincode monitoring is not enabled for this workspace.' }
  }
  // Correction 5: the requested marketplace must belong to this exact
  // workspace's own Amazon connection -- checked before role, so a
  // request for a marketplace this workspace was never entitled to is
  // rejected the same way regardless of the caller's role.
  if (!input.marketplaceAuthorized) {
    return { ok: false, status: 403, errorCode: 'marketplace_not_authorized', error: 'This marketplace is not authorized for this workspace.' }
  }
  if (input.requireWriteRole && !WRITE_ROLES.has(input.membershipRole)) {
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
 * Full I/O-backed access resolution: validates `workspaceId` is a
 * syntactically valid UUID, trims/bounds `marketplaceId`, authenticates
 * the session, verifies workspace membership by looking up the SPECIFIC
 * requested workspace_id, verifies the requested marketplace is the one
 * this workspace's Amazon connection is actually entitled to, applies the
 * feature-flag/allowlist gate, and checks role for mutating routes.
 * `workspaceId`/`marketplaceId` must already be extracted (not validated)
 * by the calling route from the query string or JSON body.
 */
export async function resolvePincodeAccess(args: {
  workspaceId: string
  marketplaceId: string
  requireWriteRole: boolean
}): Promise<PincodeAccessResult> {
  // Correction 5: reject a malformed workspaceId before any database call.
  const workspaceId = args.workspaceId.trim().toLowerCase()
  if (!isValidUuid(workspaceId)) {
    return { ok: false, response: jsonError(400, 'invalid_parameters', 'workspaceId must be a valid UUID.') }
  }
  const marketplaceId = args.marketplaceId.trim()
  if (marketplaceId.length === 0 || marketplaceId.length > 40) {
    return { ok: false, response: jsonError(400, 'invalid_parameters', 'marketplaceId must be a non-empty string of at most 40 characters.') }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let membershipRole: string | null = null
  if (user) {
    const { data: membership, error: membershipError } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    // Correction 5: an infrastructure error (query failure) is NOT the
    // same fact as "no membership row exists" -- disguising one as the
    // other would misreport a transient outage as "you're not a member."
    if (membershipError) {
      return { ok: false, response: jsonError(500, 'membership_query_failed', 'Could not verify workspace membership right now — try again.') }
    }
    membershipRole = (membership?.role as string | undefined) ?? null
  }

  // Correction 5: marketplace entitlement, resolved from amazon_connections
  // -- the one row per workspace, own marketplace_id column (006
  // migration). Only queried once membership is confirmed valid, since an
  // unauthorized caller should never learn whether a marketplace is
  // authorized for a workspace they don't belong to.
  let marketplaceAuthorized = false
  if (user && membershipRole !== null) {
    const { data: connection, error: connectionError } = await supabase
      .from('amazon_connections')
      .select('marketplace_id')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (connectionError) {
      return { ok: false, response: jsonError(500, 'marketplace_query_failed', 'Could not verify marketplace access right now — try again.') }
    }
    marketplaceAuthorized = Boolean(connection?.marketplace_id) && connection!.marketplace_id === marketplaceId
  }

  const config = getPincodeMonitoringConfig()
  const decision = decidePincodeAccess({
    authenticated: Boolean(user),
    membershipRole,
    requireWriteRole: args.requireWriteRole,
    featureEnabled: config.enabled,
    workspaceAllowlisted: isWorkspaceAllowlisted(config, workspaceId),
    marketplaceAuthorized,
  })

  if (!decision.ok) {
    return { ok: false, response: jsonError(decision.status, decision.errorCode, decision.error) }
  }

  return {
    ok: true,
    context: { userId: user!.id, workspaceId, marketplaceId, role: membershipRole as PincodeRole },
  }
}
