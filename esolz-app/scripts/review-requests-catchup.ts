// scripts/review-requests-catchup.ts
//
// One-time, last-30-days-only catch-up for the Amazon India EasyHOME Review
// Request Automation workstream (see REVIEW_REQUEST_AUTOMATION_SPEC.md).
// Fetches recent orders, upserts them into review_solicitation_orders,
// checks Solicitations eligibility (GET only) for a batch of due rows, and
// records the result. DRY-RUN ONLY -- see the safety notes below.
//
// Safety, by construction, not by config flag:
//   - This script contains NO Solicitations POST/send code path. The SP-API
//     client's send function (added for the separate eligibility-processor
//     workflow, src/lib/review-requests/eligibility-processor.ts) is never
//     imported or referenced anywhere in this file -- see
//     scripts/test-review-requests.ts for the test enforcing that.
//   - REVIEW_REQUESTS_ENABLED and REVIEW_REQUESTS_DRY_RUN have ZERO effect
//     on whether this script can send anything -- it structurally cannot,
//     regardless of their value. They exist only for a future PR that adds
//     real sending logic. This script warns (but does not fail) if it finds
//     REVIEW_REQUESTS_ENABLED=true set, since that expectation would be
//     wrong for this script specifically.
//   - The 30-day catch-up window is hard-capped in code (see CATCHUP_DAYS
//     below) -- REVIEW_REQUESTS_CATCHUP_DAYS can lower it but never raise it
//     past 30, regardless of env misconfiguration. Per product decision:
//     no 120-day backfill, ever.
//   - Never persists a raw Orders/Solicitations API payload -- only the
//     sanitized shape from policy.ts's buildSanitizedEligibilityEvidence().
//   - Never logs a full, unmasked order id.
//
// Run:
//   npx tsx scripts/review-requests-catchup.ts [--workspace-id=<uuid>]
//
// Requires the same env vars as scripts/probe-review-automation-permissions.ts.

import { pathToFileURL } from 'node:url'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import {
  listOrders,
  getSolicitationActionsForOrder,
  type ListOrdersResult,
  type SolicitationActionsResult,
} from '@/lib/amazon/spapi-client'
import {
  upsertDiscoveredOrder,
  findDueCandidates,
  claimForEligibilityCheck,
  recordEligibilityResult,
} from '@/lib/review-requests/repository'
import {
  classifyEligibilityOutcome,
  classifySolicitationsError,
  buildSanitizedEligibilityEvidence,
} from '@/lib/review-requests/policy'

const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const PRODUCT_REVIEW_ACTION_NAME = 'productReviewAndSellerFeedback'

// Hard ceiling -- REVIEW_REQUESTS_CATCHUP_DAYS may lower this, never raise it.
const MAX_CATCHUP_DAYS = 30
const DEFAULT_CATCHUP_DAYS = 30
const DEFAULT_BATCH_SIZE = 300
const DEFAULT_RATE_LIMIT_MS = 1100
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const ORDERS_PAGE_SIZE = 100
// Safety cap on pagination -- prevents an unbounded loop if Amazon ever
// returned a NextToken indefinitely. 30 days of EasyHOME order volume is
// nowhere near 50 pages at 100/page; this is a defensive ceiling, not an
// expected limit.
const MAX_ORDERS_PAGES = 50

// ── CLI args / env ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getStrArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = args.find(a => a.startsWith(prefix))
  const value = found ? found.slice(prefix.length).trim() : ''
  return value.length > 0 ? value : null
}

