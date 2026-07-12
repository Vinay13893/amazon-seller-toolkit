// scripts/probe-review-automation-permissions.ts
//
// Read-only permission probe for the Review Request Automation workstream
// (see REVIEW_REQUEST_AUTOMATION_SPEC.md). Proves whether the current
// EasyHOME Amazon connection can access:
//   1. Orders API (GET /orders/v0/orders)
//   2. Solicitations eligibility API (GET /solicitations/v1/orders/{id})
//
// Safety, by construction:
//   - Contains NO Solicitations POST code path. createProductReviewAndSellerFeedbackSolicitation
//     does not exist anywhere in this codebase as of this script.
//   - Never persists any order or eligibility data — this script performs
//     zero writes to any table.
//   - Never prints buyer name/address/phone/email or a raw, unmasked order id.
//   - Fails closed: any ambiguity in the response is reported as
//     scopesSufficient: 'uncertain', never assumed to be 'yes'.
//
// Run:
//   npx tsx scripts/probe-review-automation-permissions.ts [--workspace-id=<uuid>]
//
// Requires the same env vars as the other Amazon-scoped scripts in this repo
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SPAPI_LWA_CLIENT_ID,
// SPAPI_LWA_CLIENT_SECRET, SPAPI_ENCRYPTION_KEY).

import { pathToFileURL } from 'node:url'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import {
  listOrders,
  getSolicitationActionsForOrder,
  type ListOrdersResult,
  type SolicitationActionsResult,
} from '@/lib/amazon/spapi-client'

const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const EASYHOME_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const CREATED_AFTER_DAYS = 3
const MAX_RESULTS_PER_PAGE = 5

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getStrArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = args.find(a => a.startsWith(prefix))
  const value = found ? found.slice(prefix.length).trim() : ''
  return value.length > 0 ? value : null
}

const WORKSPACE_ID = getStrArg('workspace-id') ?? EASYHOME_WORKSPACE_ID

// ── Pure, testable helpers ───────────────────────────────────────────────────

/** Masks an Amazon order id down to its last 4 characters for safe logging. */
export function maskOrderId(orderId: string): string {
  if (!orderId) return ''
  return `***${orderId.slice(-4)}`
}

export type AccessResult = 'pass' | 'fail' | 'skipped'

export function classifyOrdersAccess(ok: boolean): 'pass' | 'fail' {
  return ok ? 'pass' : 'fail'
}

export function classifySolicitationsAccess(attempted: boolean, ok: boolean | null): AccessResult {
  if (!attempted || ok === null) return 'skipped'
  return ok ? 'pass' : 'fail'
}

export function hasReviewSolicitationAction(actions: string[]): boolean {
  return actions.includes('productReviewAndSellerFeedback')
}

/**
 * Fails closed: only returns 'yes' when both calls unambiguously succeeded.
 * A definite 401/403 on either call returns 'no'. Everything else
 * (transient errors, no order available to test with, etc.) returns
 * 'uncertain' rather than guessing.
 */
export function determineScopesSufficient(input: {
  ordersOk: boolean
  ordersStatusCode: number | null
  solicitationsAttempted: boolean
  solicitationsOk: boolean | null
  solicitationsStatusCode: number | null
}): 'yes' | 'no' | 'uncertain' {
  if (!input.ordersOk) {
    if (input.ordersStatusCode === 401 || input.ordersStatusCode === 403) return 'no'
    return 'uncertain'
  }
  if (!input.solicitationsAttempted || input.solicitationsOk === null) return 'uncertain'
  if (input.solicitationsOk) return 'yes'
  if (input.solicitationsStatusCode === 401 || input.solicitationsStatusCode === 403) return 'no'
  return 'uncertain'
}

function safeErrorSummary(statusCode: number | null, amazonErrorCode: string | null): string | null {
  if (statusCode === null) return null
  return amazonErrorCode ? `HTTP ${statusCode} (${amazonErrorCode})` : `HTTP ${statusCode}`
}

export interface ProbeReport {
  ordersApiAccess: 'pass' | 'fail'
  ordersReturned: number
  solicitationsGetAccess: AccessResult
  productReviewAndSellerFeedbackObserved: boolean | null
  sanitizedError: string | null
  scopesSufficient: 'yes' | 'no' | 'uncertain'
  postAttempted: false
  sampleOrderIdMasked: string | null
}

