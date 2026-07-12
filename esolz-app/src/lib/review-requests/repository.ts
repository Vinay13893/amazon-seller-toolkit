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
