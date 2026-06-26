// Phase 1C: deep SP diagnostics (advertised product / targeting / search
// term), built on top of the manually imported internal_ads_*_daily_rows
// tables. Pure functions — callers fetch rows and pass them in. Read-only
// analytics only; never used to change bids/budgets/campaigns.

import { DEFAULT_RANGE_A, DEFAULT_RANGE_B, type DateRange, inWindow as inDateRange } from './date-range'

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function inWindow(reportDate: string, range: DateRange): boolean {
  return inDateRange(reportDate, range)
}

function acosOf(spend: number, sales: number): number | null {
  return sales > 0 ? round2((spend / sales) * 100) : null
}

function roasOf(spend: number, sales: number): number | null {
  return spend > 0 ? round2(sales / spend) : null
}

type Metrics = { impressions: number; clicks: number; spend: number; purchases: number; sales: number }

function emptyMetrics(): Metrics {
  return { impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0 }
}

function addMetrics(agg: Metrics, row: Metrics): void {
  agg.impressions += row.impressions
  agg.clicks += row.clicks
  agg.spend += row.spend
  agg.purchases += row.purchases
  agg.sales += row.sales
}

export type BeforeAfterRow<TDims> = TDims & {
  portfolio: string
  beforeSpend: number
  afterSpend: number
  deltaSpend: number
  beforeSales: number
  afterSales: number
  deltaSales: number
  beforeClicks: number
  afterClicks: number
  beforePurchases: number
  afterPurchases: number
  beforeAcos: number | null
  afterAcos: number | null
  beforeRoas: number | null
  afterRoas: number | null
}

function aggregateBeforeAfter<TRow extends Metrics & { reportDate: string; portfolio: string }, TDims>(
  rows: TRow[],
  rangeA: DateRange,
  rangeB: DateRange,
  keyFn: (row: TRow) => string,
  dimsFn: (row: TRow) => TDims,
): BeforeAfterRow<TDims>[] {
  const beforeRows = rows.filter(r => inWindow(r.reportDate, rangeA))
  const afterRows = rows.filter(r => inWindow(r.reportDate, rangeB))

  const beforeByKey = new Map<string, { agg: Metrics; portfolio: string; dims: TDims }>()
  const afterByKey = new Map<string, { agg: Metrics; portfolio: string; dims: TDims }>()
  for (const row of beforeRows) {
    const key = keyFn(row)
    if (!beforeByKey.has(key)) beforeByKey.set(key, { agg: emptyMetrics(), portfolio: row.portfolio, dims: dimsFn(row) })
    addMetrics(beforeByKey.get(key)!.agg, row)
  }
  for (const row of afterRows) {
    const key = keyFn(row)
    if (!afterByKey.has(key)) afterByKey.set(key, { agg: emptyMetrics(), portfolio: row.portfolio, dims: dimsFn(row) })
    addMetrics(afterByKey.get(key)!.agg, row)
  }

  const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()])
  return [...allKeys].map(key => {
    const before = beforeByKey.get(key)?.agg ?? emptyMetrics()
    const after = afterByKey.get(key)?.agg ?? emptyMetrics()
    const dims = beforeByKey.get(key)?.dims ?? afterByKey.get(key)!.dims
    const portfolio = beforeByKey.get(key)?.portfolio ?? afterByKey.get(key)?.portfolio ?? 'Unmapped / Needs Review'
    return {
      ...dims,
      portfolio,
      beforeSpend: round2(before.spend),
      afterSpend: round2(after.spend),
      deltaSpend: round2(after.spend - before.spend),
      beforeSales: round2(before.sales),
      afterSales: round2(after.sales),
      deltaSales: round2(after.sales - before.sales),
      beforeClicks: before.clicks,
      afterClicks: after.clicks,
      beforePurchases: before.purchases,
      afterPurchases: after.purchases,
      beforeAcos: acosOf(before.spend, before.sales),
      afterAcos: acosOf(after.spend, after.sales),
      beforeRoas: roasOf(before.spend, before.sales),
      afterRoas: roasOf(after.spend, after.sales),
    }
  })
}

function mappingHealthOf<TRow extends { portfolio: string; beforeSpend: number; afterSpend: number; beforeSales: number; afterSales: number }>(rows: TRow[], nameOf: (r: TRow) => string) {
  const unmapped = rows.filter(r => r.portfolio === 'Unmapped / Needs Review')
  return {
    totalAnalyzed: rows.length,
    mappedCount: rows.length - unmapped.length,
    unmappedCount: unmapped.length,
    unmappedSpend: round2(unmapped.reduce((sum, r) => sum + r.beforeSpend + r.afterSpend, 0)),
    unmappedSales: round2(unmapped.reduce((sum, r) => sum + r.beforeSales + r.afterSales, 0)),
    topUnmapped: [...unmapped]
      .sort((a, b) => (b.beforeSpend + b.afterSpend) - (a.beforeSpend + a.afterSpend))
      .slice(0, 10)
      .map(r => ({ name: nameOf(r), totalSpend: round2(r.beforeSpend + r.afterSpend), totalSales: round2(r.beforeSales + r.afterSales) })),
  }
}

// ============================================================
// Advertised product (SKU/ASIN level)
// ============================================================
export type AdvertisedProductRowInput = {
  reportDate: string
  advertisedSku: string | null
  advertisedAsin: string | null
  campaignName: string
  adGroupName: string | null
  portfolio: string
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
}

export type AdvertisedProductRow = BeforeAfterRow<{ advertisedSku: string; advertisedAsin: string | null; campaignName: string; adGroupName: string | null }>

