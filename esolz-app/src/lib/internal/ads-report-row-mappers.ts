// Row-shape mappers shared by scripts/sync-ads-reports.ts and
// scripts/poll-pending-reports.ts -- both scripts need to turn a parsed
// report record into the exact row shape their destination table expects.
// Extracted 2026-07-28 (previously duplicated verbatim in both scripts,
// and poll-pending-reports.ts was missing the deep-report variant entirely
// -- see ADS_REPORT_SOURCES below) so both scripts stay byte-identical by
// construction and the mapping itself is covered by a real test.
import type { AdsCampaignDailyRecord } from './ads-campaign-daily-parser'
import type { DeepReportKind, DeepReportRecord } from './ads-deep-report-parser'

export function campaignDailyRowFor(record: AdsCampaignDailyRecord, workspaceId: string, profileId: string, batchId: string) {
  return {
    workspace_id: workspaceId,
    profile_id: profileId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    campaign_type: record.campaignType,
    targeting_type: record.targetingType,
    portfolio_name: record.portfolioName,
    ad_group_name: record.adGroupName,
    targeting: record.targeting,
    match_type: record.matchType,
    advertised_sku: record.advertisedSku,
    advertised_asin: record.advertisedAsin,
    search_term: record.searchTerm,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: record.easyhomePortfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'ads_api_auto',
  }
}

export function deepReportRowFor(record: DeepReportRecord, kind: DeepReportKind, workspaceId: string, profileId: string, batchId: string, portfolio: string) {
  const base = {
    workspace_id: workspaceId,
    profile_id: profileId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    ad_group_name: record.adGroupName,
    ad_group_id: record.adGroupId,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    units: record.units,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: portfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'ads_api_auto',
  }
  if (kind === 'advertised_product') return { ...base, advertised_asin: record.advertisedAsin, advertised_sku: record.advertisedSku }
  if (kind === 'targeting') {
    return {
      ...base,
      targeting: record.targeting,
      keyword: record.keyword,
      keyword_type: record.keywordType,
      keyword_id: record.keywordId,
      keyword_bid: record.keywordBid,
      match_type: record.matchType,
    }
  }
  return { ...base, search_term: record.searchTerm, targeting: record.targeting }
}

// Every Ads source's table/batch-table/report-kind, in one place, so a test
// can assert all 6 sources are covered by the recovery script -- the exact
// gap found 2026-07-28: poll-pending-reports.ts's SOURCE_TO_TABLE map only
// had the 3 campaign-daily-family sources and silently skipped the 3 SP
// deep reports (ads_advertised_product/ads_targeting/ads_search_term),
// meaning a timeout on any of them could never self-heal via that recovery
// path even though Amazon kept generating the report in the background.
export const ADS_REPORT_SOURCES: Record<string, { table: string; batchTable: string; kind: DeepReportKind | null }> = {
  ads_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  ads_sd_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  ads_sb_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  ads_advertised_product: { table: 'internal_ads_advertised_product_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'advertised_product' },
  ads_targeting: { table: 'internal_ads_targeting_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'targeting' },
  ads_search_term: { table: 'internal_ads_search_term_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'search_term' },
}
