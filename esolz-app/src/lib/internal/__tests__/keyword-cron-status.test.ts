import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isConfirmedKeywordScan } from '../keyword-cron-status'

test('a complete not-found scan is valid evidence of no rank', () => {
  assert.equal(isConfirmedKeywordScan('not_found'), true)
  assert.equal(isConfirmedKeywordScan('success'), true)
})

test('blocked and failed scans cannot become confirmed rank evidence', () => {
  for (const status of ['blocked', 'failed', 'checker_unavailable', null])
    assert.equal(isConfirmedKeywordScan(status), false)
})
