import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDecisionSignals } from '../ads-agent-signals'
import { acceptedAgentWindow, type CoverageRun } from '../ads-agent-inputs'
import { evaluateAdsTarget } from '../ads-agent-shadow'
const now = new Date('2026-11-24T12:00:00Z')
const rank = { checked_at: '2026-11-24T10:00:00Z', scrape_status: 'success', organic_rank: 8, sponsored_rank: 2 }
const available = { tracking_target_id: 't1', checked_at: rank.checked_at, check_status: 'success', availability_status: 'available', error_code: null }
test('latest blocked check overrides earlier good data, never means unavailable', () => {
  const signals = buildDecisionSignals(true, [rank, { ...rank, checked_at: '2026-11-24T11:00:00Z', scrape_status: 'blocked' }], ['t1'], [available, { ...available, checked_at: '2026-11-24T11:00:00Z', check_status: 'blocked' }], now)
  assert.equal(signals.rankStatus, 'unknown')
  assert.equal(signals.availability, 'unknown')
  assert.equal(signals.bidIncreaseBlocked, true)
})
test('requires full fresh pincode coverage; stale and unmapped signals stay unknown', () => {
  assert.equal(buildDecisionSignals(true, [], ['t1', 't2'], [available], now).availability, 'unknown')
  assert.equal(buildDecisionSignals(true, [], ['t1'], [available], now).availability, 'available')
  assert.equal(buildDecisionSignals(false, [rank], ['t1'], [available], now).availability, 'unknown')
  assert.equal(buildDecisionSignals(true, [], ['t1'], [{ ...available, checked_at: '2026-11-01' }], now).availability, 'unknown')
  assert.equal(buildDecisionSignals(true, [], ['t1'], [{ ...available, availability_status: 'unavailable' }], now).availability, 'unavailable')
})
test('organic improvement tempers high ACOS decrease and retains evidence', () => {
  const signals = buildDecisionSignals(true, [rank, { ...rank, checked_at: '2026-11-23T10:00:00Z', organic_rank: 15 }], ['t1'], [available], now)
  assert.equal(signals.organicTrend, 'improving')
  const result = evaluateAdsTarget({ workspaceId: 'w', profileId: 'p', campaignId: 'c', adGroupId: 'a', entityId: 'k', currentBid: 10, impressions: 100, clicks: 20, spend: 500, purchases: 2, sales: 1000, dataThrough: '2026-11-23', eligibleForAds: null, signals }, { mode: 'shadow', emergencyStop: true, targetAcosPercent: 30, maxBidChangePercent: 10, minimumClicks: 8, minimumSpend: 300, lookbackDays: 14, cooldownHours: 24, maxDataAgeDays: 3 }, now)
  assert.equal(result?.proposedValue, 9.5)
  assert.equal(result?.evidence.executionAllowed, false)
})
const runs: CoverageRun[] = ['ads_targeting', 'ads_advertised_product'].map(source => ({ id: source, source, status: 'success', rows_rejected: 0, date_from: '2026-11-10', date_to: '2026-11-23', started_at: '2026-11-24T02:00:00Z' }))
test('requires full accepted coverage for both sources; later failures and partial runs block', () => {
  assert.equal(acceptedAgentWindow(runs, 14, 3, now)?.from, '2026-11-10')
  assert.equal(acceptedAgentWindow(runs.slice(0, 1), 14, 3, now), null)
  for (const patch of [{ status: 'failed' }, { status: 'running' }, { rows_rejected: 1 }, { date_from: '2026-11-20' }, { date_to: '2026-11-24' }]) {
    const changed = runs.map(r => ({ ...r, ...patch }))
    assert.equal(acceptedAgentWindow(changed, 14, 3, now), null)
  }
  assert.equal(acceptedAgentWindow([...runs, { ...runs[0], id: 'new', status: 'failed', started_at: '2026-11-24T03:00:00Z' }], 14, 3, now), null)
})
