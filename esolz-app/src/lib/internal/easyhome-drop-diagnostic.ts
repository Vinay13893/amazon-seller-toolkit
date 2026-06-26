// Phase 0B/2A: read-only EasyHOME drop diagnostic, generalized to run against
// any two equal- or unequal-length date ranges (not just the June-15 drop).
// Pure aggregation — callers fetch rows from internal_payment_transactions /
// internal_sku_cost_master and pass them in; nothing here touches the database.

import { DEFAULT_RANGE_A, DEFAULT_RANGE_B, type DateRange, inWindow as inDateRange } from './date-range'
import { resolveEasyhomePortfolio } from './portfolio-labels'

// Re-exported for callers/tests that want the original June-15 default preset.
export const BEFORE_START = DEFAULT_RANGE_A.startDate
export const BEFORE_END = DEFAULT_RANGE_A.endDate
export const AFTER_START = DEFAULT_RANGE_B.startDate

export type EasyhomePortfolio =
  | 'ASM'
  | 'EVA Gym'
  | 'EVA Kids'
  | 'BPM'
  | 'Sage Royal Ayurveda'
  | 'Curtains'
  | 'Coze'
  | 'Water Tank Cover'
  | 'Storage Bags'
  | 'Planter and Garden'
  | 'Unmapped / Needs Review'

const PORTFOLIO_BY_COST_MASTER_CATEGORY: Record<string, EasyhomePortfolio> = {
  'anti-slip shelf liner (asm)': 'ASM',
  'asm': 'ASM',
  'eva gym mat': 'EVA Gym',
  'eva kids mat': 'EVA Kids',
  'baby play mat': 'BPM',
  'sage royal ayurveda': 'Sage Royal Ayurveda',
  'curtains': 'Curtains',
  'curtain': 'Curtains',
  'coze': 'Coze',
  'papfoil': 'Coze',
  'baking paper': 'Coze',
  'parchment paper': 'Coze',
  'butter paper': 'Coze',
  'water tank cover': 'Water Tank Cover',
  'storage bag': 'Storage Bags',
  'planters': 'Planter and Garden',
  'garden': 'Planter and Garden',
}

export function mapCostMasterCategoryToPortfolio(rawCategory: string | null): EasyhomePortfolio {
  if (!rawCategory) return 'Unmapped / Needs Review'
  const key = rawCategory.trim().toLowerCase()
  return (PORTFOLIO_BY_COST_MASTER_CATEGORY[key] ?? resolveEasyhomePortfolio(null, rawCategory)) as EasyhomePortfolio
}

export type PaymentTxnInput = {
  transactionDate: string
  category: string
  sku: string | null
  skuNorm: string | null
  quantity: number | null
  productSales: number
  totalAmount: number
  orderId: string | null
}

export type CostMasterInput = {
  skuNorm: string
  category: string | null
  productName: string | null
}

export type KeywordRankCoverageInput = {
  checkedAt: string
}

type PeriodTotals = {
  rowCount: number
  dayCount: number
  netSales: number
  adSpend: number
  adToSalesRatioPct: number | null
  orderCount: number
  unitsOrdered: number
  refundCount: number
  refundAmount: number
}

type DailyTrendRow = {
  date: string
  netSales: number
  adSpend: number
  adToSalesRatioPct: number | null
  refundAmount: number
  orderCount: number
}

type CategoryRow = {
  portfolio: EasyhomePortfolio
  beforeSales: number
  afterSales: number
  deltaSales: number
  deltaSalesPct: number | null
  beforeUnits: number
  afterUnits: number
  deltaUnits: number
  beforeRefund: number
  afterRefund: number
}

type SkuRow = {
  sku: string
  skuNorm: string
  productName: string | null
  portfolio: EasyhomePortfolio
  beforeSales: number
  afterSales: number
  deltaSales: number
  deltaSalesPct: number | null
  beforeUnits: number
  afterUnits: number
  deltaUnits: number
  beforeRefund: number
  afterRefund: number
  deltaRefund: number
}

