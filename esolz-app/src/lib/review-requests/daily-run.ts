/**
 * src/lib/review-requests/daily-run.ts
 *
 * Daily forward workflow for the Amazon India EasyHOME Review Request
 * Automation (see REVIEW_REQUEST_AUTOMATION_SPEC.md and
 * BRAHMASTRA_MASTER_TRACKER.md sec18). Builds on the PR #34 dry-run
 * catch-up foundation (scripts/review-requests-catchup.ts):
 *
 *   Phase 1: fetch Amazon India shipped orders using a rolling overlap
 *   window (default 3 days) so a failed/delayed run never has a gap --
 *   upsertDiscoveredOrder() is idempotent by (workspace_id, marketplace_id,
 *   amazon_order_id), so re-fetching the same order on every run for 3 days
 *   never creates a duplicate row and never resets an order's solicitation
 *   progress.
 *
 *   Phase 2: for each due candidate, re-run the Solicitations GET eligibility
 *   check (source of truth, never cached/reused across runs), then either:
 *     - record eligible_dry_run and stop (default/dry-run behavior, identical
 *       to the PR #34 catch-up script), or
 *     - when BOTH REVIEW_REQUESTS_ENABLED=true AND REVIEW_REQUESTS_DRY_RUN=
 *       false (params.liveSendEnabled && !params.dryRun -- computed by the
 *       caller, see src/app/api/review-requests/jobs/run/route.ts), attempt
 *       the guarded claimForSendAttempt() -> POST -> recordSendResult() send
 *       path.
 *
 * One candidate's unexpected error never aborts the batch -- each iteration
 * is wrapped in try/catch and counted, not thrown.
 *
 * Never persists a raw Orders/Solicitations API payload, never logs a full
 * unmasked order id, and the returned report contains only sanitized
 * aggregate counts (no order ids, no buyer PII).
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  listOrders,
  getSolicitationActionsForOrder,
  createProductReviewAndSellerFeedbackSolicitation,
  type ListOrdersResult,
  type SolicitationActionsResult,
  type CreateSolicitationResult,
} from '@/lib/amazon/spapi-client'
import {
  upsertDiscoveredOrder,
  findDueCandidates,
  claimForEligibilityCheck,
  recordEligibilityResult,
  claimForSendAttempt,
  recordSendResult,
} from './repository'
import {
  classifyEligibilityOutcome,
  classifySolicitationsError,
  classifySendOutcome,
  buildSanitizedEligibilityEvidence,
} from './policy'

type AdminClient = ReturnType<typeof createAdminClient>

const PRODUCT_REVIEW_ACTION_NAME = 'productReviewAndSellerFeedback'
export const DEFAULT_ROLLING_OVERLAP_DAYS = 3
const ORDERS_PAGE_SIZE = 100
// Safety cap on pagination, same rationale as review-requests-catchup.ts:
// defensive ceiling, not an expected limit at ~100-150 orders/day.
const MAX_ORDERS_PAGES = 50

export interface DailyRunDeps {
  admin: AdminClient
  listOrdersFn: typeof listOrders
  getSolicitationFn: typeof getSolicitationActionsForOrder
  createSolicitationFn: typeof createProductReviewAndSellerFeedbackSolicitation
  sleepFn: (ms: number) => Promise<void>
  nowFn: () => Date
}

export interface DailyRunParams {
  workspaceId: string
  marketplaceId: string
  accessToken: string
  overlapDays: number
  batchSize: number
  rateLimitMs: number
  /** REVIEW_REQUESTS_ENABLED === 'true' */
  liveSendEnabled: boolean
  /** REVIEW_REQUESTS_DRY_RUN !== 'false' (defaults true -- dry-run) */
  dryRun: boolean
  workerId: string
  maxPages?: number
}

export interface DailyRunReport {
  fetchWindowDays: number
  fetchWindowStart: string
  fetchWindowEnd: string
  ordersApiPagesFetched: number
  ordersFetched: number
  ordersInserted: number
  ordersUpdated: number
  duplicatesPrevented: number
  candidatesChecked: number
  eligibleDryRun: number
  notEligibleRetryable: number
  sent: number
  failedRetryable: number
  failedTerminal: number
  amazonErrorsByCode: Record<string, number>
  durationMs: number
  liveSendActive: boolean
}

function recordApiError(bucket: Record<string, number>, statusCode: number, amazonErrorCode: string | null) {
  const key = amazonErrorCode ?? `HTTP_${statusCode}`
  bucket[key] = (bucket[key] ?? 0) + 1
}

function maskOrderId(orderId: string): string {
  if (!orderId) return ''
  return `***${orderId.slice(-4)}`
}

