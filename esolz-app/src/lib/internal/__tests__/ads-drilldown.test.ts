import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateAdsDrilldown } from '../ads-drilldown'

test('campaign totals combine daily rows and derive ACOS from sums', () => {
  const rows = [
    { campaign_id: 'c1', campaign_name: 'Campaign', impressions: 100, clicks: 10, spend: 20, purchases: 1, sales: 50 },
    { campaign_id: 'c1', campaign_name: 'Campaign', impressions: 50, clicks: 5, spend: 10, purchases: 1, sales: 50 },
  ]
  const [campaign] = aggregateAdsDrilldown(rows, 'campaign')
  assert.equal(campaign.clicks, 15)
  assert.equal(campaign.spend, 30)
  assert.equal(campaign.sales, 100)
  assert.equal(campaign.acosPercent, 30)
})

test('search terms stay separated by campaign and ad group; zero sales is unknown ACOS', () => {
  const rows = [
    { campaign_id: 'c1', campaign_name: 'One', ad_group_id: 'a1', search_term: 'term', impressions: 1, clicks: 1, spend: 5, purchases: 0, sales: 0 },
    { campaign_id: 'c1', campaign_name: 'One', ad_group_id: 'a2', search_term: 'term', impressions: 2, clicks: 1, spend: 2, purchases: 0, sales: 0 },
  ]
  const terms = aggregateAdsDrilldown(rows, 'term')
  assert.equal(terms.length, 2)
  assert.ok(terms.every(term => term.acosPercent === null))
})
