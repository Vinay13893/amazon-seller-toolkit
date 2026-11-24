import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdsPlacementRows, placementDailyRowFor } from '../ads-placement-report'

describe('Amazon Ads placement report', () => {
  test('keeps campaign and placement grain separate', () => {
    const result = parseAdsPlacementRows([{
      date: '2026-11-23', campaignId: 'campaign-1', campaignName: 'Campaign',
      placementClassification: 'TOP_OF_SEARCH', impressions: 100, clicks: 7,
      cost: 123.45, purchases1d: 2, sales1d: 800, unitsSoldClicks1d: 2,
      topOfSearchImpressionShare: 0.31,
    }])
    assert.equal(result.rejectedCount, 0)
    assert.equal(result.accepted[0]?.dedupeKey, '2026-11-23|campaign-1|TOP_OF_SEARCH')
    const row = placementDailyRowFor(result.accepted[0], 'workspace-1', 'profile-1')
    assert.equal(row.placement_classification, 'TOP_OF_SEARCH')
    assert.equal(row.spend, 123.45)
  })

  test('rejects rows that cannot be safely identified', () => {
    const result = parseAdsPlacementRows([{ date: '2026-11-23', campaignId: 'campaign-1' }])
    assert.equal(result.accepted.length, 0)
    assert.equal(result.rejectedCount, 1)
  })
})
