import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  buildEasyhomeDropDiagnostic,
  type CostMasterInput,
  type PaymentTxnInput,
} from '@/lib/internal/easyhome-drop-diagnostic'
import {
  DEFAULT_RANGE_B,
  minStartDate,
  validateCompareRanges,
  validateRange,
  type AnalysisMode,
  type DateRange,
} from '@/lib/internal/date-range'
import { buildFindingsTable, buildGoodWorkingRows, buildSinglePeriodAbsoluteFindings } from '@/lib/internal/easyhome-findings-table'
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
import { resolveEasyhomePortfolio } from '@/lib/internal/portfolio-labels'
import { resolveSelectedProfileForWorkspace } from '@/lib/internal/brahmastra-selected-profile'
import { computeBlendedMetrics, buildBlendedInsights, type BlendedPeriodMetrics } from '@/lib/internal/easyhome-blended-metrics'

export const runtime = 'nodejs'
export const maxDuration = 60

const PAGE_SIZE = 1000
const MAX_ROWS = 100000

type FreshnessTable = {
  table: string
  latestDate: string | null
}

type DataFreshness = {
  latestAdsDate: string | null
  latestSalesDate: string | null
  latestChangeHistoryDate: string | null
  selectedRangeEnd: string
  // Metric-specific completeness: Ads spend/sales/clicks/ACOS/ROAS only need
  // the Ads report tables; total-sales/blended/order/geo/returns metrics only
  // need payment transactions; change-history context only needs its own
  // table. A lag in one must never hide or zero out metrics that only depend
  // on a different, fully-synced source.
  adsDataIncomplete: boolean
  salesDataIncomplete: boolean
  changeHistoryIncomplete: boolean
  /** @deprecated kept for backward-compat call sites; true if ANY of the above is true. */
  incomplete: boolean
  tables: FreshnessTable[]
}