type OutlierDayRow = {
  date: string
  netSales: number
  adSpend: number
  refundAmount: number
  rowCount: number
  vsAfterPeriodAvgSalesPct: number | null
  topPortfolioDrops: Array<{ portfolio: EasyhomePortfolio; dayShare: number; afterPeriodAvgShare: number }>
}

export type EasyhomeDropDiagnostic = {
  windows: { beforeStart: string; beforeEnd: string; afterStart: string; afterEnd: string; rangeA: DateRange; rangeB: DateRange }
  accountSummary: { before: PeriodTotals; after: PeriodTotals }
  dailyTrend: DailyTrendRow[]
  categoryTable: CategoryRow[]
  skuTable: SkuRow[]
  topRevenueLosers: SkuRow[]
  topUnitLosers: SkuRow[]
  topRefundIncreases: SkuRow[]
  outlierDays: OutlierDayRow[]
  rankingSignalCoverage: { beforeCount: number; afterCount: number; sufficientForTrend: boolean }
  mappingHealth: MappingHealth
  diagnosticNotes: string[]
  dataGaps: string[]
}

export type MappingHealth = {
  totalSkusAnalyzed: number
  mappedSkuCount: number
  unmappedSkuCount: number
  unmappedRevenue: number
  topUnmappedSkus: Array<{ sku: string; totalSales: number; beforeSales: number; afterSales: number }>
}

function dateOf(transactionDateIso: string): string {
  return transactionDateIso.slice(0, 10)
}

function inWindow(transactionDateIso: string, range: DateRange): boolean {
  return inDateRange(transactionDateIso, range)
}

function pctChange(before: number, after: number): number | null {
  if (before === 0) return null
  return ((after - before) / Math.abs(before)) * 100
}

function summarizePeriod(rows: PaymentTxnInput[]): PeriodTotals {
  const dayCount = new Set(rows.map(r => dateOf(r.transactionDate))).size
  const netSales = rows.reduce((sum, r) => sum + r.productSales, 0)
  const adSpend = rows.filter(r => r.category === 'Ad').reduce((sum, r) => sum + Math.abs(r.totalAmount), 0)
  const orderRows = rows.filter(r => r.category === 'Order')
  const refundRows = rows.filter(r => r.category === 'Refund')
  const orderCount = new Set(orderRows.map(r => r.orderId).filter(Boolean)).size
  const unitsOrdered = orderRows.reduce((sum, r) => sum + (r.quantity ?? 0), 0)
  const refundCount = new Set(refundRows.map(r => r.orderId).filter(Boolean)).size
  const refundAmount = Math.abs(refundRows.reduce((sum, r) => sum + r.productSales, 0))

  return {
    rowCount: rows.length,
    dayCount,
    netSales: round2(netSales),
    adSpend: round2(adSpend),
    adToSalesRatioPct: netSales !== 0 ? round2((adSpend / Math.abs(netSales)) * 100) : null,
    orderCount,
    unitsOrdered,
    refundCount,
    refundAmount: round2(refundAmount),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function buildDailyTrend(rows: PaymentTxnInput[]): DailyTrendRow[] {
  const byDate = new Map<string, { netSales: number; adSpend: number; refundAmount: number; orderIds: Set<string> }>()
  for (const row of rows) {
    const d = dateOf(row.transactionDate)
    if (!byDate.has(d)) byDate.set(d, { netSales: 0, adSpend: 0, refundAmount: 0, orderIds: new Set() })
    const bucket = byDate.get(d)!
    bucket.netSales += row.productSales
    if (row.category === 'Ad') bucket.adSpend += Math.abs(row.totalAmount)
    if (row.category === 'Refund') bucket.refundAmount += Math.abs(row.productSales)
    if (row.category === 'Order' && row.orderId) bucket.orderIds.add(row.orderId)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, bucket]) => ({
      date,
      netSales: round2(bucket.netSales),
      adSpend: round2(bucket.adSpend),
      adToSalesRatioPct: bucket.netSales !== 0 ? round2((bucket.adSpend / Math.abs(bucket.netSales)) * 100) : null,
      refundAmount: round2(bucket.refundAmount),
      orderCount: bucket.orderIds.size,
    }))
}

