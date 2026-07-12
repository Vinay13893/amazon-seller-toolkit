/**
 * Targeted tests for buildRetryOrFailUpdate()
 * (scripts/process-asin-checker-jobs.ts), the shared payload builder used
 * by the three normal-processing terminal-failure branches in the main
 * claim loop: no active Amazon connection, catalog+pricing both failed,
 * and asin_snapshots insert failed.
 *
 * Root cause this covers (same bug class as reclaimStuckJob, fixed in
 * PR #26): background_jobs.run_after is `timestamptz NOT NULL DEFAULT
 * now()` (migration 034). All three sites previously wrote
 * `run_after: null` on the canRetry=false (max-attempts) path, which
 * Postgres rejects outright. Pure function, no mocking needed.
 *
 * Run:
 *   npx tsx scripts/test-retry-or-fail-update.ts
 */
import assert from 'node:assert/strict'
import { buildRetryOrFailUpdate } from './process-asin-checker-jobs'

const NOW = '2026-07-12T09:00:00.000Z'
const RETRY_AFTER = '2026-07-12T09:30:00.000Z'

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

// ── Site 1: no active Amazon connection for the workspace ──────────────────

test('no-connection path, retries remaining: requeued with a non-null run_after', () => {
  const update = buildRetryOrFailUpdate(true, 'Amazon connection is not active for this workspace.', RETRY_AFTER, NOW)
  assert.equal(update.status, 'queued')
  assert.notEqual(update.run_after, null)
  assert.equal(update.run_after, RETRY_AFTER)
  assert.equal(update.completed_at, null)
})

test('no-connection path, max attempts: failed with run_after left undefined, never null', () => {
  const update = buildRetryOrFailUpdate(false, 'Amazon connection is not active for this workspace.', RETRY_AFTER, NOW)
  assert.equal(update.status, 'failed')
  assert.notEqual(update.run_after, null, 'run_after must never be null (NOT NULL constraint)')
  assert.equal(update.run_after, undefined, 'undefined (key dropped), not null, so the existing value is preserved')
  assert.equal(update.completed_at, NOW)
  assert.equal(update.last_error_safe, 'Amazon connection is not active for this workspace.')
})

// ── Site 2: catalog and pricing both failed ─────────────────────────────────

test('catalog+pricing-failed path, retries remaining: requeued with a non-null run_after', () => {
  const update = buildRetryOrFailUpdate(true, 'amazon_pricing_rate_limited', RETRY_AFTER, NOW)
  assert.equal(update.status, 'queued')
  assert.notEqual(update.run_after, null)
  assert.equal(update.run_after, RETRY_AFTER)
})

test('catalog+pricing-failed path, max attempts: failed with run_after never null', () => {
  const update = buildRetryOrFailUpdate(false, 'amazon_pricing_rate_limited', RETRY_AFTER, NOW)
  assert.equal(update.status, 'failed')
  assert.notEqual(update.run_after, null, 'run_after must never be null (NOT NULL constraint)')
  assert.equal(update.run_after, undefined)
  assert.equal(update.completed_at, NOW)
})

// ── Site 3: asin_snapshots insert failed ────────────────────────────────────

test('snapshot-insert-failed path, retries remaining: requeued with a non-null run_after', () => {
  const update = buildRetryOrFailUpdate(true, 'Snapshot could not be saved.', RETRY_AFTER, NOW)
  assert.equal(update.status, 'queued')
  assert.notEqual(update.run_after, null)
  assert.equal(update.run_after, RETRY_AFTER)
})

test('snapshot-insert-failed path, max attempts: failed with run_after never null', () => {
  const update = buildRetryOrFailUpdate(false, 'Snapshot could not be saved.', RETRY_AFTER, NOW)
  assert.equal(update.status, 'failed')
  assert.notEqual(update.run_after, null, 'run_after must never be null (NOT NULL constraint)')
  assert.equal(update.run_after, undefined)
  assert.equal(update.completed_at, NOW)
  assert.equal(update.last_error_safe, 'Snapshot could not be saved.')
})

function main() {
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

main()
