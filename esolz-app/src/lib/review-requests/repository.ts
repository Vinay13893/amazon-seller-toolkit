/**
 * src/lib/review-requests/repository.ts
 *
 * Database operations for review_solicitation_orders (migration 059).
 * Server-only. This file never calls Amazon -- it only reads/writes our own
 * Supabase table. Decision logic (status classification, retry scheduling,
 * evidence sanitization) lives in ./policy.ts and is deliberately kept out
 * of this file so it stays pure and independently testable.
 *
 * Concurrency: findDueCandidates() -> claimForEligibilityCheck() ->
 * recordEligibilityResult() is a claim/finalize pattern mirroring
 * reclaimStuckJob() in scripts/process-asin-checker-jobs.ts -- every write
 * is a guarded UPDATE (matching on the expected prior status) with a
 * .select() row-count check, never a blind write. A second caller racing on
 * the same row simply fails to claim it (0 rows affected) and moves on.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  type SolicitationStatus,
  type SanitizedEligibilityEvidence,
  DUE_CANDIDATE_STATUSES,
  isProtectedStatus,
  computeNextCheckAt,
} from './policy'

type AdminClient = ReturnType<typeof createAdminClient>

const TABLE = 'review_solicitation_orders'

// ── Part A.1: upsert discovered order ────────────────────────────────────────

export interface DiscoveredOrderInput {
  workspaceId: string
  marketplaceId: string
  amazonOrderId: string
  orderStatus: string | null
  purchaseDate: string | null
  amazonLastUpdatedAt: string | null
}

export interface UpsertOrderResult {
  id: string
  inserted: boolean
}

/**
 * Upserts a discovered order by (workspace_id, marketplace_id,
 * amazon_order_id). Only ever writes Amazon-sourced fields
 * (order_status/purchase_date/amazon_last_updated_at) on an update --
 * solicitation_status, solicitation_sent, solicitation_sent_at, next_check_at,
 * claim fields, and check_attempts are never touched for an existing row.
 * This is what guarantees a terminal row is never reset to pending and a
 * sent row's audit fields are never overwritten: those columns simply never
 * appear in this function's UPDATE payload.
 *
 * A brand-new row is inserted with solicitation_status='pending' and
 * next_check_at=now (immediately due).
 */
export async function upsertDiscoveredOrder(
  admin: AdminClient,
  input: DiscoveredOrderInput,
  nowIso: string = new Date().toISOString(),
): Promise<UpsertOrderResult> {
  const existing = await admin
    .from(TABLE)
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('marketplace_id', input.marketplaceId)
    .eq('amazon_order_id', input.amazonOrderId)
    .maybeSingle()

  if (existing.data) {
    const { error } = await admin
      .from(TABLE)
      .update({
        order_status: input.orderStatus,
        purchase_date: input.purchaseDate,
        amazon_last_updated_at: input.amazonLastUpdatedAt,
      })
      .eq('id', existing.data.id)
    if (error) throw new Error(`upsertDiscoveredOrder update failed: ${error.message}`)
    return { id: existing.data.id, inserted: false }
  }

  const insertResult = await admin
    .from(TABLE)
    .insert({
      workspace_id: input.workspaceId,
      marketplace_id: input.marketplaceId,
      amazon_order_id: input.amazonOrderId,
      order_status: input.orderStatus,
      purchase_date: input.purchaseDate,
      amazon_last_updated_at: input.amazonLastUpdatedAt,
      solicitation_status: 'pending',
      next_check_at: nowIso,
    })
    .select('id')
    .single()

  if (insertResult.error) {
    // Unique-violation race: a concurrent upsert for the same order won.
    // Fall back to the existing row instead of failing -- mirrors the
    // concurrent-duplicate handling in addOrRestoreTrackedAsin
    // (src/lib/supabase/asins.ts).
    if (insertResult.error.code === '23505') {
      const raceLookup = await admin
        .from(TABLE)
        .select('id')
        .eq('workspace_id', input.workspaceId)
        .eq('marketplace_id', input.marketplaceId)
        .eq('amazon_order_id', input.amazonOrderId)
        .single()
      if (raceLookup.data) return { id: raceLookup.data.id, inserted: false }
    }
    throw new Error(`upsertDiscoveredOrder insert failed: ${insertResult.error.message}`)
  }

  return { id: insertResult.data!.id, inserted: true }
}

