import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  AFTER_START,
  BEFORE_START,
  buildEasyhomeDropDiagnostic,
  type CostMasterInput,
  type PaymentTxnInput,
} from '@/lib/internal/easyhome-drop-diagnostic'
import {
  buildEasyhomeAdsCampaignDiagnostic,
  type AdsCampaignRowInput,
} from '@/lib/internal/easyhome-ads-campaign-diagnostic'
import {
  buildAdvertisedProductDiagnostic,
  buildSearchTermDiagnostic,
  buildTargetingDiagnostic,
  type AdvertisedProductRowInput,
  type SearchTermRowInput,
  type TargetingRowInput,
} from '@/lib/internal/easyhome-ads-deep-diagnostic'
import {
  buildActionQueue,
  summarizeActionQueue,
  type ActionStatus,
} from '@/lib/internal/easyhome-action-queue'
import {
  attachRelatedChanges,
  buildChangeHistorySummary,
  type ChangeEventInput,
} from '@/lib/internal/easyhome-change-history-diagnostic'
import {
  buildArchiveCoverage,
  buildChunkCoverage,
  buildCorrelationSummary,
  buildDayByDayBreakdown,
} from '@/lib/internal/easyhome-change-history-archive'
import { describeChange } from '@/lib/internal/ads-change-history-parser'
import { buildManualReviewCandidates } from '@/lib/internal/easyhome-manual-review-candidates'
import {
  buildManualReviewCases,
  type CaseReviewFields,
  type CaseReviewStatus,
  type ExpectedMetric,
} from '@/lib/internal/easyhome-manual-review-cases'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

const PAGE_SIZE = 1000
const MAX_ROWS = 100000