export function buildEasyhomeDropDiagnostic(params: {
  transactions: PaymentTxnInput[]
  costMaster: CostMasterInput[]
  rangeA?: DateRange
  rangeB?: DateRange
  keywordRankCoverage?: { beforeCount: number; afterCount: number }
}): EasyhomeDropDiagnostic {
  const { transactions, costMaster } = params
  const rangeA = params.rangeA ?? DEFAULT_RANGE_A
  const rangeB = params.rangeB ?? DEFAULT_RANGE_B

  const costMasterByNorm = new Map<string, CostMasterInput>()
  for (const row of costMaster) costMasterByNorm.set(row.skuNorm, row)

  const portfolioForSkuNorm = (skuNorm: string | null): EasyhomePortfolio => {
    if (!skuNorm) return 'Unmapped / Needs Review'
    const costMasterRow = costMasterByNorm.get(skuNorm)
    const fromCategory = mapCostMasterCategoryToPortfolio(costMasterRow?.category ?? null)
    if (fromCategory !== 'Unmapped / Needs Review') return fromCategory
    return resolveEasyhomePortfolio(null, skuNorm, costMasterRow?.productName) as EasyhomePortfolio
  }

  const beforeRows = transactions.filter(r => inWindow(r.transactionDate, rangeA))
  const afterRows = transactions.filter(r => inWindow(r.transactionDate, rangeB))
  const allRows = [...beforeRows, ...afterRows]

  const accountSummary = { before: summarizePeriod(beforeRows), after: summarizePeriod(afterRows) }
  const dailyTrend = buildDailyTrend(allRows)

  // Only rows that carry a SKU can be attributed to a category/SKU — Ad,
  // ServiceFee, Adjustment, Subscription, and Transfer rows in Amazon's
  // transaction export never carry a SKU, so ad spend cannot be broken
  // down by category from this table (see dataGaps below).
  const skuRowsBefore = beforeRows.filter(r => r.skuNorm)
  const skuRowsAfter = afterRows.filter(r => r.skuNorm)

  type Acc = { sales: number; units: number; refund: number }
  function aggregateBySkuNorm(rows: PaymentTxnInput[]): Map<string, Acc> {
    const map = new Map<string, Acc>()
    for (const row of rows) {
      const norm = row.skuNorm as string
      if (!map.has(norm)) map.set(norm, { sales: 0, units: 0, refund: 0 })
      const acc = map.get(norm)!
      acc.sales += row.productSales
      if (row.category === 'Order') acc.units += row.quantity ?? 0
      if (row.category === 'Refund') acc.refund += Math.abs(row.productSales)
    }
    return map
  }

  const beforeBySku = aggregateBySkuNorm(skuRowsBefore)
  const afterBySku = aggregateBySkuNorm(skuRowsAfter)
  const allSkuNorms = new Set([...beforeBySku.keys(), ...afterBySku.keys()])

  const skuDisplayBySkuNorm = new Map<string, string>()
  for (const row of [...skuRowsBefore, ...skuRowsAfter]) {
    if (row.sku && row.skuNorm && !skuDisplayBySkuNorm.has(row.skuNorm)) {
      skuDisplayBySkuNorm.set(row.skuNorm, row.sku)
    }
  }

  const skuTable: SkuRow[] = [...allSkuNorms].map(skuNorm => {
    const before = beforeBySku.get(skuNorm) ?? { sales: 0, units: 0, refund: 0 }
    const after = afterBySku.get(skuNorm) ?? { sales: 0, units: 0, refund: 0 }
    return {
      sku: skuDisplayBySkuNorm.get(skuNorm) ?? skuNorm,
      skuNorm,
      productName: costMasterByNorm.get(skuNorm)?.productName ?? null,
      portfolio: portfolioForSkuNorm(skuNorm),
      beforeSales: round2(before.sales),
      afterSales: round2(after.sales),
      deltaSales: round2(after.sales - before.sales),
      deltaSalesPct: pctChange(before.sales, after.sales),
      beforeUnits: before.units,
      afterUnits: after.units,
      deltaUnits: after.units - before.units,
      beforeRefund: round2(before.refund),
      afterRefund: round2(after.refund),
      deltaRefund: round2(after.refund - before.refund),
    }
  })

  const categoryAcc = new Map<EasyhomePortfolio, { beforeSales: number; afterSales: number; beforeUnits: number; afterUnits: number; beforeRefund: number; afterRefund: number }>()
  for (const row of skuTable) {
    if (!categoryAcc.has(row.portfolio)) {
      categoryAcc.set(row.portfolio, { beforeSales: 0, afterSales: 0, beforeUnits: 0, afterUnits: 0, beforeRefund: 0, afterRefund: 0 })
    }
    const acc = categoryAcc.get(row.portfolio)!
    acc.beforeSales += row.beforeSales
    acc.afterSales += row.afterSales
    acc.beforeUnits += row.beforeUnits
    acc.afterUnits += row.afterUnits
    acc.beforeRefund += row.beforeRefund
    acc.afterRefund += row.afterRefund
  }

  const categoryTable: CategoryRow[] = [...categoryAcc.entries()]
    .map(([portfolio, acc]) => ({
      portfolio,
      beforeSales: round2(acc.beforeSales),
      afterSales: round2(acc.afterSales),
      deltaSales: round2(acc.afterSales - acc.beforeSales),
      deltaSalesPct: pctChange(acc.beforeSales, acc.afterSales),
      beforeUnits: acc.beforeUnits,
      afterUnits: acc.afterUnits,
      deltaUnits: acc.afterUnits - acc.beforeUnits,
      beforeRefund: round2(acc.beforeRefund),
      afterRefund: round2(acc.afterRefund),
    }))
    .sort((a, b) => a.deltaSales - b.deltaSales)

  const topRevenueLosers = [...skuTable].sort((a, b) => a.deltaSales - b.deltaSales).slice(0, 20)
  const topUnitLosers = [...skuTable].sort((a, b) => a.deltaUnits - b.deltaUnits).slice(0, 20)
  const topRefundIncreases = [...skuTable].sort((a, b) => b.deltaRefund - a.deltaRefund).slice(0, 20)

  const afterDailyByDate = new Map(dailyTrend.map(d => [d.date, d]))
  const afterPeriodAvgSales = accountSummary.after.dayCount > 0 ? accountSummary.after.netSales / accountSummary.after.dayCount : 0

  const afterPortfolioDailyAvg = new Map<EasyhomePortfolio, number>()
  for (const row of categoryTable) {
    afterPortfolioDailyAvg.set(row.portfolio, accountSummary.after.dayCount > 0 ? row.afterSales / accountSummary.after.dayCount : 0)
  }

  // Dynamic outlier days: the days within Range B whose net sales deviate most
  // from the Range B daily average (was a hardcoded 2-date list before Phase 2A).
  const candidateDates = afterRows.length > 0
    ? [...new Set(afterRows.map(r => dateOf(r.transactionDate)))].sort()
    : []
  const outlierDays: OutlierDayRow[] = candidateDates.map(date => {
    const dayRows = allRows.filter(r => dateOf(r.transactionDate) === date)
    const trend = afterDailyByDate.get(date)
    const byPortfolioThatDay = new Map<EasyhomePortfolio, number>()
    for (const row of dayRows) {
      if (!row.skuNorm) continue
      const portfolio = portfolioForSkuNorm(row.skuNorm)
      byPortfolioThatDay.set(portfolio, (byPortfolioThatDay.get(portfolio) ?? 0) + row.productSales)
    }
    const dayTotal = trend?.netSales ?? 0
    const topPortfolioDrops = [...byPortfolioThatDay.entries()]
      .map(([portfolio, sales]) => ({
        portfolio,
        dayShare: dayTotal !== 0 ? round2((sales / dayTotal) * 100) : 0,
        afterPeriodAvgShare: afterPeriodAvgSales !== 0
          ? round2(((afterPortfolioDailyAvg.get(portfolio) ?? 0) / afterPeriodAvgSales) * 100)
          : 0,
      }))
      .sort((a, b) => (a.dayShare - a.afterPeriodAvgShare) - (b.dayShare - b.afterPeriodAvgShare))
      .slice(0, 5)

    return {
      date,
      netSales: trend?.netSales ?? 0,
      adSpend: trend?.adSpend ?? 0,
      refundAmount: trend?.refundAmount ?? 0,
      rowCount: dayRows.length,
      vsAfterPeriodAvgSalesPct: afterPeriodAvgSales !== 0 ? round2(((dayTotal - afterPeriodAvgSales) / afterPeriodAvgSales) * 100) : null,
      topPortfolioDrops,
    }
  }).sort((a, b) => Math.abs(b.vsAfterPeriodAvgSalesPct ?? 0) - Math.abs(a.vsAfterPeriodAvgSalesPct ?? 0)).slice(0, 3)

  const rankingSignalCoverage = {
    beforeCount: params.keywordRankCoverage?.beforeCount ?? 0,
    afterCount: params.keywordRankCoverage?.afterCount ?? 0,
    sufficientForTrend: (params.keywordRankCoverage?.beforeCount ?? 0) >= 20 && (params.keywordRankCoverage?.afterCount ?? 0) >= 20,
  }

  const unmappedSkus = skuTable.filter(row => row.portfolio === 'Unmapped / Needs Review')
  const mappingHealth: MappingHealth = {
    totalSkusAnalyzed: skuTable.length,
    mappedSkuCount: skuTable.length - unmappedSkus.length,
    unmappedSkuCount: unmappedSkus.length,
    unmappedRevenue: round2(unmappedSkus.reduce((sum, row) => sum + row.beforeSales + row.afterSales, 0)),
    topUnmappedSkus: [...unmappedSkus]
      .sort((a, b) => (b.beforeSales + b.afterSales) - (a.beforeSales + a.afterSales))
      .slice(0, 10)
      .map(row => ({
        sku: row.sku,
        totalSales: round2(row.beforeSales + row.afterSales),
        beforeSales: row.beforeSales,
        afterSales: row.afterSales,
      })),
  }

  const diagnosticNotes = buildDiagnosticNotes({ accountSummary, categoryTable, topRevenueLosers, outlierDays })
  const dataGaps = buildDataGaps(rankingSignalCoverage)
  if (beforeRows.length === 0) dataGaps.unshift(`Data incomplete for selected range: no transactions found for Range A (${rangeA.startDate} to ${rangeA.endDate}).`)
  if (afterRows.length === 0) dataGaps.unshift(`Data incomplete for selected range: no transactions found for Range B (${rangeB.startDate} to ${rangeB.endDate}).`)

  return {
    windows: { beforeStart: rangeA.startDate, beforeEnd: rangeA.endDate, afterStart: rangeB.startDate, afterEnd: rangeB.endDate, rangeA, rangeB },
    accountSummary,
    dailyTrend,
    categoryTable,
    skuTable,
    topRevenueLosers,
    topUnitLosers,
    topRefundIncreases,
    outlierDays,
    rankingSignalCoverage,
    mappingHealth,
    diagnosticNotes,
    dataGaps,
  }
}

