/**
 * Targeted tests for the Review Request Automation permission probe
 * (scripts/probe-review-automation-permissions.ts) and its Solicitations
 * client (src/lib/amazon/spapi-client.ts).
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-automation-permission-probe.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  maskOrderId,
  classifyOrdersAccess,
  classifySolicitationsAccess,
  hasReviewSolicitationAction,
  determineScopesSufficient,
  buildProbeReport,
} from './probe-review-automation-permissions'
import * as spapiClient from '../src/lib/amazon/spapi-client'
import type { ListOrdersResult, SolicitationActionsResult } from '../src/lib/amazon/spapi-client'

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

function fakeOrdersOk(orderIds: string[]): ListOrdersResult {
  return {
    ok: true,
    statusCode: 200,
    orders: orderIds.map(id => ({ amazonOrderId: id, orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null })),
    nextToken: null,
    amazonErrorCode: null,
  }
}

function fakeOrdersFail(statusCode: number, amazonErrorCode: string | null): ListOrdersResult {
  return { ok: false, statusCode, orders: [], nextToken: null, amazonErrorCode }
}

function fakeSolicitationsOk(actions: string[]): SolicitationActionsResult {
  return { ok: true, statusCode: 200, actions, amazonErrorCode: null }
}

function fakeSolicitationsFail(statusCode: number, amazonErrorCode: string | null): SolicitationActionsResult {
  return { ok: false, statusCode, actions: [], amazonErrorCode }
}

// 1. Orders permission success
test('Orders permission success is classified as pass, with the real order count', () => {
  const ordersResult = fakeOrdersOk(['111-1111111-1111111'])
  assert.equal(classifyOrdersAccess(ordersResult.ok), 'pass')

  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: false,
    solicitationsResult: null,
    sampleOrderId: null,
  })
  assert.equal(report.ordersApiAccess, 'pass')
  assert.equal(report.ordersReturned, 1)
})

// 2. Orders permission denied
test('Orders permission denied (403) is classified as fail and scopesSufficient=no', () => {
  const ordersResult = fakeOrdersFail(403, 'Unauthorized')
  assert.equal(classifyOrdersAccess(ordersResult.ok), 'fail')

  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: false,
    solicitationsResult: null,
    sampleOrderId: null,
  })
  assert.equal(report.ordersApiAccess, 'fail')
  assert.equal(report.scopesSufficient, 'no')
  assert.equal(report.postAttempted, false)
  assert.equal(report.solicitationsGetAccess, 'skipped', 'must not attempt Solicitations without an order')
})

// 3. Solicitations GET success
test('Solicitations GET success reports pass and correctly detects the review action', () => {
  const ordersResult = fakeOrdersOk(['111-2222222-2222222'])
  const solicitationsResult = fakeSolicitationsOk(['productReviewAndSellerFeedback'])
  assert.equal(classifySolicitationsAccess(true, solicitationsResult.ok), 'pass')
  assert.equal(hasReviewSolicitationAction(solicitationsResult.actions), true)

  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: true,
    solicitationsResult,
    sampleOrderId: ordersResult.orders[0].amazonOrderId,
  })
  assert.equal(report.solicitationsGetAccess, 'pass')
  assert.equal(report.productReviewAndSellerFeedbackObserved, true)
  assert.equal(report.scopesSufficient, 'yes')
})

// 4. Solicitations GET denied
test('Solicitations GET denied (401) reports fail, scopesSufficient=no, action observed is null (not false)', () => {
  const ordersResult = fakeOrdersOk(['111-3333333-3333333'])
  const solicitationsResult = fakeSolicitationsFail(401, 'Unauthorized')
  assert.equal(classifySolicitationsAccess(true, solicitationsResult.ok), 'fail')

  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: true,
    solicitationsResult,
    sampleOrderId: ordersResult.orders[0].amazonOrderId,
  })
  assert.equal(report.solicitationsGetAccess, 'fail')
  assert.equal(report.scopesSufficient, 'no')
  assert.equal(
    report.productReviewAndSellerFeedbackObserved,
    null,
    'a denied/failed GET must not report false — false would falsely imply we saw the action list',
  )
})

// 5. No order available
test('Orders access succeeds but returns zero orders: Solicitations is skipped, scopesSufficient=uncertain', () => {
  const ordersResult = fakeOrdersOk([])
  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: false,
    solicitationsResult: null,
    sampleOrderId: null,
  })
  assert.equal(report.ordersApiAccess, 'pass')
  assert.equal(report.ordersReturned, 0)
  assert.equal(report.solicitationsGetAccess, 'skipped')
  assert.equal(report.scopesSufficient, 'uncertain', 'proved Orders access but never got to test Solicitations at all')
  assert.equal(report.sampleOrderIdMasked, null)
})

// 6. Confirm the permission probe itself never references the POST/send function
//
// createProductReviewAndSellerFeedbackSolicitation was added later (for the
// separate daily-forward workflow, src/lib/review-requests/daily-run.ts --
// see scripts/test-review-requests-daily.ts for its dedicated safety-gating
// tests), so it now legitimately exists on the SP-API client. What this
// read-only permission probe must still guarantee is that IT never imports,
// calls, or references it.
test('probe-review-automation-permissions.ts never references the Solicitations POST/send function', () => {
  const clientAsRecord = spapiClient as unknown as Record<string, unknown>
  assert.equal(typeof clientAsRecord['createProductReviewAndSellerFeedbackSolicitation'], 'function')

  const probeSource = readFileSync(new URL('./probe-review-automation-permissions.ts', import.meta.url), 'utf8')
  assert.equal(
    probeSource.includes('createProductReviewAndSellerFeedbackSolicitation'),
    false,
    'the permission probe must never reference the send function',
  )
})

// 7. Sensitive data not included in output
test('the report never contains a full, unmasked order id, and has no buyer-PII-shaped fields', () => {
  const fullOrderId = '111-9999999-9999999'
  const ordersResult = fakeOrdersOk([fullOrderId])
  const solicitationsResult = fakeSolicitationsOk(['productReviewAndSellerFeedback'])
  const report = buildProbeReport({
    ordersResult,
    solicitationsAttempted: true,
    solicitationsResult,
    sampleOrderId: fullOrderId,
  })

  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes(fullOrderId), false, 'full order id must never appear in the report')
  assert.equal(report.sampleOrderIdMasked, '***9999')
  assert.equal(report.sampleOrderIdMasked!.length < fullOrderId.length, true)

  const forbiddenKeys = ['buyerName', 'buyerEmail', 'buyerPhone', 'shippingAddress', 'name', 'email', 'phone', 'address']
  for (const key of forbiddenKeys) {
    assert.equal(Object.prototype.hasOwnProperty.call(report, key), false, `report must not contain a "${key}" field`)
  }
})

// 8. maskOrderId edge cases
test('maskOrderId handles empty and short strings safely', () => {
  assert.equal(maskOrderId(''), '')
  assert.equal(maskOrderId('123'), '***123')
})

// 9. determineScopesSufficient: ambiguous/transient errors are uncertain, not yes or no
test('a transient Orders error (e.g. 500/429) is uncertain, not a definite no', () => {
  const result = determineScopesSufficient({
    ordersOk: false,
    ordersStatusCode: 500,
    solicitationsAttempted: false,
    solicitationsOk: null,
    solicitationsStatusCode: null,
  })
  assert.equal(result, 'uncertain')
})

async function main() {
  let failures = 0
  for (const [name, fn] of tests) {
    try {
      fn()
      console.log(`PASS  ${name}`)
    } catch (err) {
      failures += 1
      console.error(`FAIL  ${name}`)
      console.error(err instanceof Error ? err.message : err)
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`)
  if (failures > 0) process.exit(1)
}

void main()
