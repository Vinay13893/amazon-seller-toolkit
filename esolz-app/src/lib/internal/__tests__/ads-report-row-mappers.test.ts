import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { campaignDailyRowFor, deepReportRowFor } from '../ads-report-row-mappers'
import type { AdsCampaignDailyRecord } from '../ads-campaign-daily-parser'
import type { DeepReportRecord } from '../ads-deep-report-parser'

// deepReportRowFor's return type is a union of the 3 kind-specific shapes
// (it's not a discriminated union TS can narrow from the `kind` argument),
// so these tests read fields across the union via an unknown-record cast --
// the assertions themselves are the real type check.
function asRecord(row: object): Record<string, unknown> {
  return row as Record<string, unknown>
}

function campaignRecord(overrides: Partial<AdsCampaignDailyRecord> = {}): AdsCampaignDailyRecord {
  return {
    sourceRowNumber: 1,
    reportDate: '2026-07-27',
    campaignName: 'Campaign A',
    campaignId: 'camp-1',
    campaignStatus: 'enabled',
    campaignType: 'sponsoredProducts',
    targetingType: 'manual',
    portfolioName: null,
    adGroupName: 'Ad Group A',
    targeting: null,
    matchType: null,
    advertisedSku: null,
    advertisedAsin: null,
    searchTerm: null,
    impressions: 100,
    clicks: 5,
    ctr: 0.05,
    spend: 12.5,
    cpc: 2.5,
    purchases: 1,
    sales: 500,
    acos: 0.025,
    roas: 40,
    easyhomePortfolio: 'Home',
    dedupeKey: 'campaign-dedupe-1',
    rawRow: {},
    ...overrides,
  }
}

function deepRecord(overrides: Partial<DeepReportRecord> = {}): DeepReportRecord {
  return {
    sourceRowNumber: 1,
    reportDate: '2026-07-27',
    campaignName: 'Campaign A',
    campaignId: 'camp-1',
    campaignStatus: 'enabled',
    adGroupName: 'Ad Group A',
    adGroupId: 'ag-1',
    advertisedAsin: null,
    advertisedSku: null,
    targeting: null,
    keyword: null,
    keywordType: null,
    keywordId: null,
    keywordBid: null,
    matchType: null,
    searchTerm: null,
    impressions: 100,
    clicks: 5,
    ctr: 0.05,
    spend: 12.5,
    cpc: 2.5,
    purchases: 1,
    sales: 500,
    units: 2,
    acos: 0.025,
    roas: 40,
    easyhomePortfolio: 'Home',
    dedupeKey: 'deep-dedupe-1',
    rawRow: {},
    ...overrides,
  }
}

describe('campaignDailyRowFor', () => {
  test('maps a parsed record into the internal_ads_campaign_daily_rows shape', () => {
    const record = campaignRecord({ spend: 42, dedupeKey: 'k1' })
    const row = campaignDailyRowFor(record, 'ws-1', 'profile-1', 'batch-1')
    assert.equal(row.workspace_id, 'ws-1')
    assert.equal(row.profile_id, 'profile-1')
    assert.equal(row.upload_batch_id, 'batch-1')
    assert.equal(row.spend, 42)
    assert.equal(row.dedupe_key, 'k1')
    assert.equal(row.source, 'ads_api_auto')
  })
})

describe('deepReportRowFor', () => {
  // These 3 kinds are exactly the recovery gap this round closed --
  // poll-pending-reports.ts previously skipped all of them entirely.
  test('advertised_product kind includes advertised ASIN/SKU, omits targeting/keyword fields', () => {
    const record = deepRecord({ advertisedAsin: 'B000TEST', advertisedSku: 'SKU-1', dedupeKey: 'k-ap' })
    const row = asRecord(deepReportRowFor(record, 'advertised_product', 'ws-1', 'profile-1', 'batch-1', 'Home'))
    assert.equal(row.advertised_asin, 'B000TEST')
    assert.equal(row.advertised_sku, 'SKU-1')
    assert.equal(row.dedupe_key, 'k-ap')
    assert.equal('targeting' in row, false)
    assert.equal('keyword' in row, false)
  })

  test('targeting kind includes keyword fields, omits advertised ASIN/SKU', () => {
    const record = deepRecord({
      targeting: 'exact="widget"', keyword: 'widget', keywordType: 'broad',
      keywordId: 'kw-1', keywordBid: 1.5, matchType: 'exact', dedupeKey: 'k-tg',
    })
    const row = asRecord(deepReportRowFor(record, 'targeting', 'ws-1', 'profile-1', 'batch-1', 'Home'))
    assert.equal(row.keyword, 'widget')
    assert.equal(row.keyword_bid, 1.5)
    assert.equal(row.match_type, 'exact')
    assert.equal('advertised_asin' in row, false)
  })

  test('search_term kind includes the search term, omits keyword-specific fields', () => {
    const record = deepRecord({ searchTerm: 'blue widget', targeting: 'exact="widget"', dedupeKey: 'k-st' })
    const row = asRecord(deepReportRowFor(record, 'search_term', 'ws-1', 'profile-1', 'batch-1', 'Home'))
    assert.equal(row.search_term, 'blue widget')
    assert.equal(row.targeting, 'exact="widget"')
    assert.equal('keyword' in row, false)
    assert.equal('advertised_asin' in row, false)
  })

  test('portfolio and batch id are always threaded through regardless of kind', () => {
    const row = asRecord(deepReportRowFor(deepRecord(), 'advertised_product', 'ws-2', 'profile-2', 'batch-2', 'Kitchen'))
    assert.equal(row.workspace_id, 'ws-2')
    assert.equal(row.profile_id, 'profile-2')
    assert.equal(row.upload_batch_id, 'batch-2')
    assert.equal(row.easyhome_portfolio, 'Kitchen')
    assert.equal(row.source, 'ads_api_auto')
  })
})
