import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReportTimeoutMs, DEFAULT_REPORT_TIMEOUT_MS } from '../ads-report-timeout'
import { ADS_REPORT_SOURCES } from '../ads-report-row-mappers'

describe('resolveReportTimeoutMs', () => {
  // The exact regression this round fixed: every Ads report type hit the
  // old 900,000ms (15 min) default with Amazon still PENDING for 2 straight
  // days, while ads_sd_campaign_daily's own 1,500,000ms override kept
  // succeeding. The default now matches that override for all sources.
  test('defaults to 1,500,000ms (25 min) when --report-timeout-ms is not passed', () => {
    assert.equal(resolveReportTimeoutMs(new Map()), 1_500_000)
    assert.equal(DEFAULT_REPORT_TIMEOUT_MS, 1_500_000)
  })

  test('an explicit --report-timeout-ms overrides the default', () => {
    const args = new Map([['report-timeout-ms', '600000']])
    assert.equal(resolveReportTimeoutMs(args), 600_000)
  })
})

describe('ADS_REPORT_SOURCES', () => {
  // The exact gap found 2026-07-28: poll-pending-reports.ts's table map only
  // had the 3 campaign-daily-family sources and silently skipped the 3 SP
  // deep reports, so a timeout on any of them could never self-heal via
  // that recovery path. This asserts recovery covers all 6, not 3.
  test('covers exactly the 6 known Ads sources', () => {
    assert.deepEqual(
      Object.keys(ADS_REPORT_SOURCES).sort(),
      ['ads_advertised_product', 'ads_campaign_daily', 'ads_sb_campaign_daily', 'ads_sd_campaign_daily', 'ads_search_term', 'ads_targeting'],
    )
  })

  test('every source has a non-empty table and batch table', () => {
    for (const [source, info] of Object.entries(ADS_REPORT_SOURCES)) {
      assert.ok(info.table.length > 0, `${source} is missing a table`)
      assert.ok(info.batchTable.length > 0, `${source} is missing a batchTable`)
    }
  })

  test('the 3 SP deep reports carry their kind; the 3 campaign-daily-family sources do not', () => {
    assert.equal(ADS_REPORT_SOURCES.ads_advertised_product.kind, 'advertised_product')
    assert.equal(ADS_REPORT_SOURCES.ads_targeting.kind, 'targeting')
    assert.equal(ADS_REPORT_SOURCES.ads_search_term.kind, 'search_term')
    assert.equal(ADS_REPORT_SOURCES.ads_campaign_daily.kind, null)
    assert.equal(ADS_REPORT_SOURCES.ads_sd_campaign_daily.kind, null)
    assert.equal(ADS_REPORT_SOURCES.ads_sb_campaign_daily.kind, null)
  })
})