export function buildAdvertisedProductDiagnostic(rows: AdvertisedProductRowInput[], rangeA: DateRange = DEFAULT_RANGE_A, rangeB: DateRange = DEFAULT_RANGE_B) {
  const table = aggregateBeforeAfter(
    rows as Array<AdvertisedProductRowInput & { portfolio: string }>,
    rangeA,
    rangeB,
    row => row.advertisedSku ?? `NOSKU:${row.campaignName}`,
    row => ({ advertisedSku: row.advertisedSku ?? '(no SKU)', advertisedAsin: row.advertisedAsin, campaignName: row.campaignName, adGroupName: row.adGroupName }),
  ) as AdvertisedProductRow[]

  const topLosers = [...table].sort((a, b) => a.deltaSales - b.deltaSales).slice(0, 20)
  // "traffic continued but sales collapsed": clicks roughly stable/up, sales near zero after.
  const trafficContinuedSalesCollapsed = table
    .filter(r => r.beforeClicks > 0 && r.afterClicks >= r.beforeClicks * 0.6 && r.afterSales < r.beforeSales * 0.2)
    .sort((a, b) => a.deltaSales - b.deltaSales)
    .slice(0, 20)
  const mappingHealth = mappingHealthOf(table, r => r.advertisedSku)

  return { table, topLosers, trafficContinuedSalesCollapsed, mappingHealth }
}

// ============================================================
// Targeting (keyword / product target level)
// ============================================================
export type TargetingRowInput = {
  reportDate: string
  keyword: string | null
  targeting: string | null
  matchType: string | null
  campaignName: string
  adGroupName: string | null
  portfolio: string
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
}

export type TargetingRow = BeforeAfterRow<{ targetLabel: string; matchType: string | null; campaignName: string; adGroupName: string | null }>

export function buildTargetingDiagnostic(rows: TargetingRowInput[], rangeA: DateRange = DEFAULT_RANGE_A, rangeB: DateRange = DEFAULT_RANGE_B) {
  const table = aggregateBeforeAfter(
    rows as Array<TargetingRowInput & { portfolio: string }>,
    rangeA,
    rangeB,
    row => `${row.keyword ?? row.targeting ?? row.campaignName}|${row.matchType ?? ''}`,
    row => ({ targetLabel: row.keyword ?? row.targeting ?? '(unlabeled target)', matchType: row.matchType, campaignName: row.campaignName, adGroupName: row.adGroupName }),
  ) as TargetingRow[]

  const topLosers = [...table].sort((a, b) => a.deltaSales - b.deltaSales).slice(0, 20)
  // ACOS worsened sharply: require minimum clicks to avoid 1-click noise.
  const acosWorsenedSharply = table
    .filter(r => r.afterClicks >= 5 && r.beforeAcos !== null && r.afterAcos !== null && r.afterAcos - r.beforeAcos > 10)
    .sort((a, b) => (b.afterAcos! - b.beforeAcos!) - (a.afterAcos! - a.beforeAcos!))
    .slice(0, 20)
  const mappingHealth = mappingHealthOf(table, r => r.targetLabel)

  return { table, topLosers, acosWorsenedSharply, mappingHealth }
}

// ============================================================
// Search term level
// ============================================================
export type SearchTermRowInput = {
  reportDate: string
  searchTerm: string | null
  targeting: string | null
  campaignName: string
  adGroupName: string | null
  portfolio: string
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
}

export type SearchTermRow = BeforeAfterRow<{ searchTerm: string; campaignName: string; adGroupName: string | null }>

export function buildSearchTermDiagnostic(rows: SearchTermRowInput[], rangeA: DateRange = DEFAULT_RANGE_A, rangeB: DateRange = DEFAULT_RANGE_B) {
  const table = aggregateBeforeAfter(
    rows as Array<SearchTermRowInput & { portfolio: string }>,
    rangeA,
    rangeB,
    row => row.searchTerm ?? `NOTERM:${row.campaignName}`,
    row => ({ searchTerm: row.searchTerm ?? '(no search term)', campaignName: row.campaignName, adGroupName: row.adGroupName }),
  ) as SearchTermRow[]

  const spendUpSalesDown = table
    .filter(r => r.deltaSpend > 0 && r.deltaSales < 0)
    .sort((a, b) => a.deltaSales - b.deltaSales)
    .slice(0, 20)

  const highSpendZeroOrdersAfter = table
    .filter(r => r.afterSpend > 0 && r.afterPurchases === 0)
    .sort((a, b) => b.afterSpend - a.afterSpend)
    .slice(0, 20)

  // "Good before, bad after": reasonable ACOS before (<=30%) with real volume,
  // then zero orders or a much worse ACOS after.
  const goodBeforeBadAfter = table
    .filter(r => r.beforeAcos !== null && r.beforeAcos <= 30 && r.beforePurchases > 0 && (r.afterPurchases === 0 || (r.afterAcos !== null && r.afterAcos > r.beforeAcos * 2)))
    .sort((a, b) => a.deltaSales - b.deltaSales)
    .slice(0, 20)

  const mappingHealth = mappingHealthOf(table, r => r.searchTerm)

  return { table, spendUpSalesDown, highSpendZeroOrdersAfter, goodBeforeBadAfter, mappingHealth }
}

export type EasyhomeAdsDeepDiagnostic = {
  advertisedProduct: ReturnType<typeof buildAdvertisedProductDiagnostic> | null
  targeting: ReturnType<typeof buildTargetingDiagnostic> | null
  searchTerm: ReturnType<typeof buildSearchTermDiagnostic> | null
}
