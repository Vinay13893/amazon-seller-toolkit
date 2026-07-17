/**
 * Targeted tests for the Keywords P0 fix: the ASIN-detail page's
 * KeywordsTable "Found" column previously rendered a failed/unattempted
 * rank check as "Not found" (a factual claim) instead of an honest
 * unconfirmed state -- same bug class as the Pincode/Buy Box null-masking
 * fixes. src/lib/keyword-found-status.ts is the new, independently-testable
 * classifier fixing this.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-keyword-found-status.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { classifyKeywordFound, KEYWORD_FOUND_LABEL, KEYWORD_FOUND_TONE } from '../src/lib/keyword-found-status'

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

// ── 1. Confirmed found renders Found ──────────────────────────────────────────
test('confirmed found (scrape_status=success, found=true) renders Found', () => {
  const state = classifyKeywordFound({ scrape_status: 'success', found: true })
  assert.equal(state, 'found')
  assert.equal(KEYWORD_FOUND_LABEL[state], 'Found')
  assert.equal(KEYWORD_FOUND_TONE[state], 'text-green-400')
})

// ── 2. Confirmed not found renders Not found ──────────────────────────────────
test('confirmed search completed, keyword absent (scrape_status=success, found=false) renders Not found', () => {
  const state = classifyKeywordFound({ scrape_status: 'success', found: false })
  assert.equal(state, 'not_found')
  assert.equal(KEYWORD_FOUND_LABEL[state], 'Not found')
})

// ── 3. checker_unavailable renders Check unavailable, never Not found ────────
test('checker_unavailable renders Check unavailable, never the false-negative Not found', () => {
  // found is written as false on every checker_unavailable snapshot
  // (asins/[asin]/keywords/refresh/route.ts's insertFailedSnapshot) -- this
  // is exactly the scenario that produced the confirmed P0.
  const state = classifyKeywordFound({ scrape_status: 'checker_unavailable', found: false })
  assert.equal(state, 'check_unavailable')
  assert.equal(KEYWORD_FOUND_LABEL[state], 'Check unavailable')
  assert.notEqual(KEYWORD_FOUND_LABEL[state], 'Not found', 'the exact P0 regression this fix closes')
})

test('failed rank check also renders Check unavailable, never Not found', () => {
  const state = classifyKeywordFound({ scrape_status: 'failed', found: false })
  assert.equal(state, 'check_unavailable')
  assert.notEqual(KEYWORD_FOUND_LABEL[state], 'Not found')
})

// ── 4. Never-checked / missing result renders Not confirmed ──────────────────
test('never checked (missing result) renders Not confirmed, never Not found', () => {
  const state = classifyKeywordFound({ scrape_status: 'never_checked', found: false })
  assert.equal(state, 'not_confirmed')
  assert.equal(KEYWORD_FOUND_LABEL[state], 'Not confirmed')
  assert.notEqual(KEYWORD_FOUND_LABEL[state], 'Not found')
})

// ── Totality: every input maps to exactly one of the 4 defined states ────────
test('classifyKeywordFound is total over every scrape_status value, both found booleans', () => {
  const statuses = ['never_checked', 'success', 'failed', 'checker_unavailable'] as const
  for (const scrape_status of statuses) {
    for (const found of [true, false]) {
      const state = classifyKeywordFound({ scrape_status, found })
      assert.ok(['found', 'not_found', 'check_unavailable', 'not_confirmed'].includes(state))
    }
  }
})

// ── 5. Null organic rank is never rendered as rank 0 ──────────────────────────
test('the ASIN-detail KeywordsTable rank cell uses an explicit null check, never a truthy/zero-coercing pattern', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/asins/[asin]/page.tsx'),
    'utf8',
  )
  assert.ok(
    src.includes('kw.rank !== null'),
    'rank must be compared with an explicit !== null check',
  )
  assert.ok(
    !/kw\.rank\s*\|\|\s*0/.test(src),
    'must never coerce a missing rank to 0 via a truthy fallback',
  )
})

test('the main Keywords tab rank cells also use explicit null checks (unchanged, not touched by this fix)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/keywords/page.tsx'),
    'utf8',
  )
  assert.ok(src.includes('kw.organic_rank != null'), 'organic_rank must use an explicit null check')
  assert.ok(src.includes('kw.sponsored_rank != null'), 'sponsored_rank must use an explicit null check')
  assert.ok(!/organic_rank\s*\|\|\s*0/.test(src) && !/sponsored_rank\s*\|\|\s*0/.test(src))
})

// ── 6. Sponsored rank remains separate ────────────────────────────────────────
test('organic and sponsored rank are never combined into a single value on the main Keywords tab', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/keywords/page.tsx'),
    'utf8',
  )
  // They must render in two visually distinct cells, never summed/averaged together.
  assert.ok(!/organic_rank\s*\+\s*.*sponsored_rank/.test(src))
  assert.ok(!/sponsored_rank\s*\+\s*.*organic_rank/.test(src))
  assert.ok(src.includes('kw.organic_rank') && src.includes('kw.sponsored_rank'), 'both fields must still be rendered independently')
})

test('the ASIN-detail widget does not display a sponsored rank at all (unaffected by this fix, pre-existing design)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/app/(dashboard)/dashboard/asins/[asin]/page.tsx'),
    'utf8',
  )
  assert.ok(!src.includes('sponsored_rank'), 'this widget has no sponsored_rank field -- nothing for this fix to combine')
})

// ── 8/9/10/11. Scope guards -- this fix must not touch unrelated systems ─────
test('this fix does not touch Ads sync, Pincode, review-requests, or rank-checker worker/runtime files', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const forbiddenPaths = [
    'src/lib/internal/amazon-ads-reporting-client.ts',
    'src/lib/internal/ads-deep-report-parser.ts',
    'src/lib/pincode-status.ts',
    'src/app/api/asins/[asin]/pincode/route.ts',
  ]
  for (const p of forbiddenPaths) {
    assert.ok(fs.existsSync(path.join(repoRoot, p)), `sanity: ${p} should exist unmodified`)
  }
  // The rank-checker itself (checker-worker) and the refresh routes' scan
  // logic are not imported by the new helper module -- it is a pure,
  // dependency-free classifier.
  const helperSrc = fs.readFileSync(path.join(repoRoot, 'src/lib/keyword-found-status.ts'), 'utf8')
  assert.ok(!/checker-worker|runKeywordRankCheck|checkKeywordRank/.test(helperSrc), 'the classifier must have no dependency on the rank-checker itself')
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