export async function runDailyForward(deps: DailyRunDeps, params: DailyRunParams): Promise<DailyRunReport> {
  const { admin, listOrdersFn, getSolicitationFn, createSolicitationFn, sleepFn, nowFn } = deps
  const startedAt = nowFn().getTime()
  const liveSendActive = params.liveSendEnabled && !params.dryRun

  const overlapDays = Math.max(params.overlapDays, 1)
  const windowEnd = new Date(startedAt)
  const windowStart = new Date(startedAt - overlapDays * 24 * 60 * 60 * 1000)
  const createdAfter = windowStart.toISOString()

  const amazonErrorsByCode: Record<string, number> = {}

  // Phase 1: rolling-overlap order fetch + idempotent upsert.
  let nextToken: string | undefined
  let pagesFetched = 0
  let ordersFetched = 0
  let ordersInserted = 0
  let ordersUpdated = 0

  do {
    const page: ListOrdersResult = await listOrdersFn(params.accessToken, {
      marketplaceId: params.marketplaceId,
      createdAfter,
      maxResultsPerPage: ORDERS_PAGE_SIZE,
      nextToken,
    })
    pagesFetched += 1

    if (!page.ok) {
      recordApiError(amazonErrorsByCode, page.statusCode, page.amazonErrorCode)
      break
    }

    ordersFetched += page.orders.length
    for (const order of page.orders) {
      const result = await upsertDiscoveredOrder(admin, {
        workspaceId: params.workspaceId,
        marketplaceId: params.marketplaceId,
        amazonOrderId: order.amazonOrderId,
        orderStatus: order.orderStatus,
        purchaseDate: order.purchaseDate,
        amazonLastUpdatedAt: order.lastUpdateDate,
      }, nowFn().toISOString())
      if (result.inserted) ordersInserted += 1
      else ordersUpdated += 1
    }

    nextToken = page.nextToken ?? undefined
  } while (nextToken && pagesFetched < (params.maxPages ?? MAX_ORDERS_PAGES))

  // Phase 2: eligibility-check-and-optionally-send due candidates.
  const candidates = await findDueCandidates(admin, {
    workspaceId: params.workspaceId,
    marketplaceId: params.marketplaceId,
    limit: params.batchSize,
    nowIso: nowFn().toISOString(),
  })

  let candidatesChecked = 0
  let eligibleDryRun = 0
  let notEligibleRetryable = 0
  let sent = 0
  let failedRetryable = 0
  let failedTerminal = 0

  for (const candidate of candidates) {
    // One failed order must not abort the batch.
    try {
      const claim = await claimForEligibilityCheck(admin, candidate.id, candidate.solicitation_status)
      if (!claim.claimed) continue // lost a claim race to another worker -- safe skip, not an error

      await sleepFn(params.rateLimitMs)
      const solResult: SolicitationActionsResult = await getSolicitationFn(params.accessToken, {
        amazonOrderId: candidate.amazon_order_id,
        marketplaceId: params.marketplaceId,
      })
      candidatesChecked += 1
      const nowIso = nowFn().toISOString()
      const newCheckAttempts = (claim.previousCheckAttempts ?? 0) + 1

      if (!solResult.ok) {
        recordApiError(amazonErrorsByCode, solResult.statusCode, solResult.amazonErrorCode)
        const toStatus = classifySolicitationsError(solResult.statusCode, solResult.amazonErrorCode)
        await recordEligibilityResult(admin, candidate.id, {
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
        failedRetryable += 1
        continue
      }

      const actionsPresent = solResult.actions.includes(PRODUCT_REVIEW_ACTION_NAME)

      if (!actionsPresent) {
        const toStatus = classifyEligibilityOutcome(false)
        await recordEligibilityResult(admin, candidate.id, {
          toStatus,
          checkAttempts: newCheckAttempts,
          evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: nowIso }),
          nowIso,
        })
        notEligibleRetryable += 1
        continue
      }

      // Eligible action present. Record eligible_dry_run first regardless of
      // mode -- this is the historical GET-evidence record and matches PR
      // #34's dry-run behavior exactly when live-send is not active.
      await recordEligibilityResult(admin, candidate.id, {
        toStatus: 'eligible_dry_run',
        checkAttempts: newCheckAttempts,
        evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: nowIso }),
        nowIso,
      })

      if (!liveSendActive) {
        eligibleDryRun += 1
        continue
      }

      // Live-send path -- only reachable when REVIEW_REQUESTS_ENABLED=true
      // AND REVIEW_REQUESTS_DRY_RUN=false (params.liveSendEnabled/dryRun,
      // computed by the caller from env vars; committed defaults keep this
      // branch unreachable). claimForSendAttempt() re-verifies
      // solicitation_sent=false atomically, immediately before the POST.
      const sendClaim = await claimForSendAttempt(admin, candidate.id, 'eligible_dry_run', params.workerId, nowIso)
      if (!sendClaim.claimed) {
        // Another worker claimed it between finalize and here -- safe skip.
        // The eligible_dry_run record written above still stands.
        eligibleDryRun += 1
        continue
      }

      const sendResult: CreateSolicitationResult = await createSolicitationFn(params.accessToken, {
        amazonOrderId: candidate.amazon_order_id,
        marketplaceId: params.marketplaceId,
      })
      const sentAtIso = nowFn().toISOString()

      if (sendResult.ok) {
        await recordSendResult(admin, candidate.id, {
          toStatus: 'sent',
          evidence: buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: sentAtIso }),
          nowIso: sentAtIso,
        })
        sent += 1
        console.log(`[review-requests-daily] sent (live POST): order=${maskOrderId(candidate.amazon_order_id)}`)
      } else {
        recordApiError(amazonErrorsByCode, sendResult.statusCode, sendResult.amazonErrorCode)
        const toStatus = classifySendOutcome(sendResult.statusCode, sendResult.amazonErrorCode)
        await recordSendResult(admin, candidate.id, {
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
        if (toStatus === 'failed_terminal') failedTerminal += 1
        else failedRetryable += 1
      }
    } catch (err) {
      failedRetryable += 1
      const message = err instanceof Error ? err.message : 'unknown_error'
      recordApiError(amazonErrorsByCode, 0, `unexpected_error:${message.slice(0, 40)}`)
    }
  }

  return {
    fetchWindowDays: overlapDays,
    fetchWindowStart: windowStart.toISOString(),
    fetchWindowEnd: windowEnd.toISOString(),
    ordersApiPagesFetched: pagesFetched,
    ordersFetched,
    ordersInserted,
    ordersUpdated,
    duplicatesPrevented: ordersUpdated,
    candidatesChecked,
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