function parseDateParam(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function dateOnly(value: string | null): string | null {
  return value ? value.slice(0, 10) : null
}

function minDate(values: Array<string | null>): string | null {
  const dates = values.filter((v): v is string => Boolean(v)).sort()
  return dates[0] ?? null
}

function maxDate(values: Array<string | null>): string | null {
  const dates = values.filter((v): v is string => Boolean(v)).sort()
  return dates.at(-1) ?? null
}

function rangeExceedsLatest(rangeA: DateRange, rangeB: DateRange, latestDate: string | null): boolean {
  if (!latestDate) return true
  return rangeA.endDate > latestDate || rangeB.endDate > latestDate
}

export async function GET(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const url = new URL(request.url)
  const params = url.searchParams
  // Default to Single Range mode on the (now equal-length-safe) June-15 window
  // when no query params are supplied at all — never the legacy 14d/9d pair.
  const mode: AnalysisMode = params.get('mode') === 'compare' ? 'compare' : 'single'
  const portfolioFilter = params.get('portfolio')
  const campaignFilter = params.get('campaign')
  const allowUnequalLengths = params.get('allowUnequalLengths') === '1'

  const requestedRangeA: DateRange = {
    startDate: parseDateParam(params.get('aStart')) ?? DEFAULT_RANGE_B.startDate,
    endDate: parseDateParam(params.get('aEnd')) ?? DEFAULT_RANGE_B.endDate,
  }
  const requestedRangeB: DateRange | null = mode === 'compare'
    ? {
      startDate: parseDateParam(params.get('bStart')) ?? DEFAULT_RANGE_B.startDate,
      endDate: parseDateParam(params.get('bEnd')) ?? DEFAULT_RANGE_B.endDate,
    }
    : null

  // Single-range mode analyzes ONLY the user-selected window — no auto-baseline
  // comparison against a previous period (Compare mode exists for that).
  // Internally this still calls the shared before/after diagnostic builders
  // for code reuse, but with rangeA set equal to rangeB, so "before" and
  // "after" are literally the same data: every delta-based comparison signal
  // (spend cut, efficiency collapse, spend stopped, new-vs-baseline, etc.)
  // is mathematically zero and never fires, while absolute/after-only signals
  // (waste spend, high-spend-zero-orders, mapping cleanup, data incomplete)
  // still work correctly as genuine single-period findings.
  const rangeA: DateRange = requestedRangeA
  const rangeB: DateRange = mode === 'single' ? requestedRangeA : (requestedRangeB as DateRange)

  const rangeValidation = mode === 'single'
    ? validateRange(rangeA)
    : allowUnequalLengths
      ? (validateRange(rangeA).valid ? validateRange(rangeB) : validateRange(rangeA))
      : validateCompareRanges(rangeA, rangeB)
  if (!rangeValidation.valid) {
    return NextResponse.json({ error: rangeValidation.error }, { status: 400 })
  }

  const fetchFrom = minStartDate(rangeA, rangeB)

  const supabase = await createClient()

  // Never silently read every profile's rows — Ads tables can carry data for
  // multiple Amazon Ads profiles under the same connection. Block clearly if
  // no single profile is selected/primary for Brahmastra.
  const profileSelection = await resolveSelectedProfileForWorkspace(supabase, workspaceId)
  if (!profileSelection.ok) {
    return NextResponse.json({ error: 'No Amazon Ads profile selected for Brahmastra.' }, { status: 409 })
  }
  const profileId = profileSelection.profileId
  const { data: selectedProfileRow } = await supabase
    .from('amazon_ads_profiles')
    .select('account_name, display_name')
    .eq('workspace_id', workspaceId)
    .eq('profile_id', profileId)
    .maybeSingle()
  const selectedProfileName = (selectedProfileRow?.display_name as string | null) ?? (selectedProfileRow?.account_name as string | null) ?? null

  const transactions: PaymentTxnInput[] = []
  let limitReached = false
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('internal_payment_transactions')
      .select('transaction_date, category, sku, sku_norm, quantity, product_sales, total_amount, order_id')
      .eq('workspace_id', workspaceId)
      .gte('transaction_date', fetchFrom)
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

  // Refunded units aren't exposed by buildEasyhomeDropDiagnostic's account
  // summary, so derive before/after from the same in-memory transactions —
  // no extra query needed.
  function refundedUnitsIn(range: DateRange): number {
    return transactions
      .filter(r => r.category === 'Refund' && r.transactionDate.slice(0, 10) >= range.startDate && r.transactionDate.slice(0, 10) <= range.endDate)
      .reduce((sum, r) => sum + Math.abs(r.quantity ?? 0), 0)
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
      .gte('checked_at', rangeA.startDate)
      .lt('checked_at', rangeB.startDate),
    supabase
      .from('keyword_rank_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('checked_at', rangeB.startDate),
  ])

  const diagnostic = buildEasyhomeDropDiagnostic({
    transactions,
    costMaster,
    rangeA,
    rangeB,
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
      .eq('profile_id', profileId)
      .gte('report_date', fetchFrom)
      .limit(50000)
    for (const row of data ?? []) {
      campaignRows.push({
        reportDate: row.report_date as string,
        campaignName: row.campaign_name as string,
        easyhomePortfolio: resolveEasyhomePortfolio(row.easyhome_portfolio as string, row.campaign_name as string),
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
    .eq('profile_id', profileId)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const campaignDiagnostic = buildEasyhomeAdsCampaignDiagnostic({
    campaignRows,
    rangeA,
    rangeB,
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
      .select('report_date, advertised_sku, advertised_asin, campaign_name, ad_group_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', fetchFrom)
      .limit(50000)
    for (const row of data ?? []) {
      advertisedProductRows.push({
        reportDate: row.report_date as string,
        advertisedSku: (row.advertised_sku as string | null) ?? null,
        advertisedAsin: (row.advertised_asin as string | null) ?? null,
        campaignName: row.campaign_name as string,
        adGroupName: (row.ad_group_name as string | null) ?? null,
        portfolio: resolveEasyhomePortfolio(row.easyhome_portfolio as string, row.advertised_sku as string | null, row.campaign_name as string, row.ad_group_name as string | null),
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
      .select('report_date, keyword, targeting, match_type, campaign_name, ad_group_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', fetchFrom)
      .limit(50000)
    for (const row of data ?? []) {
      targetingRows.push({
        reportDate: row.report_date as string,
        keyword: (row.keyword as string | null) ?? null,
        targeting: (row.targeting as string | null) ?? null,
        matchType: (row.match_type as string | null) ?? null,
        campaignName: row.campaign_name as string,
        adGroupName: (row.ad_group_name as string | null) ?? null,
        portfolio: resolveEasyhomePortfolio(row.easyhome_portfolio as string, row.keyword as string | null, row.targeting as string | null, row.campaign_name as string, row.ad_group_name as string | null),
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
      .select('report_date, search_term, targeting, campaign_name, ad_group_name, easyhome_portfolio, impressions, clicks, spend, purchases, sales')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', fetchFrom)
      .limit(50000)
    for (const row of data ?? []) {
      searchTermRows.push({
        reportDate: row.report_date as string,
        searchTerm: (row.search_term as string | null) ?? null,
        targeting: (row.targeting as string | null) ?? null,
        campaignName: row.campaign_name as string,
        adGroupName: (row.ad_group_name as string | null) ?? null,
        portfolio: resolveEasyhomePortfolio(row.easyhome_portfolio as string, row.search_term as string | null, row.targeting as string | null, row.campaign_name as string, row.ad_group_name as string | null),
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
    .eq('profile_id', profileId)
    .order('uploaded_at', { ascending: false })
    .limit(20)

  const deepDiagnostic = {
    advertisedProduct: advertisedProductRows.length > 0 ? buildAdvertisedProductDiagnostic(advertisedProductRows, rangeA, rangeB) : null,
    targeting: targetingRows.length > 0 ? buildTargetingDiagnostic(targetingRows, rangeA, rangeB) : null,
    searchTerm: searchTermRows.length > 0 ? buildSearchTermDiagnostic(searchTermRows, rangeA, rangeB) : null,
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

  const actionQueueUnfiltered = buildActionQueue({
    advertisedProduct: deepDiagnostic.advertisedProduct,
    targeting: deepDiagnostic.targeting,
    searchTerm: deepDiagnostic.searchTerm,
    campaignTable: campaignDiagnostic.campaignTable,
    campaignsWithSpendUpAndSalesDown: campaignDiagnostic.campaignsWithSpendUpAndSalesDown,
    campaignTopUnmapped: campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns,
    skuTopUnmapped: diagnostic.mappingHealth.topUnmappedSkus,
    existingStatuses,
  })
  // Brahmastra Control Panel portfolio/campaign filters apply across the
  // action queue and everything derived from it (findings, candidates, cases).
  const actionQueue = actionQueueUnfiltered.filter(item =>
    (!portfolioFilter || item.portfolio === portfolioFilter)
    && (!campaignFilter || item.campaignName === campaignFilter),
  )
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
        portfolio: resolveEasyhomePortfolio(row.easyhome_portfolio as string, row.campaign_name as string, row.entity_name as string | null, row.ad_group_name as string | null),
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

  const actionQueueWithChanges = attachRelatedChanges(actionQueue, changeEvents, rangeB)
  const changeHistorySummary = buildChangeHistorySummary(changeEvents, actionQueueWithChanges)

  // --- Phase 1E.4: 30-day archive (day-by-day, coverage, chunk status, correlation) ---
  const changeHistoryDayByDay = buildDayByDayBreakdown(changeEvents, actionQueueWithChanges)
  const changeHistoryArchiveCoverage = buildArchiveCoverage(changeEvents, changeHistoryBatches ?? [])
  const changeHistoryChunkCoverage = buildChunkCoverage(changeHistoryArchiveCoverage.eventsByDay)
  const changeHistoryCorrelationSummary = buildCorrelationSummary(changeEvents, rangeB.startDate)

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

  // --- Phase 2A: Findings & Actions Table + Brahmastra Control Panel metadata ---
  const [
    { data: latestPaymentTxn },
    { data: latestPaymentBatch },
    { data: latestCampaignRow },
    { data: latestAdvertisedProductRow },
    { data: latestTargetingRow },
    { data: latestSearchTermRow },
    { data: latestChangeEvent },
  ] = await Promise.all([
    supabase.from('internal_payment_transactions').select('transaction_date').eq('workspace_id', workspaceId).order('transaction_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_payment_transaction_upload_batches').select('original_filename, accepted_count, rejected_count, inserted_count, updated_count, uploaded_at').eq('workspace_id', workspaceId).order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_ads_campaign_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_ads_advertised_product_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_ads_targeting_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_ads_search_term_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('internal_ads_change_history_events').select('changed_at').eq('workspace_id', workspaceId).order('changed_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  const latestSalesDate = dateOnly((latestPaymentTxn as { transaction_date?: string } | null)?.transaction_date ?? null)
  const latestAdsTables: FreshnessTable[] = [
    { table: 'internal_ads_campaign_daily_rows', latestDate: dateOnly((latestCampaignRow as { report_date?: string } | null)?.report_date ?? null) },
    { table: 'internal_ads_advertised_product_daily_rows', latestDate: dateOnly((latestAdvertisedProductRow as { report_date?: string } | null)?.report_date ?? null) },
    { table: 'internal_ads_targeting_daily_rows', latestDate: dateOnly((latestTargetingRow as { report_date?: string } | null)?.report_date ?? null) },
    { table: 'internal_ads_search_term_daily_rows', latestDate: dateOnly((latestSearchTermRow as { report_date?: string } | null)?.report_date ?? null) },
  ]
  const latestChangeHistoryDate = dateOnly((latestChangeEvent as { changed_at?: string } | null)?.changed_at ?? null)
  const latestAdsDate = minDate(latestAdsTables.map(row => row.latestDate))
  const selectedRangeEnd = maxDate([rangeA.endDate, rangeB.endDate]) ?? rangeB.endDate
  // Each source is checked against its own latest date only — a lag in one
  // (e.g. payment transactions) must never hide or zero out metrics that
  // depend solely on a different, fully-synced source (e.g. Ads reports).
  const adsDataIncomplete = rangeExceedsLatest(rangeA, rangeB, latestAdsDate)
  const salesDataIncomplete = rangeExceedsLatest(rangeA, rangeB, latestSalesDate)
    || diagnostic.accountSummary.before.rowCount === 0
    || diagnostic.accountSummary.after.rowCount === 0
  const changeHistoryIncomplete = rangeExceedsLatest(rangeA, rangeB, latestChangeHistoryDate)
  const dataFreshness: DataFreshness = {
    latestAdsDate,
    latestSalesDate,
    latestChangeHistoryDate,
    selectedRangeEnd,
    adsDataIncomplete,
    salesDataIncomplete,
    changeHistoryIncomplete,
    incomplete: adsDataIncomplete || salesDataIncomplete || changeHistoryIncomplete,
    tables: [
      { table: 'internal_payment_transactions', latestDate: latestSalesDate },
      ...latestAdsTables,
      { table: 'internal_ads_change_history_events', latestDate: latestChangeHistoryDate },
    ],
  }
  // --- Phase R3: blended ROAS / TACOS ---
  // Ad Spend/Ad-attributed Sales here are summed from the Amazon Ads
  // Reporting API tables (campaignDiagnostic.campaignTable) — never the
  // payment-transaction "Ad" fee line items used by accountSummary.adSpend.
  const adTotals = campaignDiagnostic.campaignTable.reduce(
    (acc, row) => {
      acc.beforeSpend += row.beforeSpend
      acc.afterSpend += row.afterSpend
      acc.beforeSales += row.beforeSales
      acc.afterSales += row.afterSales
      return acc
    },
    { beforeSpend: 0, afterSpend: 0, beforeSales: 0, afterSales: 0 },
  )
  const blendedAfter: BlendedPeriodMetrics = computeBlendedMetrics({
    totalSalesNet: diagnostic.accountSummary.after.netSales,
    grossSales: diagnostic.accountSummary.after.netSales + diagnostic.accountSummary.after.refundAmount,
    refunds: diagnostic.accountSummary.after.refundAmount,
    unitsSold: diagnostic.accountSummary.after.unitsOrdered,
    refundedUnits: refundedUnitsIn(rangeB),
    totalOrders: diagnostic.accountSummary.after.orderCount,
    adSpend: adTotals.afterSpend,
    adSales: adTotals.afterSales,
  })
  const blendedBefore: BlendedPeriodMetrics = computeBlendedMetrics({
    totalSalesNet: diagnostic.accountSummary.before.netSales,
    grossSales: diagnostic.accountSummary.before.netSales + diagnostic.accountSummary.before.refundAmount,
    refunds: diagnostic.accountSummary.before.refundAmount,
    unitsSold: diagnostic.accountSummary.before.unitsOrdered,
    refundedUnits: refundedUnitsIn(rangeA),
    totalOrders: diagnostic.accountSummary.before.orderCount,
    adSpend: adTotals.beforeSpend,
    adSales: adTotals.beforeSales,
  })
  // Blended metrics need BOTH sources complete — a lag in either one makes
  // the combined ratio unreliable, even though each source alone is fine.
  const blendedDataComplete = !adsDataIncomplete && !salesDataIncomplete
  const blendedMetrics = {
    mode,
    complete: blendedDataComplete,
    after: blendedAfter,
    before: mode === 'compare' ? blendedBefore : null,
    insights: mode === 'compare' && blendedDataComplete ? buildBlendedInsights(blendedBefore, blendedAfter) : [],
    sourceLabels: {
      totalSales: 'Payment Transactions',
      grossSales: 'Payment Transactions',
      refunds: 'Payment Transactions',
      orders: 'Payment Transactions (distinct order count)',
      adSpend: 'Amazon Ads Reports',
      adSales: 'Amazon Ads Reports',
      blendedRoasTacos: 'Amazon Ads Reports + Payment Transactions',
      organicEstimate: 'Total Sales − Ad-attributed Sales (estimate, not a direct Amazon metric)',
    },
  }

  // Findings and Good Working are built from Ads report tables only — gate
  // them on Ads completeness, not on payment-transaction (sales) lag.
  const findingsTable = buildFindingsTable(actionQueueWithChanges, {
    adsDataIncomplete,
    freshness: { latestAdsDate, latestSalesDate, selectedRangeEnd },
  })
  // Single mode has no baseline, so its problem findings come from absolute
  // thresholds on the selected period alone (High ACOS / Low ROAS / Spend
  // with zero ad sales) rather than the delta-based catalog above, which is
  // naturally near-empty here since rangeA === rangeB.
  if (mode === 'single' && !adsDataIncomplete) {
    findingsTable.push(...buildSinglePeriodAbsoluteFindings({
      campaignRows: campaignDiagnostic.campaignTable,
      advertisedProductRows: deepDiagnostic.advertisedProduct?.table ?? [],
      targetingRows: deepDiagnostic.targeting?.table ?? [],
      searchTermRows: deepDiagnostic.searchTerm?.table ?? [],
    }))
  }
  const goodWorkingRows = adsDataIncomplete ? [] : buildGoodWorkingRows({
    campaignRows: campaignDiagnostic.campaignTable,
    advertisedProductRows: deepDiagnostic.advertisedProduct?.table ?? [],
    targetingRows: deepDiagnostic.targeting?.table ?? [],
    searchTermRows: deepDiagnostic.searchTerm?.table ?? [],
    mode,
  })
  // Single mode: rank by absolute spend/sales (delta-based "top losers" below
  // are meaningless when rangeA === rangeB, since every delta is zero).
  const topSpenders = mode === 'single'
    ? [...campaignDiagnostic.campaignTable].sort((a, b) => b.afterSpend - a.afterSpend).slice(0, 20)
    : []
  const topAdSalesGenerators = mode === 'single'
    ? [...campaignDiagnostic.campaignTable].sort((a, b) => b.afterSales - a.afterSales).slice(0, 20)
    : []

  return NextResponse.json({
    controlPanel: {
      mode,
      selectedProfileId: profileId,
      selectedProfileName,
      rangeA,
      rangeB,
      requestedRangeA,
      portfolioFilter,
      campaignFilter,
      allowUnequalLengths,
      daysInRangeA: diagnostic.accountSummary.before.dayCount,
      daysInRangeB: diagnostic.accountSummary.after.dayCount,
      /** @deprecated use dataFreshness.adsDataIncomplete / salesDataIncomplete instead. */
      dataIncomplete: dataFreshness.incomplete,
      dataFreshness,
    },
    findingsTable,
    goodWorkingRows,
    topSpenders,
    topAdSalesGenerators,
    blendedMetrics,
    diagnostic,
    campaignDiagnostic,
    paymentImportStatus: latestPaymentBatch
      ? {
        lastFileName: (latestPaymentBatch as { original_filename: string }).original_filename,
        acceptedCount: (latestPaymentBatch as { accepted_count: number }).accepted_count,
        rejectedCount: (latestPaymentBatch as { rejected_count: number }).rejected_count,
        insertedCount: (latestPaymentBatch as { inserted_count: number }).inserted_count,
        updatedCount: (latestPaymentBatch as { updated_count: number }).updated_count,
        uploadedAt: (latestPaymentBatch as { uploaded_at: string }).uploaded_at,
      }
      : null,
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