function parseIntEnv(name: string, defaultVal: number): number {
  const raw = process.env[name]
  if (!raw) return defaultVal
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultVal
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Report shape (Part D) ────────────────────────────────────────────────────

export interface DryRunReport {
  fetchWindowDays: number
  fetchWindowStart: string
  fetchWindowEnd: string
  ordersApiPagesFetched: number
  ordersReceived: number
  ordersInserted: number
  ordersUpdated: number
  candidatesChecked: number
  eligibleDryRun: number
  tooEarly: number
  notEligibleRetryable: number
  expired: number
  alreadySolicited: number
  ineligibleTerminal: number
  failedRetryable: number
  failedTerminal: number
  skippedTerminal: number
  skippedAlreadySent: number
  apiErrorsByCode: Record<string, number>
  elapsedMs: number
  estimatedApiCalls: number
  postAttempted: false
  reviewRequestsSent: 0
}

function recordApiError(bucket: Record<string, number>, statusCode: number, amazonErrorCode: string | null) {
  const key = amazonErrorCode ?? `HTTP_${statusCode}`
  bucket[key] = (bucket[key] ?? 0) + 1
}

// ── Testable core (no CLI/env parsing, no live admin-client creation) ────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any

export interface RunCatchupDeps {
  admin: AdminClient
  listOrdersFn: typeof listOrders
  getSolicitationFn: typeof getSolicitationActionsForOrder
  sleepFn: (ms: number) => Promise<void>
  nowFn: () => Date
}

export interface RunCatchupParams {
  workspaceId: string
  marketplaceId: string
  accessToken: string
  catchupDays: number
  batchSize: number
  rateLimitMs: number
  maxPages?: number
}

export async function runCatchup(deps: RunCatchupDeps, params: RunCatchupParams): Promise<DryRunReport> {
  const { admin, listOrdersFn, getSolicitationFn, sleepFn, nowFn } = deps
  const startedAt = nowFn().getTime()

  // Hard clamp: never exceed MAX_CATCHUP_DAYS regardless of what was passed in.
  const effectiveDays = Math.min(Math.max(params.catchupDays, 1), MAX_CATCHUP_DAYS)
  const windowEnd = new Date(startedAt)
  const windowStart = new Date(startedAt - effectiveDays * 24 * 60 * 60 * 1000)
  const createdAfter = windowStart.toISOString()

  const apiErrorsByCode: Record<string, number> = {}

  // Phase 1: fetch + upsert orders (paginated).
  let nextToken: string | undefined
  let pagesFetched = 0
  let ordersReceived = 0
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
      recordApiError(apiErrorsByCode, page.statusCode, page.amazonErrorCode)
      break
    }

    ordersReceived += page.orders.length
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

  // Phase 2: eligibility checks on due candidates (dry-run only -- never POSTs).
  const candidates = await findDueCandidates(admin, {
    workspaceId: params.workspaceId,
    marketplaceId: params.marketplaceId,
    limit: params.batchSize,
    nowIso: nowFn().toISOString(),
  })

  let candidatesChecked = 0
  let eligibleDryRun = 0
  const tooEarly = 0
  let notEligibleRetryable = 0
  const expired = 0
  const alreadySolicited = 0
  const ineligibleTerminal = 0
  let failedRetryable = 0
  const failedTerminal = 0
  let skippedTerminal = 0
  let skippedAlreadySent = 0
  let estimatedApiCalls = pagesFetched

  for (const candidate of candidates) {
    const claim = await claimForEligibilityCheck(admin, candidate.id, candidate.solicitation_status)
    if (!claim.claimed) {
      // Row moved out from under us between selection and claim (race).
      // Re-check its current state to bucket the skip correctly; this path
      // is expected to be rare/zero while only one sequential script runs,
      // and exists mainly for when a future concurrent daily job exists.
      const current = await admin
        .from('review_solicitation_orders')
        .select('solicitation_sent, solicitation_status')
        .eq('id', candidate.id)
        .maybeSingle()
      if (current?.data?.solicitation_sent) skippedAlreadySent += 1
      else skippedTerminal += 1
      continue
    }

    await sleepFn(params.rateLimitMs)
    const solResult: SolicitationActionsResult = await getSolicitationFn(params.accessToken, {
      amazonOrderId: candidate.amazon_order_id,
      marketplaceId: params.marketplaceId,
    })
    estimatedApiCalls += 1
    candidatesChecked += 1

    const nowIso = nowFn().toISOString()
    const newCheckAttempts = (claim.previousCheckAttempts ?? 0) + 1

    if (!solResult.ok) {
      recordApiError(apiErrorsByCode, solResult.statusCode, solResult.amazonErrorCode)
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
    const toStatus = classifyEligibilityOutcome(actionsPresent)
    const evidence = buildSanitizedEligibilityEvidence({ actionNames: solResult.actions, checkedAt: nowIso })
    await recordEligibilityResult(admin, candidate.id, {
      toStatus,
      checkAttempts: newCheckAttempts,
      evidence,
      nowIso,
    })

    if (toStatus === 'eligible_dry_run') {
      eligibleDryRun += 1
      console.log(`[review-requests-catchup] would-send (dry-run only, no POST): order=${maskOrderId(candidate.amazon_order_id)}`)
    } else {
      notEligibleRetryable += 1
    }
  }

  return {
    fetchWindowDays: effectiveDays,
    fetchWindowStart: windowStart.toISOString(),
    fetchWindowEnd: windowEnd.toISOString(),
    ordersApiPagesFetched: pagesFetched,
    ordersReceived,
    ordersInserted,
    ordersUpdated,
    candidatesChecked,
    eligibleDryRun,
    tooEarly,
    notEligibleRetryable,
    expired,
    alreadySolicited,
    ineligibleTerminal,
    failedRetryable,
    failedTerminal,
    skippedTerminal,
    skippedAlreadySent,
    apiErrorsByCode,
    elapsedMs: nowFn().getTime() - startedAt,
    estimatedApiCalls,
    postAttempted: false,
    reviewRequestsSent: 0,
  }
}

export function maskOrderId(orderId: string): string {
  if (!orderId) return ''
  return `***${orderId.slice(-4)}`
}

// ── Main (CLI entrypoint) ────────────────────────────────────────────────────
// Lazily wires real dependencies and calls the testable runCatchup() above.

async function main() {
  const admin = createAdminClient()
  const workspaceId = getStrArg('workspace-id') ?? EASYHOME_WORKSPACE_ID
  const marketplaceId = process.env.REVIEW_REQUESTS_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID
  const catchupDays = parseIntEnv('REVIEW_REQUESTS_CATCHUP_DAYS', DEFAULT_CATCHUP_DAYS)
  const batchSize = parseIntEnv('REVIEW_REQUESTS_BATCH_SIZE', DEFAULT_BATCH_SIZE)
  const rateLimitMs = parseIntEnv('REVIEW_REQUESTS_RATE_LIMIT_MS', DEFAULT_RATE_LIMIT_MS)

  if (process.env.REVIEW_REQUESTS_ENABLED === 'true') {
    console.warn(
      '[review-requests-catchup] REVIEW_REQUESTS_ENABLED=true is set, but this script has no send ' +
      'code path and cannot send anything regardless -- this flag has no effect here.',
    )
  }

  console.log('[review-requests-catchup] Starting dry-run catch-up — workspace:', workspaceId)

  const connection = await loadWorkspaceConnection(admin, workspaceId)
  if (!connection) {
    console.log('[review-requests-catchup] No active Amazon connection for this workspace — stopping.')
    process.exit(1)
  }

  const report = await runCatchup(
    {
      admin,
      listOrdersFn: listOrders,
      getSolicitationFn: getSolicitationActionsForOrder,
      sleepFn: sleep,
      nowFn: () => new Date(),
    },
    {
      workspaceId,
      marketplaceId: connection.marketplaceId ?? marketplaceId,
      accessToken: connection.accessToken,
      catchupDays,
      batchSize,
      rateLimitMs,
    },
  )

  console.log(JSON.stringify(report, null, 2))
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main().catch(err => {
    console.error('[review-requests-catchup] Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
