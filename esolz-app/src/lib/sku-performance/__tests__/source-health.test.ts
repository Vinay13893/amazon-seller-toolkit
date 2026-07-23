import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifySourceHealth } from '../source-health'

const NOW = '2026-07-20T12:00:00Z'

describe('classifySourceHealth', () => {
  test('never-synced source (no date, no run status) is not_configured', () => {
    const result = classifySourceHealth({ latestCompleteDate: null, lastRunStatus: null, lastRunAt: null }, NOW)
    assert.equal(result, 'not_configured')
  })

  test('most recent run failed -> failed, even if an older date exists', () => {
    const result = classifySourceHealth({ latestCompleteDate: '2026-07-19', lastRunStatus: 'failed', lastRunAt: '2026-07-20T00:00:00Z' }, NOW)
    assert.equal(result, 'failed')
  })

  test('recent complete date, non-failed run -> healthy', () => {
    const result = classifySourceHealth({ latestCompleteDate: '2026-07-19', lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z' }, NOW)
    assert.equal(result, 'healthy')
  })

  test('complete date older than the staleness threshold -> stale', () => {
    const result = classifySourceHealth({ latestCompleteDate: '2026-07-01', lastRunStatus: 'success', lastRunAt: '2026-07-01T00:00:00Z' }, NOW)
    assert.equal(result, 'stale')
  })

  test('a full ISO timestamp (catalog last_synced_at) is parsed correctly, not just a plain date', () => {
    const fresh = classifySourceHealth({ latestCompleteDate: '2026-07-20T10:00:00Z', lastRunStatus: null, lastRunAt: null }, NOW)
    assert.equal(fresh, 'healthy')
    const staleTimestamp = classifySourceHealth({ latestCompleteDate: '2026-07-01T10:00:00Z', lastRunStatus: null, lastRunAt: null }, NOW)
    assert.equal(staleTimestamp, 'stale')
  })

  test('run status present but no date at all -> stale, not not_configured (some evidence of an attempt exists)', () => {
    const result = classifySourceHealth({ latestCompleteDate: null, lastRunStatus: 'success', lastRunAt: '2026-07-20T00:00:00Z' }, NOW)
    assert.equal(result, 'stale')
  })
})
