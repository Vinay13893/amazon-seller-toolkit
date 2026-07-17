/**
 * src/lib/review-requests/eligibility-processor.ts
 *
 * Bounded eligibility-check-and-optionally-send phase for the Amazon India
 * EasyHOME Review Request Automation (see REVIEW_REQUEST_AUTOMATION_SPEC.md
 * and BRAHMASTRA_MASTER_TRACKER.md sec18). Split out of the former combined
 * daily-run.ts after the 2026-07-17 production timeout finding: the
 * combined workflow's Phase 2 (a 300-candidate, 1100ms-rate-limited
 * sequential loop) could not complete inside Vercel's 280s serverless
 * ceiling on a backlogged run, and left one candidate permanently stuck in
 * 'checking' with no reclaim path.
 *
 * This phase, in order:
 *   0. Reclaims any stale 'checking' claim (see
 *      repository.ts#reclaimStaleCheckingClaims) before selecting new
 *      work, so a prior run's runtime-budget stop can never orphan a row.
 *   1. Selects up to `batchSize` due candidates (recommended default 120 --
 *      see the capacity note in scripts/test-review-requests-eligibility-processor.ts).
 *   2. Re-runs the Solicitations GET eligibility check per candidate
 *      (source of truth, never cached/reused across runs), then either
 *      records eligible_dry_run and stops, or -- only when BOTH
 *      REVIEW_REQUESTS_ENABLED=true AND REVIEW_REQUESTS_DRY_RUN=false --
 *      attempts the guarded claimForSendAttempt() -> POST ->
 *      recordSendResult() send path. Identical safety gating to the former
 *      daily-run.ts Phase 2 -- this file only changes *how much* work one
 *      invocation attempts and *how* it stops, never *whether* it can send.
 *   3. Stops claiming new candidates once the internal runtime budget
 *      (default 220s, comfortably under Vercel's 280s hard ceiling) is
 *      exhausted, finishes finalizing whichever candidate is already
 *      claimed, and returns an accurate partial-run summary instead of
 *      ever depending on the platform to force-kill the function.
 *
 * One candidate's unexpected error never aborts the batch -- each
 * iteration is wrapped in try/catch and counted, not thrown. Never persists
 * a raw Orders/Solicitations API payload, never logs a full unmasked order
 * id, and the returned report contains only sanitized aggregate counts (no
 * order ids, no buyer PII).
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  getSolicitationActionsForOrder,
  createProductReviewAndSellerFeedbackSolicitation,
  type SolicitationActionsResult,
  type CreateSolicitationResult,
} from '@/lib/amazon/spapi-client'
import {
  findDueCandidates,
  claimForEligibilityCheck,
  recordEligibilityResult,
  claimForSendAttempt,
  recordSendResult,
  reclaimStaleCheckingClaims,
  countDueCandidates,
} from './repository'
import {
  classifyEligibilityOutcome,
  classifySolicitationsError,
  classifySendOutcome,
  buildSanitizedEligibilityEvidence,
  recordApiError,
  maskOrderId,
} from './policy'

type AdminClient = ReturnType<typeof createAdminClient>

const PRODUCT_REVIEW_ACTION_NAME = 'productReviewAndSellerFeedback'
export const DEFAULT_ELIGIBILITY_BATCH_SIZE = 120
export const DEFAULT_RUNTIME_BUDGET_MS = 220_000
export const DEFAULT_STALE_CLAIM_TTL_MINUTES = 15

export interface EligibilityProcessorDeps {
  admin: AdminClient
  getSolicitationFn: typeof getSolicitationActionsForOrder
  createSolicitationFn: typeof createProductReviewAndSellerFeedbackSolicitation
  sleepFn: (ms: number) => Promise<void>
  nowFn: () => Date
}

export interface EligibilityProcessorParams {
  workspaceId: string
  marketplaceId: string
  accessToken: string
  batchSize: number
  rateLimitMs: number
  runtimeBudgetMs: number
  staleClaimTtlMinutes: number
  /** REVIEW_REQUESTS_ENABLED === 'true' */
  liveSendEnabled: boolean
  /** REVIEW_REQUESTS_DRY_RUN !== 'false' (defaults true -- dry-run) */
  dryRun: boolean
  workerId: string
}

