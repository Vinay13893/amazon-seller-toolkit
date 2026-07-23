import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifySourceHealth } from '../source-health'

const NOW = '2026-07-20T12:00:00Z'

describe('classifySourceHealth', () => {
  test('never-synced source (no date, no run status) is not_configured', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: null, lastRunStatus: null, lastRunAt: null, lastRunRowsRejected: null }, NOW)
    assert.equal(result, 'not_configured')
  })

  test('most recent run failed -> failed, even if an older accepted date exists', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'failed', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'failed')
  })

  test('recent accepted-complete date, clean success run -> healthy', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'healthy')
  })

  test('accepted-complete date older than the staleness threshold -> stale', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-01', lastRunStatus: 'success', lastRunAt: '2026-07-01T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'stale')
  })

  test('a full ISO timestamp (catalog last_synced_at) is parsed correctly, not just a plain date', () => {
    const fresh = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-20T10:00:00Z', lastRunStatus: null, lastRunAt: null, lastRunRowsRejected: null }, NOW)
    assert.equal(fresh, 'healthy')
    const staleTimestamp = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-01T10:00:00Z', lastRunStatus: null, lastRunAt: null, lastRunRowsRejected: null }, NOW)
    assert.equal(staleTimestamp, 'stale')
  })

  test('run status present but no accepted date at all -> stale, not not_configured (some evidence of an attempt exists)', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: null, lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'stale')
  })

  // -- Fix 6: conservative status-vocabulary mapping --

  test('partial_success -> stale, never healthy, even with a fresh accepted date from an earlier clean run', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'partial_success', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 4 }, NOW)
    assert.equal(result, 'stale')
  })

  test('running -> stale (no dedicated in_progress state in the existing vocabulary; never healthy mid-run)', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'running', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: null }, NOW)
    assert.equal(result, 'stale')
  })

  test('skipped with a fresh accepted date and no rejected rows -> healthy (skipped only means "already current")', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'skipped', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'healthy')
  })

  test('skipped with a stale accepted date -> stale, not healthy', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-01', lastRunStatus: 'skipped', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'stale')
  })

  test('success with rejected rows -> stale, never healthy, even with a fresh accepted-complete date', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: '2026-07-19', lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 3 }, NOW)
    assert.equal(result, 'stale')
  })

  test('malformed accepted-complete timestamp -> stale, never crashes or reports healthy', () => {
    const result = classifySourceHealth({ latestAcceptedCompleteDate: 'not-a-date', lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z', lastRunRowsRejected: 0 }, NOW)
    assert.equal(result, 'stale')
  })
})