// ── Part A.2: find due candidates ────────────────────────────────────────────

export interface DueCandidateRow {
  id: string
  amazon_order_id: string
  solicitation_status: SolicitationStatus
  check_attempts: number
}

export interface FindDueCandidatesParams {
  workspaceId: string
  marketplaceId: string
  limit: number
  nowIso?: string
}

/**
 * Selects up to `limit` rows that are due for an eligibility check:
 * solicitation_sent=false, a non-terminal/non-in-flight status, and
 * next_check_at <= now. Deterministic ordering (next_check_at then id) so
 * repeated runs process the same backlog in the same order.
 */
export async function findDueCandidates(
  admin: AdminClient,
  params: FindDueCandidatesParams,
): Promise<DueCandidateRow[]> {
  const nowIso = params.nowIso ?? new Date().toISOString()
  const { data, error } = await admin
    .from(TABLE)
    .select('id, amazon_order_id, solicitation_status, check_attempts')
    .eq('workspace_id', params.workspaceId)
    .eq('marketplace_id', params.marketplaceId)
    .eq('solicitation_sent', false)
    .in('solicitation_status', DUE_CANDIDATE_STATUSES as string[])
    .lte('next_check_at', nowIso)
    .order('next_check_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(params.limit)

  if (error) throw new Error(`findDueCandidates failed: ${error.message}`)
  return data ?? []
}

// ── Part A.3: claim / finalize an eligibility check ──────────────────────────

export interface ClaimResult {
  claimed: boolean
  previousCheckAttempts: number | null
}

/**
 * Guarded claim: transitions a row from its current (expected) status to
 * 'checking', matching on both the expected status and solicitation_sent=false.
 * Returns claimed=false (and does nothing) if another caller already moved
 * the row away from `fromStatus` -- this is what makes two workers racing on
 * the same row safe: only one of them will see claimed=true.
 */
export async function claimForEligibilityCheck(
  admin: AdminClient,
  id: string,
  fromStatus: SolicitationStatus,
): Promise<ClaimResult> {
  const { data, error } = await admin
    .from(TABLE)
    .update({ solicitation_status: 'checking' })
    .eq('id', id)
    .eq('solicitation_status', fromStatus)
    .eq('solicitation_sent', false)
    .select('id, check_attempts')

  if (error || !data || data.length === 0) return { claimed: false, previousCheckAttempts: null }
  return { claimed: true, previousCheckAttempts: data[0].check_attempts }
}

export interface RecordEligibilityResultInput {
  toStatus: SolicitationStatus
  checkAttempts: number
  evidence: SanitizedEligibilityEvidence | null
  errorCode?: string | null
  errorMessage?: string | null
  nowIso?: string
}

/**
 * Finalizes a claimed eligibility check: writes the outcome status,
 * sanitized evidence, and a next_check_at computed by the centralized
 * policy in ./policy.ts (never trusted from the caller). Guarded to only
 * apply if the row is still 'checking' -- i.e. only the caller that
 * successfully claimed it can finalize it.
 *
 * Throws (refuses to run) if toStatus is a protected status ('sent' or
 * 'send_claimed') -- this repository function is never the right place to
 * write either of those in this PR.
 */
export async function recordEligibilityResult(
  admin: AdminClient,
  id: string,
  input: RecordEligibilityResultInput,
): Promise<boolean> {
  if (isProtectedStatus(input.toStatus)) {
    throw new Error(`recordEligibilityResult must never write a protected status: ${input.toStatus}`)
  }
  const nowIso = input.nowIso ?? new Date().toISOString()
  const nextCheckAt = computeNextCheckAt(input.toStatus, nowIso)

  const { data, error } = await admin
    .from(TABLE)
    .update({
      solicitation_status: input.toStatus,
      last_checked_at: nowIso,
      check_attempts: input.checkAttempts,
      next_check_at: nextCheckAt,
      last_eligibility_response: input.evidence,
      last_error_code: input.errorCode ?? null,
      last_error_message: input.errorMessage ?? null,
    })
    .eq('id', id)
    .eq('solicitation_status', 'checking')
    .select('id')

  if (error) return false
  return (data?.length ?? 0) > 0
}

// ── Part B: guarded send-claim / finalize (daily forward live-send path) ────
//
// claimForSendAttempt() -> recordSendResult() is the second claim/finalize
// pair the migration 059 comment block anticipated ("a future guarded
// pre-POST claim ... WHERE solicitation_sent = false AND solicitation_status
// IN ('eligible_dry_run', ...)"). Same guarded-UPDATE-with-row-count-check
// discipline as Part A.3 above: claimForSendAttempt() is the only way a row
// can reach 'send_claimed', and it atomically re-verifies solicitation_sent
// = false at the moment of claiming -- immediately before any POST is
// attempted -- so two workers racing on the same row can never both claim
// it. recordSendResult() is the only way a row can leave 'send_claimed'.

// How long a send-claim holds a row before it is considered stale. No
// reclaim job reads this yet in this PR (the claim/finalize pair below
// always completes synchronously within a single request), but it is
// required at write time by the migration's own
// review_solicitation_orders_send_claimed_chk constraint (claim_expires_at
// must be non-null whenever solicitation_status = 'send_claimed').
const SEND_CLAIM_TTL_MINUTES = 10

export interface ClaimForSendResult {
  claimed: boolean
}

/**
 * Guarded claim: transitions a row from `fromStatus` (expected to be
 * 'eligible_dry_run' -- a fresh GET just confirmed the eligible action is
 * present) to 'send_claimed', recording claimed_at/claimed_by/
 * claim_expires_at. Matches on solicitation_sent = false so a row that
 * (impossibly, but defensively) already has solicitation_sent = true can
 * never be reclaimed. Returns claimed=false if another caller already moved
 * the row away from `fromStatus` -- the caller must not POST in that case.
 */
export async function claimForSendAttempt(
  admin: AdminClient,
  id: string,
  fromStatus: SolicitationStatus,
  claimedBy: string,
  nowIso: string = new Date().toISOString(),
  claimTtlMinutes: number = SEND_CLAIM_TTL_MINUTES,
): Promise<ClaimForSendResult> {
  const claimExpiresAt = new Date(new Date(nowIso).getTime() + claimTtlMinutes * 60 * 1000).toISOString()

  const { data, error } = await admin
    .from(TABLE)
    .update({
      solicitation_status: 'send_claimed',
      claimed_at: nowIso,
      claimed_by: claimedBy,
      claim_expires_at: claimExpiresAt,
    })
    .eq('id', id)
    .eq('solicitation_status', fromStatus)
    .eq('solicitation_sent', false)
    .select('id')

  if (error || !data || data.length === 0) return { claimed: false }
  return { claimed: true }
}

export type SendOutcomeStatus = 'sent' | 'failed_retryable' | 'failed_terminal' | 'already_solicited'

export interface RecordSendResultInput {
  toStatus: SendOutcomeStatus
  evidence: SanitizedEligibilityEvidence | null
  errorCode?: string | null
  errorMessage?: string | null
  nowIso?: string
}

/**
 * Finalizes a claimed send attempt. Guarded to only apply if the row is
 * still 'send_claimed' -- only the caller that successfully claimed it can
 * finalize it, and finalizing twice (e.g. a duplicate/retried call) is a
 * safe no-op on the second call (0 rows affected, returns false).
 *
 * toStatus='sent' sets solicitation_sent=true and solicitation_sent_at=now
 * -- the only place in this codebase that ever does either, matching the
 * migration's sent/status/sent_at CHECK constraints exactly. Every other
 * outcome leaves solicitation_sent=false and clears the claim fields so the
 * row is never left permanently stuck in a claimed-looking state.
 */
export async function recordSendResult(
  admin: AdminClient,
  id: string,
  input: RecordSendResultInput,
): Promise<boolean> {
  const nowIso = input.nowIso ?? new Date().toISOString()
  const isSent = input.toStatus === 'sent'
  const nextCheckAt = computeNextCheckAt(input.toStatus, nowIso)

  const { data, error } = await admin
    .from(TABLE)
    .update({
      solicitation_status: input.toStatus,
      solicitation_sent: isSent,
      solicitation_sent_at: isSent ? nowIso : null,
      next_check_at: nextCheckAt,
      last_eligibility_response: input.evidence,
      last_error_code: input.errorCode ?? null,
      last_error_message: input.errorMessage ?? null,
      claimed_at: null,
      claimed_by: null,
      claim_expires_at: null,
    })
    .eq('id', id)
    .eq('solicitation_status', 'send_claimed')
    .select('id')

  if (error) return false
  return (data?.length ?? 0) > 0
}

// ── Part D: stale `checking` claim reclaim ───────────────────────────────────
//
// claimForEligibilityCheck() has no TTL/expiry field on the schema (unlike
// the send-claim's claim_expires_at) -- if the process that claimed a row
// is killed before recordEligibilityResult() finalizes it (e.g. a
// serverless runtime-budget stop or platform timeout), the row is stuck in
// 'checking' forever: findDueCandidates() deliberately excludes 'checking'
// by design (see policy.ts's DUE_CANDIDATE_STATUSES comment), so no future
// run will ever select it again without this reclaim.
//
// reclaimStaleCheckingClaims() is intended to run at the start of every
// eligibility processor invocation, before selecting new candidates. It
// uses the existing `updated_at` column -- reliably bumped by the DB's own
// trg_review_solicitation_orders_updated_at trigger on the exact UPDATE
// claimForEligibilityCheck() performs -- so no migration/new column is
// needed. Reclaimed rows go back to 'pending' (a valid, always-safe
// DUE_CANDIDATE_STATUS) with next_check_at reset to now, exactly like a
// freshly-discovered row.
//
// Guarded to only match solicitation_status='checking' AND
// updated_at < staleBeforeIso: a row with a fresh/active claim is never
// touched (updated_at recent), and a row already finalized by the worker
// that claimed it no longer matches 'checking'. This scope never overlaps
// with 'send_claimed' (a separate status/claim pair guarded by
// claimForSendAttempt/recordSendResult), so reclaim can never interfere
// with an in-flight send claim or cause a duplicate send.

export interface ReclaimStaleCheckingParams {
  workspaceId: string
  marketplaceId: string
  staleBeforeIso: string
  nowIso?: string
}

export async function reclaimStaleCheckingClaims(
  admin: AdminClient,
  params: ReclaimStaleCheckingParams,
): Promise<number> {
  const nowIso = params.nowIso ?? new Date().toISOString()
  const { data, error } = await admin
    .from(TABLE)
    .update({
      solicitation_status: 'pending',
      next_check_at: nowIso,
    })
    .eq('workspace_id', params.workspaceId)
    .eq('marketplace_id', params.marketplaceId)
    .eq('solicitation_status', 'checking')
    .lt('updated_at', params.staleBeforeIso)
    .select('id')

  if (error) throw new Error(`reclaimStaleCheckingClaims failed: ${error.message}`)
  return data?.length ?? 0
}

// ── Optional: cheap read-only due-backlog count ──────────────────────────────
//
// Same filter shape as findDueCandidates(), backed by the same partial
// index (review_solicitation_orders_due_idx) -- an index-only COUNT, not a
// full table scan, so it is cheap enough to call every eligibility-processor
// run purely for reporting ("how much backlog is left after this batch").
// Never used to select or claim rows itself.

export interface CountDueCandidatesParams {
  workspaceId: string
  marketplaceId: string
  nowIso?: string
}

export async function countDueCandidates(
  admin: AdminClient,
  params: CountDueCandidatesParams,
): Promise<number> {
  const nowIso = params.nowIso ?? new Date().toISOString()
  const { count, error } = await admin
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', params.workspaceId)
    .eq('marketplace_id', params.marketplaceId)
    .eq('solicitation_sent', false)
    .in('solicitation_status', DUE_CANDIDATE_STATUSES as string[])
    .lte('next_check_at', nowIso)

  if (error) throw new Error(`countDueCandidates failed: ${error.message}`)
  return count ?? 0
}