export interface EligibilityProcessorReport {
  staleClaimsReclaimed: number
  candidatesSelected: number
  /**
   * A candidate counts as completed only once its claim has been resolved
   * out of 'checking' AND the final DB write (recordEligibilityResult or
   * recordSendResult) has been confirmed applied. A successful Amazon GET
   * followed by a failed/unconfirmed DB write does NOT count -- that row is
   * left in 'checking' and is recovered later by reclaimStaleCheckingClaims,
   * not silently mis-reported as done here.
   */
  candidatesCompleted: number
  /**
   * How many of THIS batch's selected candidates were not completed --
   * i.e. candidatesSelected - candidatesCompleted. This is NOT the total
   * database backlog; see dueBacklogRemaining for that (a separate,
   * optional, cheap read-only count).
   */
  selectedCandidatesRemaining: number
  /** Cheap index-backed COUNT of the full due-candidate backlog after this run, across all batches -- not just this one. */
  dueBacklogRemaining: number
  stoppedDueToRuntimeBudget: boolean
  eligibleDryRun: number
  notEligibleRetryable: number
  sent: number
  failedRetryable: number
  failedTerminal: number
  amazonErrorsByCode: Record<string, number>
  durationMs: number
  liveSendActive: boolean
}

export async function runEligibilityProcessing(
  deps: EligibilityProcessorDeps,
  params: EligibilityProcessorParams,
): Promise<EligibilityProcessorReport> {
  const { admin, getSolicitationFn, createSolicitationFn, sleepFn, nowFn } = deps
  const startedAt = nowFn().getTime()
  const liveSendActive = params.liveSendEnabled && !params.dryRun
  const budgetDeadline = startedAt + Math.max(params.runtimeBudgetMs, 0)

  // Step 0: reclaim stale 'checking' claims before selecting new work.
  const staleBeforeIso = new Date(startedAt - Math.max(params.staleClaimTtlMinutes, 1) * 60 * 1000).toISOString()
  const staleClaimsReclaimed = await reclaimStaleCheckingClaims(admin, {
    workspaceId: params.workspaceId,
    marketplaceId: params.marketplaceId,
    staleBeforeIso,
    nowIso: nowFn().toISOString(),
  })

  const candidates = await findDueCandidates(admin, {
    workspaceId: params.workspaceId,
    marketplaceId: params.marketplaceId,
    limit: params.batchSize,
    nowIso: nowFn().toISOString(),
  })

  const amazonErrorsByCode: Record<string, number> = {}
  let candidatesCompleted = 0
  let eligibleDryRun = 0
  let notEligibleRetryable = 0
  let sent = 0
  let failedRetryable = 0
  let failedTerminal = 0
  let stoppedDueToRuntimeBudget = false

  for (const candidate of candidates) {
    // Check the runtime budget BEFORE claiming a new candidate -- never
    // mid-candidate. Once a candidate is claimed below, its own
    // claim -> GET -> finalize cycle always runs to completion as a unit,
    // so a claimed row is never left in a half-finished state by this
    // budget check (only by an actual process kill, which the stale-claim
    // reclaim above exists to recover from on the next run).
    if (nowFn().getTime() >= budgetDeadline) {
      stoppedDueToRuntimeBudget = true
      break
    }

    // One failed order must not abort the batch.
    try {
      const claim = await claimForEligibilityCheck(admin, candidate.id, candidate.solicitation_status)
      if (!claim.claimed) continue // lost a claim race to another worker -- safe skip, not an error

      await sleepFn(params.rateLimitMs)
      const solResult: SolicitationActionsResult = await getSolicitationFn(params.accessToken, {
        amazonOrderId: candidate.amazon_order_id,
        marketplaceId: params.marketplaceId,
      })
      // NOTE: candidatesCompleted is intentionally NOT incremented here.
      // A successful Amazon GET is not "completion" -- completion requires
      // the DB finalize write below to actually apply (recordEligibilityResult
      // / recordSendResult returning true). If that write fails or throws,
      // the row stays in 'checking' and is picked up later by
      // reclaimStaleCheckingClaims -- it must not be counted as done here.
      const nowIso = nowFn().toISOString()
      const newCheckAttempts = (claim.previousCheckAttempts ?? 0) + 1

      if (!solResult.ok) {
        recordApiError(amazonErrorsByCode, solResult.statusCode, solResult.amazonErrorCode)
        const toStatus = classifySolicitationsError(solResult.statusCode, solResult.amazonErrorCode)
        const finalized = await recordEligibilityResult(admin, candidate.id, {
          toStatus,
          checkAttempts: newCheckAttempts,
          evidence: buildSanitizedEligibilityEvidence({
            actionNames: [],
            checkedAt: nowIso,
            amazonStatusCode: solResult.statusCode,
            amazonErrorCode: solResult.amazonErrorCode,
            sanitizedReason: `HTTP ${solResult.statusCode}`,
          }),
          errorCode: solResult.amazonErrorCode,
          errorMessage: `HTTP ${solResult.statusCode}`,
          nowIso,
        })
        if (finalized) candidatesCompleted += 1
        failedRetryable += 1
        continue
      }

      const actionsPresent = solResult.actions.includes(PRODUCT_REVIEW_ACTION_NAME)

      if (!actionsPresent) {
        const toStatus = classifyEligibilityOutcome(false)
        const finalized = await recordEligibilityResult(admin, candidate.id, {
          toStatus,
          checkAttempts: newCheckAttempts,
          evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: nowIso }),
          nowIso,
        })
        if (finalized) candidatesCompleted += 1
        notEligibleRetryable += 1
        continue
      }

      // Eligible action present. Record eligible_dry_run first regardless of
      // mode -- historical GET-evidence record, matches the former
      // daily-run.ts behavior exactly when live-send is not active.
      const eligibleFinalized = await recordEligibilityResult(admin, candidate.id, {
        toStatus: 'eligible_dry_run',
        checkAttempts: newCheckAttempts,
        evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: nowIso }),
        nowIso,
      })

      if (!liveSendActive) {
        if (eligibleFinalized) candidatesCompleted += 1
        eligibleDryRun += 1
        continue
      }

      // Live-send path -- only reachable when REVIEW_REQUESTS_ENABLED=true
      // AND REVIEW_REQUESTS_DRY_RUN=false (committed defaults keep this
      // branch unreachable). claimForSendAttempt() re-verifies
      // solicitation_sent=false atomically, immediately before the POST.
      const sendClaim = await claimForSendAttempt(admin, candidate.id, 'eligible_dry_run', params.workerId, nowIso)
      if (!sendClaim.claimed) {
        // Another worker claimed it between finalize and here -- safe skip.
        // The eligible_dry_run record written above still stands, and it
        // was already confirmed finalized above.
        if (eligibleFinalized) candidatesCompleted += 1
        eligibleDryRun += 1
        continue
      }

      const sendResult: CreateSolicitationResult = await createSolicitationFn(params.accessToken, {
        amazonOrderId: candidate.amazon_order_id,
        marketplaceId: params.marketplaceId,
      })
      const sentAtIso = nowFn().toISOString()

      if (sendResult.ok) {
        const sentFinalized = await recordSendResult(admin, candidate.id, {
          toStatus: 'sent',
          evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: sentAtIso }),
          nowIso: sentAtIso,
        })
        if (sentFinalized) {
          sent += 1
          candidatesCompleted += 1
          console.log(`[review-requests-eligibility] sent (live POST): order=${maskOrderId(candidate.amazon_order_id)}`)
        }
        // If sentFinalized is false, the POST already succeeded on Amazon's
        // side but our own finalize write did not apply (row left in
        // send_claimed, extremely unlikely given claimForSendAttempt() just
        // succeeded uncontested) -- not counted as sent or completed here;
        // out of scope for this fix to add a send_claimed reclaim path.
      } else {
        recordApiError(amazonErrorsByCode, sendResult.statusCode, sendResult.amazonErrorCode)
        const toStatus = classifySendOutcome(sendResult.statusCode, sendResult.amazonErrorCode)
        const finalized = await recordSendResult(admin, candidate.id, {
          toStatus,
          evidence: buildSanitizedEligibilityEvidence({
            actionNames: solResult.actions,
            checkedAt: sentAtIso,
            amazonStatusCode: sendResult.statusCode,
            amazonErrorCode: sendResult.amazonErrorCode,
            sanitizedReason: `HTTP ${sendResult.statusCode}`,
          }),
          errorCode: sendResult.amazonErrorCode,
          errorMessage: `HTTP ${sendResult.statusCode}`,
          nowIso: sentAtIso,
        })
        if (finalized) candidatesCompleted += 1
        if (toStatus === 'failed_terminal') failedTerminal += 1
        else failedRetryable += 1
      }
    } catch (err) {
      failedRetryable += 1
      const message = err instanceof Error ? err.message : 'unknown_error'
      recordApiError(amazonErrorsByCode, 0, `unexpected_error:${message.slice(0, 40)}`)
    }
  }

  const dueBacklogRemaining = await countDueCandidates(admin, {
    workspaceId: params.workspaceId,
    marketplaceId: params.marketplaceId,
    nowIso: nowFn().toISOString(),
  })

  return {
    staleClaimsReclaimed,
    candidatesSelected: candidates.length,
    candidatesCompleted,
    selectedCandidatesRemaining: Math.max(candidates.length - candidatesCompleted, 0),
    dueBacklogRemaining,
    stoppedDueToRuntimeBudget,
    eligibleDryRun,
    notEligibleRetryable,
    sent,
    failedRetryable,
    failedTerminal,
    amazonErrorsByCode,
    durationMs: nowFn().getTime() - startedAt,
    liveSendActive,
  }
}