function buildDiagnosticNotes(params: {
  accountSummary: { before: PeriodTotals; after: PeriodTotals }
  categoryTable: CategoryRow[]
  topRevenueLosers: SkuRow[]
  outlierDays: OutlierDayRow[]
}): string[] {
  const notes: string[] = []
  const { before, after } = params.accountSummary

  const salesDeltaPct = pctChange(before.netSales / Math.max(before.dayCount, 1), after.netSales / Math.max(after.dayCount, 1))
  const adDeltaPct = pctChange(before.adSpend / Math.max(before.dayCount, 1), after.adSpend / Math.max(after.dayCount, 1))
  if (salesDeltaPct !== null && adDeltaPct !== null) {
    notes.push(
      `Average daily net sales fell ${Math.abs(salesDeltaPct).toFixed(1)}% while average daily ad spend fell only `
      + `${Math.abs(adDeltaPct).toFixed(1)}% — the drop is not explained by lower ad spend alone.`,
    )
  }

  const totalDecline = params.categoryTable.reduce((sum, row) => sum + Math.min(row.deltaSales, 0), 0)
  if (totalDecline < 0) {
    const sorted = [...params.categoryTable].filter(r => r.deltaSales < 0).sort((a, b) => a.deltaSales - b.deltaSales)
    const top = sorted[0]
    if (top) {
      const share = (Math.abs(top.deltaSales) / Math.abs(totalDecline)) * 100
      notes.push(`"${top.portfolio}" is the single largest contributor to the decline: ₹${Math.abs(top.deltaSales).toLocaleString('en-IN')} of the combined drop (${share.toFixed(1)}%).`)
    }
  }

  const topSku = params.topRevenueLosers[0]
  if (topSku && totalDecline < 0) {
    const share = (Math.abs(topSku.deltaSales) / Math.abs(totalDecline)) * 100
    notes.push(`The single biggest SKU loser is "${topSku.sku}" (${topSku.portfolio}), down ₹${Math.abs(topSku.deltaSales).toLocaleString('en-IN')} (${share.toFixed(1)}% of the combined category decline).`)
  }

  const refundDeltaPct = pctChange(before.refundAmount, after.refundAmount)
  if (refundDeltaPct !== null) {
    notes.push(`Total refund value ${refundDeltaPct >= 0 ? 'increased' : 'decreased'} ${Math.abs(refundDeltaPct).toFixed(1)}% between the two periods (₹${before.refundAmount.toLocaleString('en-IN')} → ₹${after.refundAmount.toLocaleString('en-IN')}).`)
  }

  for (const day of params.outlierDays) {
    if (day.vsAfterPeriodAvgSalesPct !== null && day.vsAfterPeriodAvgSalesPct < -15) {
      const worstPortfolio = day.topPortfolioDrops[0]
      notes.push(
        `${day.date} was ${Math.abs(day.vsAfterPeriodAvgSalesPct).toFixed(0)}% below the after-period daily average`
        + (worstPortfolio ? `, with "${worstPortfolio.portfolio}" underrepresented relative to its usual share.` : '.'),
      )
    }
  }

  return notes
}

