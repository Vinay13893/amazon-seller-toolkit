/**
 * Targeted tests for the "Cron not configured" false-alarm fix
 * (src/app/api/asins/listings/route.ts: resolveSuggestedAction) --
 * see BRAHMASTRA_MASTER_TRACKER.md sec19.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-cron-status-message-fix.ts
 */
import assert from 'node:assert/strict'
import { resolveSuggestedAction, type CheckerSummaryForAction } from '../src/app/api/asins/listings/route'

const NOW = '2026-07-14T12:00:00.000Z'

function summary(overrides: Partial<CheckerSummaryForAction>): CheckerSummaryForAction {
  return {
    processing: 0,
    queueDueNow: 0,
    queueWaiting: 0,
    queued: 0,
    succeeded: 0,
    rateLimited: 0,
    lastAttemptedAt: null,
    ...overrides,
  }
}

function hoursAgo(h: number): string {
  return new Date(new Date(NOW).getTime() - h * 60 * 60 * 1000).toISOString()
}

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

test('never returns the old "Cron not configured" message under any input, including a healthy due-now queue', () => {
  // This is exactly the scenario that used to false-alarm: a normal backlog
  // (queueDueNow > 0) with nothing processing at this exact instant.
  const result = resolveSuggestedAction(summary({ queueDueNow: 12, lastAttemptedAt: hoursAgo(1) }), NOW)
  assert.notEqual(result, 'Cron not configured — start processor to clear queue')
  assert.ok(result, 'must still return an informative message, not silently null')
})

test('a healthy backlog with recent activity reports queued, not stalled', () => {
  const result = resolveSuggestedAction(summary({ queueDueNow: 451, lastAttemptedAt: hoursAgo(1.5) }), NOW)
  assert.equal(result, 'Checks queued — next automatic run within a few hours')
})

test('activity right at the cron cadence boundary (just under the threshold) is still healthy', () => {
  const result = resolveSuggestedAction(summary({ queueDueNow: 5, lastAttemptedAt: hoursAgo(5.99) }), NOW)
  assert.equal(result, 'Checks queued — next automatic run within a few hours')
})

test('genuinely stale activity (beyond both known cron cadences) is correctly flagged', () => {
  const result = resolveSuggestedAction(summary({ queueDueNow: 5, lastAttemptedAt: hoursAgo(7) }), NOW)
  assert.equal(result, 'No checks have run in over 6h — automation may be stalled')
})

test('a due queue with zero recorded activity ever (lastAttemptedAt null) is flagged, not silently ignored', () => {
  const result = resolveSuggestedAction(summary({ queueDueNow: 3, lastAttemptedAt: null }), NOW)
  assert.equal(result, 'No checks have run in over 6h — automation may be stalled')
})

test('processing active always takes priority, even over a stale queue', () => {
  const result = resolveSuggestedAction(summary({ processing: 2, queueDueNow: 5, lastAttemptedAt: hoursAgo(20) }), NOW)
  assert.equal(result, 'Processing active')
})

test('a deep backlog alone (no staleness) never triggers a false stalled warning', () => {
  // Regression guard for the exact real-world scenario that motivated this
  // fix: hundreds of due jobs is normal given current throughput, not a
  // sign anything is broken.
  const result = resolveSuggestedAction(summary({ queueDueNow: 500, lastAttemptedAt: hoursAgo(0.1) }), NOW)
  assert.notEqual(result, 'No checks have run in over 6h — automation may be stalled')
})

test('pricing cooldown branch is unchanged', () => {
  const result = resolveSuggestedAction(summary({ queueDueNow: 0, rateLimited: 3, queueWaiting: 10 }), NOW)
  assert.equal(result, 'Pricing API cooldown active')
})

test('queue healthy branch is unchanged', () => {
  const result = resolveSuggestedAction(summary({ queued: 0, succeeded: 100 }), NOW)
  assert.equal(result, 'Queue healthy')
})

test('no signal at all returns null, not a fabricated status', () => {
  const result = resolveSuggestedAction(summary({}), NOW)
  assert.equal(result, null)
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
