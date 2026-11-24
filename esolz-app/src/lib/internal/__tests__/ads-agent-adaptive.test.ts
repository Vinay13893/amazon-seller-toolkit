import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAdaptiveBid, type AdaptiveInput, type WindowMetrics } from '../ads-agent-adaptive'

const metrics = (days: number, overrides: Partial<WindowMetrics> = {}): WindowMetrics => ({
  days, sampleDays: days, impressions: 10_000, clicks: 100, spend: 1_000, purchases: 20, sales: 5_000, ...overrides,
})

const input: AdaptiveInput = {
  currentBid: 20,
  baseline90: metrics(90),
  recent7: metrics(7),
  recent14: metrics(14),
  recent30: metrics(30),
  rank: { organicRank: 12, sponsoredRank: 8, organicRankChange7d: 0 },
  retail: { buyBoxEligible: true, inStock: true, daysOfCover: 45, contributionMarginPercent: 35, returnsRatePercent: 4 },
  targetAcosPercent: 30,
  maxBidChangePercent: 10,
  dataAgeDays: 1,
  attributionMature: true,
  hasConflictingChange: false,
  cooldownComplete: true,
}

describe('evaluateAdaptiveBid', () => {
  test('scales a profitable, stable target with a bounded change', () => {
    const result = evaluateAdaptiveBid(input)
    assert.equal(result.action, 'increase_bid')
    assert.equal(result.state, 'scale')
    assert.ok(result.changePercent <= 10)
  })

  test('repairs high ACOS before considering growth', () => {
    const result = evaluateAdaptiveBid({ ...input, recent14: metrics(14, { spend: 2_000, sales: 3_000 }) })
    assert.equal(result.action, 'decrease_bid')
    assert.equal(result.state, 'repair')
  })

  test('never increases when contribution margin is unavailable', () => {
    const result = evaluateAdaptiveBid({ ...input, retail: { ...input.retail, contributionMarginPercent: null } })
    assert.equal(result.action, 'hold')
    assert.ok(result.blockers.includes('profit_incomplete'))
  })

  test('pauses when the product is out of stock or loses Buy Box eligibility', () => {
    assert.equal(evaluateAdaptiveBid({ ...input, retail: { ...input.retail, inStock: false } }).action, 'pause_target')
    assert.equal(evaluateAdaptiveBid({ ...input, retail: { ...input.retail, buyBoxEligible: false } }).action, 'pause_target')
  })

  test('blocks stale, immature, conflicting and cooldown-limited changes', () => {
    const result = evaluateAdaptiveBid({
      ...input, dataAgeDays: 4, attributionMature: false, hasConflictingChange: true, cooldownComplete: false,
    })
    assert.equal(result.action, 'hold')
    assert.deepEqual(result.blockers, ['stale_data', 'attribution_incomplete', 'cooldown_active', 'conflicting_change'])
  })

  test('holds growth when inventory cover is low', () => {
    const result = evaluateAdaptiveBid({ ...input, retail: { ...input.retail, daysOfCover: 8 } })
    assert.equal(result.action, 'hold')
    assert.equal(result.state, 'harvest')
  })
})
