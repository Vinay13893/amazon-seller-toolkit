/**
 * Targeted tests for the Pincode Checker P0 correctness fixes:
 * src/lib/pincode-status.ts (shared normalization helper), and source-level
 * regression guards confirming both renderers (ASIN detail page, dashboard
 * Recent Activity) use it instead of a raw truthy/falsy check, and that the
 * worker-routed check route never defaults missing fulfillment to false.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-pincode-status.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyPincodeAvailability,
  getPincodeAvailabilityDisplay,
  classifyFulfillment,
  getFulfillmentDisplay,
} from '../src/lib/pincode-status'

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

// ── 1. Confirmed available renders Available ─────────────────────────────────
test('confirmed available (true) renders Available', () => {
  assert.equal(classifyPincodeAvailability(true, null), 'available')
  assert.equal(getPincodeAvailabilityDisplay(true, null).label, 'Available')
  assert.equal(getPincodeAvailabilityDisplay(true, null).toneClass, 'text-green-400')
})

// ── 2. Confirmed unavailable renders Unavailable ──────────────────────────────
test('confirmed unavailable (false) renders Unavailable', () => {
  assert.equal(classifyPincodeAvailability(false, null), 'unavailable')
  assert.equal(getPincodeAvailabilityDisplay(false, null).label, 'Unavailable')
  assert.equal(getPincodeAvailabilityDisplay(false, null).toneClass, 'text-red-400')
})

// ── 3. Unknown (null, no failure marker) renders Not confirmed ───────────────
test('unknown (null, not a marked failure) renders Not confirmed', () => {
  assert.equal(classifyPincodeAvailability(null, null), 'not_confirmed')
  assert.equal(getPincodeAvailabilityDisplay(null, null).label, 'Not confirmed')
  assert.equal(classifyPincodeAvailability(null, 'Same-Day delivery available'), 'not_confirmed')
  assert.equal(classifyPincodeAvailability(undefined, undefined), 'not_confirmed')
})

// ── 4. Failed check does not render Unavailable ───────────────────────────────
test('a failed check (null + "Check failed:" marker) renders Check failed, never Unavailable', () => {
  const state = classifyPincodeAvailability(null, 'Check failed: checker unavailable')
  assert.equal(state, 'failed')
  assert.notEqual(state, 'unavailable')
  const display = getPincodeAvailabilityDisplay(null, 'Check failed: checker unavailable')
  assert.equal(display.label, 'Check failed')
  assert.notEqual(display.toneClass, 'text-red-400', 'a failed check must not use the confirmed-unavailable red tone')
})

// ── 5. Missing availability does not render Unavailable ──────────────────────
test('missing availability (undefined field, e.g. a row selected without the column) does not render Unavailable', () => {
  const state = classifyPincodeAvailability(undefined, undefined)
  assert.notEqual(state, 'unavailable')
  assert.equal(state, 'not_confirmed')
})

// ── 6. Confirmed FBA renders FBA ──────────────────────────────────────────────
test('confirmed FBA renders an Amazon-fulfilled label', () => {
  assert.equal(classifyFulfillment('FBA'), 'fba')
  assert.match(getFulfillmentDisplay('FBA').label, /FBA/)
})

// ── 7. Confirmed FBM renders FBM ──────────────────────────────────────────────
test('confirmed FBM renders a merchant-fulfilled label', () => {
  assert.equal(classifyFulfillment('FBM'), 'fbm')
  assert.match(getFulfillmentDisplay('FBM').label, /FBM/)
})

// ── 8. Missing fulfillment renders Not confirmed ──────────────────────────────
test('missing/null/unrecognized fulfillment_type renders Not confirmed, never FBM', () => {
  for (const v of [null, undefined, '', 'unknown', 'garbage'] as const) {
    const state = classifyFulfillment(v as string | null | undefined)
    assert.equal(state, 'not_confirmed', `fulfillment_type=${JSON.stringify(v)} must classify as not_confirmed`)
    assert.notEqual(state, 'fbm', `fulfillment_type=${JSON.stringify(v)} must never be guessed as fbm`)
    assert.equal(getFulfillmentDisplay(v as string | null | undefined).label, 'Not confirmed')
  }
})

// ── 9. The worker-routed check route never defaults missing fulfillment to false ─
test('api/asins/[asin]/pincode/route.ts never hardcodes amazon_fulfilled to false for the worker path', () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app/api/asins/[asin]/pincode/route.ts'),
    'utf8',
  )
  assert.ok(
    !/amazon_fulfilled:\s*false/.test(routeSrc),
    'the route must never write a hardcoded amazon_fulfilled: false literal',
  )
  assert.ok(
    /amazon_fulfilled:\s*null/.test(routeSrc),
    'the worker-routed branch must persist null when no fulfillment signal exists',
  )
  assert.ok(
    /result\.amazon_fulfilled === true \? 'FBA' :/.test(routeSrc) || /result\.amazon_fulfilled === true/.test(routeSrc),
    'fulfillment_type must be derived from an explicit === true / === false check, not a truthy check',
  )
  assert.ok(
    !/result\.amazon_fulfilled \? 'FBA' : 'FBM'/.test(routeSrc),
    'the old truthy-check fulfillment mapping must be gone',
  )
})

// ── 10. Dashboard Recent Activity uses the same normalization ────────────────
test('the ASIN detail page and the dashboard both import and use the shared pincode-status helper, not a raw truthy check', () => {
  const asinPageSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/asins/[asin]/page.tsx'),
    'utf8',
  )
  const dashboardSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/page.tsx'),
    'utf8',
  )

  for (const [name, src] of [['ASIN detail page', asinPageSrc], ['dashboard page', dashboardSrc]] as const) {
    assert.ok(
      src.includes("from '@/lib/pincode-status'"),
      `${name} must import the shared pincode-status helper`,
    )
  }

  // The specific buggy patterns from the audit must be gone from both files.
  assert.ok(!/latestCheck\.available \?/.test(asinPageSrc), 'ASIN detail page: raw truthy check on latestCheck.available must be gone')
  assert.ok(!/check\.available \?/.test(asinPageSrc), 'ASIN detail page: raw truthy check on check.available (history table) must be gone')
  assert.ok(!/e\.available \? 'Available/.test(dashboardSrc), 'dashboard: raw truthy check on e.available must be gone')

  // The dashboard's pincode_checks query must select delivery_promise so the
  // shared helper can distinguish "failed" from "not_confirmed" there too.
  assert.ok(
    /pincode_checks[\s\S]{0,40}select\('tracked_asin_id, pincode, available, delivery_promise, checked_at'\)/.test(dashboardSrc),
    'dashboard pincode_checks query must select delivery_promise',
  )
})

// ── Extra: totality -- every input maps to exactly one defined state ─────────
test('classifyPincodeAvailability and classifyFulfillment are total (no input produces an undefined/unhandled state)', () => {
  const availabilityInputs: Array<[boolean | null | undefined, string | null | undefined]> = [
    [true, null], [false, null], [null, null], [null, 'Check failed: x'], [undefined, undefined],
  ]
  for (const [available, msg] of availabilityInputs) {
    const state = classifyPincodeAvailability(available, msg)
    assert.ok(['available', 'unavailable', 'failed', 'not_confirmed'].includes(state))
  }
  for (const v of ['FBA', 'FBM', null, undefined, 'other'] as const) {
    const state = classifyFulfillment(v as string | null | undefined)
    assert.ok(['fba', 'fbm', 'not_confirmed'].includes(state))
  }
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
