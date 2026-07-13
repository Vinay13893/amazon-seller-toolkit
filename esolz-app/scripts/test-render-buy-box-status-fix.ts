/**
 * Targeted tests proving the Render ASIN checker script
 * (scripts/process-asin-checker-jobs.ts) resolves buy_box_status using the
 * same canonical helper as the Vercel write path
 * (src/app/api/asins/jobs/process-next/route.ts, fixed in PR #36) --
 * see BRAHMASTRA_MASTER_TRACKER.md sec19.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-render-buy-box-status-fix.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveBuyBoxStatusToStore } from '../src/lib/amazon/buy-box-status'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDER_SCRIPT_PATH = path.join(__dirname, 'process-asin-checker-jobs.ts')
const VERCEL_ROUTE_PATH = path.join(__dirname, '..', 'src', 'app', 'api', 'asins', 'jobs', 'process-next', 'route.ts')

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

// ── 1. Render rate-limited path stores null ──────────────────────────────────
test('Render: rate-limited/unavailable pricing (no offers result) resolves to null, not "unknown"', () => {
  assert.equal(resolveBuyBoxStatusToStore(undefined), null)
  assert.equal(resolveBuyBoxStatusToStore(null), null)
})

// ── 2. Confirmed won/lost stores normally ────────────────────────────────────
test('Render: won/lost from a real Pricing call still store correctly', () => {
  assert.equal(resolveBuyBoxStatusToStore('won'), 'won')
  assert.equal(resolveBuyBoxStatusToStore('lost'), 'lost')
})

test('Render: a genuine ambiguous result from a successful call is preserved as-is (not over-nulled)', () => {
  assert.equal(resolveBuyBoxStatusToStore('unknown'), 'unknown')
  assert.equal(resolveBuyBoxStatusToStore('no_buybox'), 'no_buybox')
  assert.equal(resolveBuyBoxStatusToStore('partial_success'), 'partial_success')
})

// ── 3. Vercel and Render paths resolve identically ───────────────────────────
// Not just "call the same pure function and assert equal outputs" (which
// would be true even if both files had their own independent copies of an
// identical function) -- this proves, from the actual source text, that
// BOTH files import and call the ONE canonical helper, and that neither one
// still contains its own local reimplementation of the old buggy fallback.

function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

test('both the Render script and the Vercel route import resolveBuyBoxStatusToStore from the shared lib', () => {
  const renderSource = readSource(RENDER_SCRIPT_PATH)
  const vercelSource = readSource(VERCEL_ROUTE_PATH)

  const importPattern = /from ['"]@\/lib\/amazon\/buy-box-status['"]/
  assert.ok(importPattern.test(renderSource), 'Render script must import from src/lib/amazon/buy-box-status')
  assert.ok(importPattern.test(vercelSource), 'Vercel route must import from src/lib/amazon/buy-box-status')

  assert.ok(renderSource.includes('resolveBuyBoxStatusToStore('), 'Render script must call resolveBuyBoxStatusToStore()')
  assert.ok(vercelSource.includes('resolveBuyBoxStatusToStore('), 'Vercel route must call resolveBuyBoxStatusToStore()')
})

test('neither file still writes the old buggy fallback ("?? \'unknown\'") directly into buy_box_status', () => {
  const renderSource = readSource(RENDER_SCRIPT_PATH)
  const vercelSource = readSource(VERCEL_ROUTE_PATH)

  // The old bug was: `const buyBoxStatus = offersResult?.buy_box_status ?? 'unknown'`
  // then `buy_box_status: buyBoxStatus` written directly to the snapshot.
  // After the fix, buy_box_status in the snapshot payload must come from
  // buyBoxStatusToStore (the resolveBuyBoxStatusToStore() result), never a
  // raw `?? 'unknown'` expression.
  const buggyWritePattern = /buy_box_status:\s*buyBoxStatus\b(?!ForAvailability|ToStore)/
  assert.equal(buggyWritePattern.test(renderSource), false, 'Render script must not write the old unfixed buyBoxStatus variable directly')
  assert.equal(buggyWritePattern.test(vercelSource), false, 'Vercel route must not write the old unfixed buyBoxStatus variable directly')

  assert.ok(renderSource.includes('buy_box_status: buyBoxStatusToStore'), 'Render script must write buyBoxStatusToStore')
  assert.ok(vercelSource.includes('buy_box_status: buyBoxStatusToStore'), 'Vercel route must write buyBoxStatusToStore')
})

test('both files still preserve unchanged Availability behavior via a separate buyBoxStatusForAvailability variable', () => {
  const renderSource = readSource(RENDER_SCRIPT_PATH)
  const vercelSource = readSource(VERCEL_ROUTE_PATH)

  assert.ok(renderSource.includes("buyBoxStatusForAvailability = offersResult?.buy_box_status ?? 'unknown'"))
  assert.ok(vercelSource.includes("buyBoxStatusForAvailability = offersResult?.buy_box_status ?? 'unknown'"))
})

// ── 4. Price/BSR untouched by this fix (regression guard) ────────────────────
test('this fix does not touch Price or BSR computation in either file', () => {
  const renderSource = readSource(RENDER_SCRIPT_PATH)
  const vercelSource = readSource(VERCEL_ROUTE_PATH)

  // Both files must still compute livePrice/bsrValue exactly as before --
  // spot-check the untouched expressions are still present verbatim.
  for (const source of [renderSource, vercelSource]) {
    assert.ok(source.includes('offersResult?.buy_box_price ?? offersResult?.your_offer_price ?? null'), 'livePrice logic must be unchanged')
    assert.ok(source.includes('catalogResult?.bsr ?? pricingRankings[0]?.rank ?? null'), 'bsrValue logic must be unchanged')
  }
})

// ── 5. Exhaustive equivalence across every possible input value ──────────────
test('resolveBuyBoxStatusToStore is deterministic and total over every BuyBoxOfferStatus value', () => {
  const allStatuses: Array<'won' | 'lost' | 'unknown' | 'no_buybox' | 'partial_success' | 'failed'> = [
    'won', 'lost', 'unknown', 'no_buybox', 'partial_success', 'failed',
  ]
  for (const status of allStatuses) {
    assert.equal(resolveBuyBoxStatusToStore(status), status, `${status} must pass through unchanged when a real call succeeded`)
  }
  assert.equal(resolveBuyBoxStatusToStore(undefined), null)
  assert.equal(resolveBuyBoxStatusToStore(null), null)
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