export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const supabase = await createClient()

  const transactions: PaymentTxnInput[] = []
  let limitReached = false
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('internal_payment_transactions')
      .select('transaction_date, category, sku, sku_norm, quantity, product_sales, total_amount, order_id')
      .eq('workspace_id', workspaceId)
      .gte('transaction_date', BEFORE_START)
      .order('transaction_date', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      return NextResponse.json(
        { error: 'Transaction data is temporarily unavailable. Confirm migration 033 is applied.' },
        { status: 503 },
      )
    }
    for (const row of data ?? []) {
      transactions.push({
        transactionDate: row.transaction_date as string,
        category: row.category as string,
        sku: (row.sku as string | null) ?? null,
        skuNorm: (row.sku_norm as string | null) ?? null,
        quantity: row.quantity === null ? null : Number(row.quantity),
        productSales: Number(row.product_sales ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
        orderId: (row.order_id as string | null) ?? null,
      })
    }
    if (!data || data.length < PAGE_SIZE) break
    if (offset + PAGE_SIZE >= MAX_ROWS) limitReached = true
  }

  const costMaster: CostMasterInput[] = []
  {
    const { data, error } = await supabase
      .from('internal_sku_cost_master')
      .select('sku_norm, category, product_name')
      .eq('workspace_id', workspaceId)
      .limit(10000)
    if (!error) {
      for (const row of data ?? []) {
        costMaster.push({
          skuNorm: row.sku_norm as string,
          category: (row.category as string | null) ?? null,
          productName: (row.product_name as string | null) ?? null,
        })
      }
    }
  }

  const [{ count: keywordBeforeCount }, { count: keywordAfterCount }] = await Promise.all([
    supabase
      .from('keyword_rank_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('checked_at', BEFORE_START)
      .lt('checked_at', AFTER_START),
    supabase
      .from('keyword_rank_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('checked_at', AFTER_START),
  ])

  const maxDate = transactions.length > 0
    ? transactions.reduce((max, r) => (r.transactionDate > max ? r.transactionDate : max), transactions[0].transactionDate)
    : AFTER_START
  const afterEnd = maxDate.slice(0, 10)

  const diagnostic = buildEasyhomeDropDiagnostic({
    transactions,
    costMaster,
    afterEnd,
    keywordRankCoverage: {
      beforeCount: keywordBeforeCount ?? 0,
      afterCount: keywordAfterCount ?? 0,
    },
  })

  const campaignRows: AdsCampaignRowInput[] = []
  {
    const { data } = await supabase
      .from('internal_ads_campaign_daily_rows')
      .select('report_date, campaign_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .gte('report_date', BEFORE_START)
      .limit(50000)
    for (const row of data ?? []) {
      campaignRows.push({
        reportDate: row.report_date as string,
        campaignName: row.campaign_name as string,
        easyhomePortfolio: row.easyhome_portfolio as string,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        spend: Number(row.spend ?? 0),
        purchases: Number(row.purchases ?? 0),
        sales: Number(row.sales ?? 0),
      })
    }
  }

  const { data: latestCampaignUploadBatch } = await supabase
    .from('internal_ads_campaign_upload_batches')
    .select('original_filename, report_date_start, report_date_end, accepted_count, rejected_count, inserted_count, updated_count, total_spend, total_sales, campaign_count, unmapped_campaign_count, uploaded_at')
    .eq('workspace_id', workspaceId)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const campaignAfterEnd = campaignRows.length > 0
    ? campaignRows.reduce((max, r) => (r.reportDate > max ? r.reportDate : max), campaignRows[0].reportDate)
    : afterEnd

  const campaignDiagnostic = buildEasyhomeAdsCampaignDiagnostic({
    campaignRows,
    afterEnd: campaignAfterEnd,
    actualCategorySales: diagnostic.categoryTable.map(row => ({
      portfolio: row.portfolio,
      beforeSales: row.beforeSales,
      afterSales: row.afterSales,
    })),
    transactionAdSpend: {
      before: diagnostic.accountSummary.before.adSpend,
      after: diagnostic.accountSummary.after.adSpend,
    },
  })

  // --- Phase 1C: deep SP diagnostics (advertised product / targeting / search term) ---
  const advertisedProductRows: AdvertisedProductRowInput[] = []
  {
    const { data } = await supabase
      .from('internal_ads_advertised_product_daily_rows')
      .select('report_date, advertised_sku, advertised_asin, campaign_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .gte('report_date', BEFORE_START)
      .limit(50000)
    for (const row of data ?? []) {
      advertisedProductRows.push({
        reportDate: row.report_date as string,
        advertisedSku: (row.advertised_sku as string | null) ?? null,
        advertisedAsin: (row.advertised_asin as string | null) ?? null,
        campaignName: row.campaign_name as string,
        portfolio: row.easyhome_portfolio as string,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        spend: Number(row.spend ?? 0),
        purchases: Number(row.purchases ?? 0),
        sales: Number(row.sales ?? 0),
      })
    }
  }

  const targetingRows: TargetingRowInput[] = []
  {
    const { data } = await supabase
      .from('internal_ads_targeting_daily_rows')
      .select('report_date, keyword, targeting, match_type, campaign_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .gte('report_date', BEFORE_START)
      .limit(50000)
    for (const row of data ?? []) {
      targetingRows.push({
        reportDate: row.report_date as string,
        keyword: (row.keyword as string | null) ?? null,
        targeting: (row.targeting as string | null) ?? null,
        matchType: (row.match_type as string | null) ?? null,
        campaignName: row.campaign_name as string,
        portfolio: row.easyhome_portfolio as string,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        spend: Number(row.spend ?? 0),
        purchases: Number(row.purchases ?? 0),
        sales: Number(row.sales ?? 0),
      })
    }
  }

  const searchTermRows: SearchTermRowInput[] = []
  {
    const { data } = await supabase
      .from('internal_ads_search_term_daily_rows')
      .select('report_date, search_term, targeting, campaign_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .gte('report_date', BEFORE_START)
      .limit(50000)
    for (const row of data ?? []) {
      searchTermRows.push({
        reportDate: row.report_date as string,
        searchTerm: (row.search_term as string | null) ?? null,
        targeting: (row.targeting as string | null) ?? null,
        campaignName: row.campaign_name as string,
        portfolio: row.easyhome_portfolio as string,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        spend: Number(row.spend ?? 0),
        purchases: Number(row.purchases ?? 0),
        sales: Number(row.sales ?? 0),
      })
    }
  }

  const { data: latestDeepReportBatches } = await supabase
    .from('internal_ads_deep_report_upload_batches')
    .select('report_kind, original_filename, report_date_start, report_date_end, accepted_count, rejected_count, inserted_count, updated_count, total_spend, total_sales, total_purchases, campaign_count, unmapped_count, attribution_window_used, uploaded_at')
    .eq('workspace_id', workspaceId)
    .order('uploaded_at', { ascending: false })
    .limit(20)

  function maxDateOf(rows: Array<{ reportDate: string }>): string {
    return rows.length > 0 ? rows.reduce((max, r) => (r.reportDate > max ? r.reportDate : max), rows[0].reportDate).slice(0, 10) : afterEnd
  }

  const deepDiagnostic = {
    advertisedProduct: advertisedProductRows.length > 0 ? buildAdvertisedProductDiagnostic(advertisedProductRows, maxDateOf(advertisedProductRows)) : null,
    targeting: targetingRows.length > 0 ? buildTargetingDiagnostic(targetingRows, maxDateOf(targetingRows)) : null,
    searchTerm: searchTermRows.length > 0 ? buildSearchTermDiagnostic(searchTermRows, maxDateOf(searchTermRows)) : null,
  }

  // --- Phase 1D: Brahmastra Action Queue ---
  const { data: reviewRows } = await supabase
    .from('internal_ads_brahmastra_action_reviews')
    .select('action_key, status, notes')
    .eq('workspace_id', workspaceId)
    .limit(5000)
  const existingStatuses = new Map<string, { status: ActionStatus; notes: string | null }>()
  for (const row of reviewRows ?? []) {
    existingStatuses.set(row.action_key as string, { status: row.status as ActionStatus, notes: (row.notes as string | null) ?? null })
  }

  const actionQueue = buildActionQueue({
    advertisedProduct: deepDiagnostic.advertisedProduct,
    targeting: deepDiagnostic.targeting,
    searchTerm: deepDiagnostic.searchTerm,
    campaignTable: campaignDiagnostic.campaignTable,
    campaignsWithSpendUpAndSalesDown: campaignDiagnostic.campaignsWithSpendUpAndSalesDown,
    campaignTopUnmapped: campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns,
    skuTopUnmapped: diagnostic.mappingHealth.topUnmappedSkus,
    existingStatuses,
  })
  const actionQueueSummary = summarizeActionQueue(actionQueue)

  // --- Phase 1E.2: manually-imported Change History linkage ---
  const changeEvents: ChangeEventInput[] = []
  {
    const { data } = await supabase
      .from('internal_ads_change_history_events')
      .select('changed_at, change_type, old_value, new_value, is_system_event, event_source_type, event_source_id, entity_name, match_type, campaign_id, campaign_name, ad_group_id, ad_group_name, easyhome_portfolio')
      .eq('workspace_id', workspaceId)
      .order('changed_at', { ascending: true })
      .limit(20000)
    for (const row of data ?? []) {
      changeEvents.push({
        changedAtIso: row.changed_at as string,
        changeType: row.change_type as string,
        oldValue: (row.old_value as string | null) ?? null,
        newValue: (row.new_value as string | null) ?? null,
        description: describeChange(row.change_type as string, (row.old_value as string | null) ?? null, (row.new_value as string | null) ?? null),
        isSystemEvent: Boolean(row.is_system_event),
        eventSourceType: (row.event_source_type as string | null) ?? null,
        eventSourceId: (row.event_source_id as string | null) ?? null,
        entityName: (row.entity_name as string | null) ?? null,
        matchType: (row.match_type as string | null) ?? null,
        campaignId: (row.campaign_id as string | null) ?? null,
        campaignName: (row.campaign_name as string | null) ?? null,
        adGroupId: (row.ad_group_id as string | null) ?? null,
        adGroupName: (row.ad_group_name as string | null) ?? null,
        portfolio: row.easyhome_portfolio as string,
      })
    }
  }

  const { data: changeHistoryBatches } = await supabase
    .from('internal_ads_change_history_import_batches')
    .select('original_filename, from_date, to_date, total_records, imported_count, rejected_count, page_size, page_offset, max_page_number, total_records_reported, inserted_count, updated_count, is_incomplete, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50)
  const latestChangeHistoryBatch = changeHistoryBatches?.[0] ?? null

  const actionQueueWithChanges = attachRelatedChanges(actionQueue, changeEvents, afterEnd)
  const changeHistorySummary = buildChangeHistorySummary(changeEvents, actionQueueWithChanges)

  // --- Phase 1E.4: 30-day archive (day-by-day, coverage, chunk status, correlation) ---
  const changeHistoryDayByDay = buildDayByDayBreakdown(changeEvents, actionQueueWithChanges)
  const changeHistoryArchiveCoverage = buildArchiveCoverage(changeEvents, changeHistoryBatches ?? [])
  const changeHistoryChunkCoverage = buildChunkCoverage(changeHistoryArchiveCoverage.eventsByDay)
  const changeHistoryCorrelationSummary = buildCorrelationSummary(changeEvents, AFTER_START)

  // --- Phase 1F: Manual Review Candidates (ranked change × performance join) ---
  const manualReviewCandidates = buildManualReviewCandidates(actionQueueWithChanges)

  // --- Phase 1G/1H: Grouped Manual Review Cases + Execution Sheet workflow fields ---
  const { data: caseReviewRows } = await supabase
    .from('internal_ads_review_case_reviews')
    .select(`
      case_key, status, owner, decision, reason, next_check_date, notes,
      decision_date, expected_metrics,
      stock_checked, buy_box_checked, coupon_checked, price_checked, reviews_checked,
      delivery_promise_checked, listing_active_checked, live_bid_checked, live_status_checked, live_budget_checked
    `)
    .eq('workspace_id', workspaceId)
    .limit(5000)
  const caseReviewStatuses = new Map<string, CaseReviewFields>()
  for (const row of caseReviewRows ?? []) {
    caseReviewStatuses.set(row.case_key as string, {
      status: row.status as CaseReviewStatus,
      owner: (row.owner as string | null) ?? null,
      decision: (row.decision as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      nextCheckDate: (row.next_check_date as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      decisionDate: (row.decision_date as string | null) ?? null,
      expectedMetrics: (row.expected_metrics as ExpectedMetric[] | null) ?? [],
      stockChecked: Boolean(row.stock_checked),
      buyBoxChecked: Boolean(row.buy_box_checked),
      couponChecked: Boolean(row.coupon_checked),
      priceChecked: Boolean(row.price_checked),
      reviewsChecked: Boolean(row.reviews_checked),
      deliveryPromiseChecked: Boolean(row.delivery_promise_checked),
      listingActiveChecked: Boolean(row.listing_active_checked),
      liveBidChecked: Boolean(row.live_bid_checked),
      liveStatusChecked: Boolean(row.live_status_checked),
      liveBudgetChecked: Boolean(row.live_budget_checked),
    })
  }
  const manualReviewCases = buildManualReviewCases(manualReviewCandidates, caseReviewStatuses)

  return NextResponse.json({
    diagnostic,
    campaignDiagnostic,
    latestCampaignUploadBatch,
    deepDiagnostic,
    latestDeepReportBatches: latestDeepReportBatches ?? [],
    actionQueue: actionQueueWithChanges,
    actionQueueSummary,
    changeHistoryImportStatus: latestChangeHistoryBatch ?? null,
    changeHistoryBatches: changeHistoryBatches ?? [],
    changeHistorySummary,
    changeHistoryEvents: changeEvents,
    changeHistoryDayByDay,
    changeHistoryArchiveCoverage,
    changeHistoryChunkCoverage,
    changeHistoryCorrelationSummary,
    manualReviewCandidates,
    manualReviewCases,
    meta: {
      transactionRowsFetched: transactions.length,
      transactionRowLimitReached: limitReached,
      costMasterRowsFetched: costMaster.length,
      campaignRowsFetched: campaignRows.length,
      advertisedProductRowsFetched: advertisedProductRows.length,
      targetingRowsFetched: targetingRows.length,
      searchTermRowsFetched: searchTermRows.length,
      changeHistoryEventsFetched: changeEvents.length,
    },
  })
}