function buildDataGaps(rankingSignalCoverage: { beforeCount: number; afterCount: number; sufficientForTrend: boolean }): string[] {
  const gaps: string[] = [
    'No Amazon Ads campaign-level data exists in the database (amazon_ads_connections/profiles/report_jobs are all empty) — ad spend here is an account-level aggregate from the Seller Central settlement feed and cannot be broken down by campaign, keyword, ACOS, CPC, CTR, or CVR.',
    'Ad/ServiceFee/Adjustment rows in the transaction feed carry no SKU, so ad spend cannot be attributed to a category or SKU from this table either — only account-level ad spend is available.',
    'Payment-transaction sales/units are SKU-level, not ASIN-level — internal_payment_transactions has no ASIN column.',
  ]
  if (!rankingSignalCoverage.sufficientForTrend) {
    gaps.push(`Keyword rank, BSR, buy-box, and pincode-availability tables have too few rows before/after 06-15 (keyword: ${rankingSignalCoverage.beforeCount} before / ${rankingSignalCoverage.afterCount} after) for a reliable trend — they are not used for quantitative comparison here.`)
  }
  gaps.push('Local Amazon Ads Console campaign CSV exports exist on disk but are period-aggregate totals (not a daily time series) and have not been imported — see report notes.')
  return gaps
}
