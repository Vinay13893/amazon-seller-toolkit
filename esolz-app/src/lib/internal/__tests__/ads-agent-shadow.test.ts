import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAdsTarget, type AdsAgentSettings, type AdsTargetEvidence } from '../ads-agent-shadow'

const settings: AdsAgentSettings = {
  mode: 'shadow',
  emergencyStop: false,
  targetAcosPercent: 30,
  maxBidChangePercent: 10,
  minimumClicks: 8,
  minimumSpend: 300,
  lookbackDays: 14,
  cooldownHours: 24,
  maxDataAgeDays: 3,
}

const evidence: AdsTargetEvidence = {
  workspaceId: 'workspace-1',
  profileId: 'profile-1',
  campaignId: 'campaign-1',
  adGroupId: 'group-1',
  entityId: 'keyword-1',
  currentBid: 10,
  impressions: 1_000,
  clicks: 10,
  spend: 500,
  purchases: 0,
  sales: 0,
  dataThrough: '2026-11-21',
  eligibleForAds: true,
}

const now = new Date('2026-11-23T08:00:00.000Z')

describe('evaluateAdsTarget', () => {
  test('proposes a capped 10% decrease for proven wasted spend', () => {
    const result = evaluateAdsTarget(evidence, settings, now)
    assert.equal(result?.actionType, 'decrease_bid')
    assert.equal(result?.reasonCode, 'wasted_spend')
    assert.equal(result?.proposedValue, 9)
    assert.equal(result?.changePercent, -10)
  })

  test('proposes a decrease when ACOS is materially above the target', () => {
    const result = evaluateAdsTarget({ ...evidence, purchases: 2, sales: 1_000 }, settings, now)
    assert.equal(result?.reasonCode, 'acos_above_guardrail')
    assert.equal(result?.evidence.acosPercent, 50)
  })

  test('does nothing when evidence is below the minimum', () => {
    assert.equal(evaluateAdsTarget({ ...evidence, clicks: 7 }, settings, now), null)
    assert.equal(evaluateAdsTarget({ ...evidence, spend: 299.99 }, settings, now), null)
  })

  test('rejects stale data and allows shadow analysis with execution stopped', () => {
    assert.equal(evaluateAdsTarget({ ...evidence, dataThrough: '2026-11-19' }, settings, now), null)
    assert.ok(evaluateAdsTarget(evidence, { ...settings, emergencyStop: true }, now))
    assert.equal(evaluateAdsTarget(evidence, { ...settings, mode: 'autopilot' }, now), null)
    assert.equal(evaluateAdsTarget(evidence, { ...settings, mode: 'approval' }, now), null)
  })

  test('refuses an entity without reliable Amazon identifiers or a current bid', () => {
    assert.equal(evaluateAdsTarget({ ...evidence, entityId: '' }, settings, now), null)
    assert.equal(evaluateAdsTarget({ ...evidence, currentBid: 0 }, settings, now), null)
  })

  test('creates a deterministic, tenant-specific action key', () => {
    const first = evaluateAdsTarget(evidence, settings, now)
    const again = evaluateAdsTarget(evidence, settings, now)
    const otherTenant = evaluateAdsTarget({ ...evidence, workspaceId: 'workspace-2' }, settings, now)
    assert.equal(first?.actionKey, again?.actionKey)
    assert.notEqual(first?.actionKey, otherTenant?.actionKey)
  })

  test('flags an ineligible product for pausing without fabricating a new bid', () => {
    const result = evaluateAdsTarget({ ...evidence, clicks: 0, spend: 0, eligibleForAds: false }, settings, now)
    assert.equal(result?.actionType, 'pause_target')
    assert.equal(result?.proposedValue, null)
  })
})

test('rejects malformed dates, metrics and bid increases caused by the minimum bid floor', () => {
  for (const dataThrough of ['bad-date', '2026-11-23', '2026-11-24'])
    assert.equal(evaluateAdsTarget({ ...evidence, dataThrough }, settings, now), null)
  assert.equal(evaluateAdsTarget({ ...evidence, clicks: NaN }, settings, now), null)
  assert.equal(evaluateAdsTarget({ ...evidence, currentBid: 0.01 }, settings, now), null)
  assert.equal(evaluateAdsTarget(evidence, { ...settings, targetAcosPercent: NaN }, now), null)
})