/**
 * Assembles the final sanitized report from raw probe results. This is the
 * single place that decides what is safe to print — no caller should build
 * a report object by hand.
 */
export function buildProbeReport(input: {
  ordersResult: ListOrdersResult
  solicitationsAttempted: boolean
  solicitationsResult: SolicitationActionsResult | null
  sampleOrderId: string | null
}): ProbeReport {
  const { ordersResult, solicitationsAttempted, solicitationsResult, sampleOrderId } = input

  const ordersApiAccess = classifyOrdersAccess(ordersResult.ok)
  const solicitationsGetAccess = classifySolicitationsAccess(
    solicitationsAttempted,
    solicitationsResult ? solicitationsResult.ok : null,
  )

  const productReviewAndSellerFeedbackObserved =
    solicitationsResult && solicitationsResult.ok
      ? hasReviewSolicitationAction(solicitationsResult.actions)
      : null

  const sanitizedError =
    safeErrorSummary(
      ordersResult.ok ? null : ordersResult.statusCode,
      ordersResult.ok ? null : ordersResult.amazonErrorCode,
    ) ??
    safeErrorSummary(
      solicitationsResult && !solicitationsResult.ok ? solicitationsResult.statusCode : null,
      solicitationsResult && !solicitationsResult.ok ? solicitationsResult.amazonErrorCode : null,
    )

  const scopesSufficient = determineScopesSufficient({
    ordersOk: ordersResult.ok,
    ordersStatusCode: ordersResult.ok ? null : ordersResult.statusCode,
    solicitationsAttempted,
    solicitationsOk: solicitationsResult ? solicitationsResult.ok : null,
    solicitationsStatusCode: solicitationsResult && !solicitationsResult.ok ? solicitationsResult.statusCode : null,
  })

  return {
    ordersApiAccess,
    ordersReturned: ordersResult.ok ? ordersResult.orders.length : 0,
    solicitationsGetAccess,
    productReviewAndSellerFeedbackObserved,
    sanitizedError,
    scopesSufficient,
    postAttempted: false,
    sampleOrderIdMasked: sampleOrderId ? maskOrderId(sampleOrderId) : null,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Lazily created inside main() (not at module load) so this file can be
// imported for its exported pure helpers (for testing) without requiring
// live Supabase/Amazon credentials.

async function main() {
  const admin = createAdminClient()

  console.log('[probe] Review automation permission probe — workspace:', WORKSPACE_ID)

  const connection = await loadWorkspaceConnection(admin, WORKSPACE_ID)
  if (!connection) {
    const report = buildProbeReport({
      ordersResult: { ok: false, statusCode: 0, orders: [], nextToken: null, amazonErrorCode: 'no_active_connection' },
      solicitationsAttempted: false,
      solicitationsResult: null,
      sampleOrderId: null,
    })
    console.log('[probe] No active Amazon connection for this workspace — stopping.')
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  const marketplaceId = connection.marketplaceId ?? EASYHOME_MARKETPLACE_ID
  const createdAfter = new Date(Date.now() - CREATED_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const ordersResult = await listOrders(connection.accessToken, {
    marketplaceId,
    createdAfter,
    maxResultsPerPage: MAX_RESULTS_PER_PAGE,
  })

  let solicitationsAttempted = false
  let solicitationsResult: SolicitationActionsResult | null = null
  let sampleOrderId: string | null = null

  if (ordersResult.ok && ordersResult.orders.length > 0) {
    sampleOrderId = ordersResult.orders[0].amazonOrderId
    solicitationsAttempted = true
    solicitationsResult = await getSolicitationActionsForOrder(connection.accessToken, {
      amazonOrderId: sampleOrderId,
      marketplaceId,
    })
  }

  const report = buildProbeReport({ ordersResult, solicitationsAttempted, solicitationsResult, sampleOrderId })

  console.log(JSON.stringify(report, null, 2))
  process.exit(report.scopesSufficient === 'yes' ? 0 : 1)
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main().catch(err => {
    console.error('[probe] Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
