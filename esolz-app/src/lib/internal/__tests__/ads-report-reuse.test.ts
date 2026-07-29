import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decideReportReuse, SUCCESS_SKIP_MS } from '../ads-report-reuse'

const NOW = new Date('2026-07-28T12:00:00.000Z')

describe('decideReportReuse', () => {
  test('no prior row at all -- nothing to reuse, a fresh report must be requested', () => {
    assert.deepEqual(decideReportReuse(null, NOW), { reuse: false, amazonReportId: null, alreadySucceeded: false })
  })

  test('a prior row with no amazon_report_id -- nothing to reuse (never got far enough to have one)', () => {
    const decision = decideReportReuse({ status: 'failed', amazon_report_id: null, started_at: NOW.toISOString() }, NOW)
    assert.equal(decision.reuse, false)
  })

  // The exact case that matters for this incident: a run that timed out on
  // our side (status: 'failed') but DID get a real amazon_report_id back --
  // this must be reused, not treated as a dead end, so the next attempt
  // (daily sync or poll-pending-reports.ts) picks up Amazon's already-
  // in-flight report instead of submitting a duplicate request.
  test('a timed-out run with an amazon_report_id remains reusable, never a dead end', () => {
    const decision = decideReportReuse({ status: 'failed', amazon_report_id: 'rep-123', started_at: NOW.toISOString() }, NOW)
    assert.equal(decision.reuse, true)
    assert.equal(decision.amazonReportId, 'rep-123')
    assert.equal(decision.alreadySucceeded, false)
  })

  test('a recent success is reused AND marked alreadySucceeded -- caller skips re-importing', () => {
    const decision = decideReportReuse({ status: 'success', amazon_report_id: 'rep-456', started_at: NOW.toISOString() }, NOW)
    assert.equal(decision.reuse, true)
    assert.equal(decision.alreadySucceeded, true)
  })

  test('a success older than SUCCESS_SKIP_MS is reused but NOT marked alreadySucceeded -- caller re-imports', () => {
    const staleStartedAt = new Date(NOW.getTime() - SUCCESS_SKIP_MS - 1000).toISOString()
    const decision = decideReportReuse({ status: 'success', amazon_report_id: 'rep-789', started_at: staleStartedAt }, NOW)
    assert.equal(decision.reuse, true)
    assert.equal(decision.alreadySucceeded, false)
  })

  test('a success exactly at the SUCCESS_SKIP_MS boundary is still treated as recent (inclusive)', () => {
    const boundaryStartedAt = new Date(NOW.getTime() - SUCCESS_SKIP_MS).toISOString()
    const decision = decideReportReuse({ status: 'success', amazon_report_id: 'rep-boundary', started_at: boundaryStartedAt }, NOW)
    assert.equal(decision.alreadySucceeded, true)
  })
})
