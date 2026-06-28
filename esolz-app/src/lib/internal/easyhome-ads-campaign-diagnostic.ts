// Phase 0D: campaign-level aggregation built on top of the manually imported
// internal_ads_campaign_daily_rows table. Pure functions — callers fetch rows
// and pass them in. Read-only analytics only.

import { DEFAULT_RANGE_A, DEFAULT_RANGE_B, type DateRange, inWindow as inDateRange } from './date-range'

export type AdsCampaignRowInput = {
  reportDate: string
  campaignName: string
  easyhomePortfolio: string
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
}

type PeriodAgg = { impressions: number; clicks: number; spend: number; purchases: number; sales: number }

function emptyAgg(): PeriodAgg {
  return { impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0 }
}

function addRow(agg: PeriodAgg, row: AdsCampaignRowInput): void {
  agg.impressions += row.impressions
  agg.clicks += row.clicks
  agg.spend += row.spend
  agg.purchases += row.purchases
  agg.sales += row.sales
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function acosOf(spend: number, sales: number): number | null {
  return sales > 0 ? round2((spend / sales) * 100) : null
}

function roasOf(spend: number, sales: number): number | null {
  return spend > 0 ? round2(sales / spend) : null
}

function inWindow(reportDate: string, range: DateRange): boolean {
  return inDateRange(reportDate, range)
}

export type CampaignRow = {
  campaignName: string
  portfolio: string
  beforeSpend: number
  afterSpend: number
  deltaSpend: number
  beforeSales: number
  afterSales: number
  deltaSales: number
  beforeAcos: number | null
  afterAcos: number | null
  beforeRoas: number | null
  afterRoas: number | null
  beforeClicks: number
  afterClicks: number
  beforePurchases: number
  afterPurchases: number
}

export type CampaignMappingHealth = {
  totalCampaignsAnalyzed: number
  mappedCampaignCount: number
  unmappedCampaignCount: number
  unmappedSpend: number
  unmappedSales: number
  topUnmappedCampaigns: Array<{ campaignName: string; totalSpend: number; totalSales: number }>
}

export type CampaignDailyTrendRow = {
  date: string
  spend: number
  sales: number
  acos: number | null
}

export type CampaignPortfolioCrossCheckRow = {
  portfolio: string
  campaignBeforeSales: number
  campaignAfterSales: number
  actualBeforeSales: number
  actualAfterSales: number
  beforeGapPct: number | null
  afterGapPct: number | null
}

export type AdSpendCrossCheck = {
  campaignImportSpendBefore: number
  campaignImportSpendAfter: number
  transactionAdSpendBefore: number
  transactionAdSpendAfter: number
  beforeMismatchPct: number | null
  afterMismatchPct: number | null
  warning: string | null
}

export type EasyhomeAdsCampaignDiagnostic = {
  campaignTable: CampaignRow[]
  topCampaignLosers: CampaignRow[]
  campaignsWithSpendUpAndSalesDown: CampaignRow[]
  campaignMappingHealth: CampaignMappingHealth
  campaignDailyTrend: CampaignDailyTrendRow[]
  campaignPortfolioCrossCheck: CampaignPortfolioCrossCheckRow[]
  adSpendCrossCheck: AdSpendCrossCheck
  hasCampaignData: boolean
}

export function buildEasyhomeAdsCampaignDiagnostic(params: {
  campaignRows: AdsCampaignRowInput[]
  rangeA?: DateRange
  rangeB?: DateRange
  actualCategorySales: Array<{ portfolio: string; beforeSales: number; afterSales: number }>
  transactionAdSpend: { before: number; after: number }
}): EasyhomeAdsCampaignDiagnostic {
  const { campaignRows, actualCategorySales, transactionAdSpend } = params
  const rangeA = params.rangeA ?? DEFAULT_RANGE_A
  const rangeB = params.rangeB ?? DEFAULT_RANGE_B

  if (campaignRows.length === 0) {
    return {
      campaignTable: [],
      topCampaignLosers: [],
      campaignsWithSpendUpAndSalesDown: [],
      campaignMappingHealth: { totalCampaignsAnalyzed: 0, mappedCampaignCount: 0, unmappedCampaignCount: 0, unmappedSpend: 0, unmappedSales: 0, topUnmappedCampaigns: [] },
      campaignDailyTrend: [],
      campaignPortfolioCrossCheck: [],
      adSpendCrossCheck: {
        campaignImportSpendBefore: 0,
        campaignImportSpendAfter: 0,
        transactionAdSpendBefore: round2(transactionAdSpend.before),
        transactionAdSpendAfter: round2(transactionAdSpend.after),
        beforeMismatchPct: null,
        afterMismatchPct: null,
        warning: null,
      },
      hasCampaignData: false,
    }
  }

  const beforeRows = campaignRows.filter(r => inWindow(r.reportDate, rangeA))
  const afterRows = campaignRows.filter(r => inWindow(r.reportDate, rangeB))

  const beforeByCampaign = new Map<string, { agg: PeriodAgg; portfolio: string }>()
  const afterByCampaign = new Map<string, { agg: PeriodAgg; portfolio: string }>()
  for (const row of beforeRows) {
    if (!beforeByCampaign.has(row.campaignName)) beforeByCampaign.set(row.campaignName, { agg: emptyAgg(), portfolio: row.easyhomePortfolio })
    addRow(beforeByCampaign.get(row.campaignName)!.agg, row)
  }
  for (const row of afterRows) {
    if (!afterByCampaign.has(row.campaignName)) afterByCampaign.set(row.campaignName, { agg: emptyAgg(), portfolio: row.easyhomePortfolio })
    addRow(afterByCampaign.get(row.campaignName)!.agg, row)
  }

  const allCampaignNames = new Set([...beforeByCampaign.keys(), ...afterByCampaign.keys()])
  const campaignTable: CampaignRow[] = [...allCampaignNames].map(name => {
    const before = beforeByCampaign.get(name)?.agg ?? emptyAgg()
    const after = afterByCampaign.get(name)?.agg ?? emptyAgg()
    const portfolio = beforeByCampaign.get(name)?.portfolio ?? afterByCampaign.get(name)?.portfolio ?? 'Unmapped / Needs Review'
    return {
      campaignName: name,
      portfolio,
      beforeSpend: round2(before.spend),
      afterSpend: round2(after.spend),
      deltaSpend: round2(after.spend - before.spend),
      beforeSales: round2(before.sales),
      afterSales: round2(after.sales),
      deltaSales: round2(after.sales - before.sales),
      beforeAcos: acosOf(before.spend, before.sales),
      afterAcos: acosOf(after.spend, after.sales),
      beforeRoas: roasOf(before.spend, before.sales),
      afterRoas: roasOf(after.spend, after.sales),
      beforeClicks: before.clicks,
      afterClicks: after.clicks,
      beforePurchases: before.purchases,
      afterPurchases: after.purchases,
    }
  })

  const topCampaignLosers = [...campaignTable].sort((a, b) => a.deltaSales - b.deltaSales).slice(0, 20)
  const campaignsWithSpendUpAndSalesDown = campaignTable
    .filter(c => c.deltaSpend > 0 && c.deltaSales < 0)
    .sort((a, b) => a.deltaSales - b.deltaSales)
    .slice(0, 20)

  const unmapped = campaignTable.filter(c => c.portfolio === 'Unmapped / Needs Review')
  const campaignMappingHealth: CampaignMappingHealth = {
    totalCampaignsAnalyzed: campaignTable.length,
    mappedCampaignCount: campaignTable.length - unmapped.length,
    unmappedCampaignCount: unmapped.length,
    unmappedSpend: round2(unmapped.reduce((sum, c) => sum + c.beforeSpend + c.afterSpend, 0)),
    unmappedSales: round2(unmapped.reduce((sum, c) => sum + c.beforeSales + c.afterSales, 0)),
    topUnmappedCampaigns: [...unmapped]
      .sort((a, b) => (b.beforeSpend + b.afterSpend) - (a.beforeSpend + a.afterSpend))
      .slice(0, 10)
      .map(c => ({ campaignName: c.campaignName, totalSpend: round2(c.beforeSpend + c.afterSpend), totalSales: round2(c.beforeSales + c.afterSales) })),
  }

  const byDate = new Map<string, { spend: number; sales: number }>()
  for (const row of [...beforeRows, ...afterRows]) {
    if (!byDate.has(row.reportDate)) byDate.set(row.reportDate, { spend: 0, sales: 0 })
    const bucket = byDate.get(row.reportDate)!
    bucket.spend += row.spend
    bucket.sales += row.sales
  }
  const campaignDailyTrend: CampaignDailyTrendRow[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, bucket]) => ({ date, spend: round2(bucket.spend), sales: round2(bucket.sales), acos: acosOf(bucket.spend, bucket.sales) }))

  const campaignSalesByPortfolio = new Map<string, { before: number; after: number }>()
  for (const row of campaignTable) {
    if (!campaignSalesByPortfolio.has(row.portfolio)) campaignSalesByPortfolio.set(row.portfolio, { before: 0, after: 0 })
    const bucket = campaignSalesByPortfolio.get(row.portfolio)!
    bucket.before += row.beforeSales
    bucket.after += row.afterSales
  }
  const campaignPortfolioCrossCheck: CampaignPortfolioCrossCheckRow[] = actualCategorySales.map(actual => {
    const campaignAgg = campaignSalesByPortfolio.get(actual.portfolio) ?? { before: 0, after: 0 }
    const beforeGapPct = actual.beforeSales !== 0 ? round2(((campaignAgg.before - actual.beforeSales) / Math.abs(actual.beforeSales)) * 100) : null
    const afterGapPct = actual.afterSales !== 0 ? round2(((campaignAgg.after - actual.afterSales) / Math.abs(actual.afterSales)) * 100) : null
    return {
      portfolio: actual.portfolio,
      campaignBeforeSales: round2(campaignAgg.before),
      campaignAfterSales: round2(campaignAgg.after),
      actualBeforeSales: actual.beforeSales,
      actualAfterSales: actual.afterSales,
      beforeGapPct,
      afterGapPct,
    }
  })

  const campaignSpendBefore = beforeRows.reduce((sum, r) => sum + r.spend, 0)
  const campaignSpendAfter = afterRows.reduce((sum, r) => sum + r.spend, 0)
  const beforeMismatchPct = transactionAdSpend.before !== 0
    ? round2(((campaignSpendBefore - transactionAdSpend.before) / Math.abs(transactionAdSpend.before)) * 100)
    : null
  const afterMismatchPct = transactionAdSpend.after !== 0
    ? round2(((campaignSpendAfter - transactionAdSpend.after) / Math.abs(transactionAdSpend.after)) * 100)
    : null
  const LARGE_MISMATCH_THRESHOLD_PCT = 15
  const mismatchFlags: string[] = []
  if (beforeMismatchPct !== null && Math.abs(beforeMismatchPct) > LARGE_MISMATCH_THRESHOLD_PCT) {
    mismatchFlags.push(`before-period spend differs by ${beforeMismatchPct.toFixed(1)}%`)
  }
  if (afterMismatchPct !== null && Math.abs(afterMismatchPct) > LARGE_MISMATCH_THRESHOLD_PCT) {
    mismatchFlags.push(`after-period spend differs by ${afterMismatchPct.toFixed(1)}%`)
  }

  return {
    campaignTable,
    topCampaignLosers,
    campaignsWithSpendUpAndSalesDown,
    campaignMappingHealth,
    campaignDailyTrend,
    campaignPortfolioCrossCheck,
    adSpendCrossCheck: {
      campaignImportSpendBefore: round2(campaignSpendBefore),
      campaignImportSpendAfter: round2(campaignSpendAfter),
      transactionAdSpendBefore: round2(transactionAdSpend.before),
      transactionAdSpendAfter: round2(transactionAdSpend.after),
      beforeMismatchPct,
      afterMismatchPct,
      warning: mismatchFlags.length > 0
        ? `Amazon Ads report spend vs payment-transaction settlement Ad charges mismatch: ${mismatchFlags.join('; ')}. Settlement Ad charges are not used as ad spend KPIs; use this only as a source-accuracy cross-check.`
        : null,
    },
    hasCampaignData: true,
  }
}
