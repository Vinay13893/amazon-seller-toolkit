/**
 * Daily Command Center ("Today") — pure query-state, date-math, comparison,
 * and attention-ranking logic. Kept out of the page component so it is
 * directly unit-testable with node:test (see today-query.test.ts) and so no
 * rendering decision drifts between the cards and the attention sections.
 *
 * Data contract: every number here is read straight off
 * `get_sku_performance_summary` responses (via the existing
 * /api/sku-performance/summary route, called with different single-day or
 * 7-day windows) — never a client-side re-derivation of a ratio or
 * authoritative total the API already computes. The only arithmetic done
 * here is: (a) plain percentage-change between two already-fetched totals,
 * and (b) dividing an already-fetched 7-day total by 7 for a daily average
 * — neither re-derives ACOS/TACOS or any coverage-state-aware business rule.
 */
import { buildSummaryQueryString, MARKETPLACE_ID } from './sku-performance/query'
import type { Ratio, SkuPerformanceRow, SkuPerformanceSummaryResult, SkuPerformanceSummaryTotals } from '@/lib/sku-performance/types'

export { MARKETPLACE_ID }

export const ATTENTION_SECTION_LIMIT = 8

// ---------------------------------------------------------------- dates ---

export function toDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Calendar yesterday, local time — never today, which can never honestly be called complete. */
export function calendarYesterday(now: Date = new Date()): string {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  return toDateString(yesterday)
}

export function addDaysToDateString(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return toDateString(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime()
  const b = new Date(`${to}T00:00:00Z`).getTime()
  return Math.round((b - a) / (24 * 60 * 60 * 1000))
}

// ---------------------------------------------------- freshness / dates ---

/**
 * "What happened on the LATEST COMPLETE day" — derived from the summary
 * RPC's own truthful freshness facts (salesLatestAcceptedCompleteDate /
 * adsLatestAcceptedCompleteDate — the only dates safe to call "complete"),
 * never assumed to be calendar-yesterday. Requires BOTH sources to have an
 * accepted-complete date, and uses the EARLIER of the two, so a combined
 * (sales + ads) view is never shown for a day either source can't yet
 * confirm as complete. Returns null when either source has no accepted-
 * complete date at all (never had a successful run).
 */
export function deriveLatestCompleteDate(summary: SkuPerformanceSummaryTotals, now: Date = new Date()): string | null {
  const { salesLatestAcceptedCompleteDate: sales, adsLatestAcceptedCompleteDate: ads } = summary
  if (!sales || !ads) return null
  const earlier = sales < ads ? sales : ads
  // Defense in depth: today's data can never honestly be called complete,
  // even if a source's own accepted-complete date somehow claimed otherwise.
  const today = toDateString(now)
  return earlier >= today ? calendarYesterday(now) : earlier
}

/** True when the derived latest complete date is more than staleAfterDays behind calendar-yesterday. */
export function isStale(latestCompleteDate: string, now: Date = new Date(), staleAfterDays = 2): boolean {
  return daysBetween(latestCompleteDate, calendarYesterday(now)) > staleAfterDays
}

export function buildTodaySummaryQueryString(params: { dateFrom: string; dateTo: string }): string {
  const qs = new URLSearchParams(buildSummaryQueryString(params))
  return qs.toString()
}

/** Single-day request: dateFrom = dateTo = asOf = the target day. */
export function buildSingleDayQueryString(date: string): string {
  return buildTodaySummaryQueryString({ dateFrom: date, dateTo: date })
}

/** The 7 days strictly before latestCompleteDate (never including it) — the baseline "prior 7-day daily average" window. */
export function prior7DayRange(latestCompleteDate: string): { dateFrom: string; dateTo: string } {
  return { dateFrom: addDaysToDateString(latestCompleteDate, -7), dateTo: addDaysToDateString(latestCompleteDate, -1) }
}

export function previousCompleteDate(latestCompleteDate: string): string {
  return addDaysToDateString(latestCompleteDate, -1)
}

// -------------------------------------------------------- safe percent ---

/**
 * Percentage change from baseline to current, handling a zero or otherwise
 * degenerate baseline safely: returns null (never Infinity/NaN/a fabricated
 * sign) whenever the change cannot be honestly expressed as a percentage.
 */
export function safePercentChange(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null
  if (baseline === 0) return current === 0 ? 0 : null
  return ((current - baseline) / Math.abs(baseline)) * 100
}

// ---------------------------------------------------------- card metrics ---

export type CardMetricKey = 'sales' | 'units' | 'spend' | 'attributedSales' | 'acos' | 'tacos'

export interface RawCardMetric {
  key: Extract<CardMetricKey, 'sales' | 'units' | 'spend' | 'attributedSales'>
  label: string
  latestDay: number
  previousDay: number
  changeVsPreviousDayPct: number | null
  prior7DayAvg: number
  changeVsPrior7AvgPct: number | null
}

export interface RatioCardMetric {
  key: Extract<CardMetricKey, 'acos' | 'tacos'>
  label: string
  latestDay: Ratio
  previousDay: Ratio
  prior7DayAvg: Ratio
}

export interface TodayCards {
  raw: RawCardMetric[]
  ratio: RatioCardMetric[]
}

const RAW_METRIC_DEFS: Array<{ key: RawCardMetric['key']; label: string; totalsKey: 'totalOrderedSales' | 'totalUnits' | 'totalAdSpend' | 'totalAttributedSales' }> = [
  { key: 'sales', label: 'Ordered sales', totalsKey: 'totalOrderedSales' },
  { key: 'units', label: 'Units ordered', totalsKey: 'totalUnits' },
  { key: 'spend', label: 'Ad spend', totalsKey: 'totalAdSpend' },
  { key: 'attributedSales', label: 'Ad-attributed sales', totalsKey: 'totalAttributedSales' },
]

/**
 * Builds the 6 summary-card metrics from 3 already-fetched summary totals
 * (latest complete day, previous complete day, prior-7-day window) — no
 * value here is computed from raw rows; every total/ratio comes straight
 * from the RPC's own `summary` block for the requested window.
 */
export function buildTodayCards(
  latestDay: SkuPerformanceSummaryTotals,
  previousDay: SkuPerformanceSummaryTotals,
  prior7: SkuPerformanceSummaryTotals,
): TodayCards {
  const raw = RAW_METRIC_DEFS.map(def => {
    const latestValue = latestDay[def.totalsKey]
    const previousValue = previousDay[def.totalsKey]
    const prior7Total = prior7[def.totalsKey]
    const prior7DayAvg = prior7Total / 7
    return {
      key: def.key,
      label: def.label,
      latestDay: latestValue,
      previousDay: previousValue,
      changeVsPreviousDayPct: safePercentChange(latestValue, previousValue),
      prior7DayAvg,
      changeVsPrior7AvgPct: safePercentChange(latestValue, prior7DayAvg),
    }
  })

  const ratio: RatioCardMetric[] = [
    { key: 'acos', label: 'ACOS', latestDay: latestDay.acos, previousDay: previousDay.acos, prior7DayAvg: prior7.acos },
    { key: 'tacos', label: 'TACOS', latestDay: latestDay.tacos, previousDay: previousDay.tacos, prior7DayAvg: prior7.tacos },
  ]

  return { raw, ratio }
}

// ------------------------------------------------------ attention rows ---

export type AttentionSectionId = 'sales_declines' | 'sales_growth' | 'spend_up_sales_flat' | 'high_spend_zero_sales'

export interface AttentionRow {
  sku: string
  asin: string | null
  productTitle: string | null
  orderedSales: number
  units: number
  adSpend: number
  adAttributedSales: number
  tacos: Ratio
  latestDayValue: number
  comparisonBaseline: number
  changePercent: number | null
  reason: string
}

/** Never true for a null-window row -- an identity-conflict row's selectedRange/priorSevenDay/trends are already null per Fix 4, but this guard makes the exclusion explicit and testable rather than relying only on that upstream nulling. */
function isCombinableRow(row: SkuPerformanceRow): boolean {
  return row.mappingState !== 'identity_conflict' && row.selectedRange !== null && row.priorSevenDay !== null
}

function priorSevenDayAvg(row: SkuPerformanceRow, field: 'sales' | 'spend'): number {
  return (row.priorSevenDay?.[field] ?? 0) / 7
}

function pctText(pct: number | null): string {
  return pct === null ? 'an unmeasurable amount' : `${Math.abs(Math.round(pct))}%`
}

export function selectBiggestSalesDeclines(rows: SkuPerformanceRow[], limit = ATTENTION_SECTION_LIMIT): AttentionRow[] {
  return rows
    .filter(r => isCombinableRow(r) && r.salesTrend === 'declining')
    .map(r => {
      const baseline = priorSevenDayAvg(r, 'sales')
      const latest = r.selectedRange!.sales
      const pct = safePercentChange(latest, baseline)
      return toAttentionRow(r, latest, baseline, pct, `Sales declined ${pctText(pct)} versus the previous 7-day daily average.`)
    })
    .sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0))
    .slice(0, limit)
}

export function selectBiggestSalesGrowth(rows: SkuPerformanceRow[], limit = ATTENTION_SECTION_LIMIT): AttentionRow[] {
  return rows
    .filter(r => isCombinableRow(r) && (r.salesTrend === 'growing' || r.salesTrend === 'new_activity'))
    .map(r => {
      const baseline = priorSevenDayAvg(r, 'sales')
      const latest = r.selectedRange!.sales
      const pct = safePercentChange(latest, baseline)
      return toAttentionRow(r, latest, baseline, pct, `Sales grew ${pctText(pct)} versus the previous 7-day daily average.`)
    })
    .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0))
    .slice(0, limit)
}

export function selectSpendUpSalesFlat(rows: SkuPerformanceRow[], limit = ATTENTION_SECTION_LIMIT): AttentionRow[] {
  return rows
    .filter(r => isCombinableRow(r) && r.spendTrend === 'growing' && r.salesTrend !== 'growing' && r.salesTrend !== 'new_activity')
    .map(r => {
      const salesBaseline = priorSevenDayAvg(r, 'sales')
      const spendBaseline = priorSevenDayAvg(r, 'spend')
      const latestSales = r.selectedRange!.sales
      const latestSpend = r.selectedRange!.spend
      const salesPct = safePercentChange(latestSales, salesBaseline)
      const spendPct = safePercentChange(latestSpend, spendBaseline)
      const salesWord = salesPct !== null && salesPct < 0 ? 'declined' : 'did not grow'
      const reason = `Spend increased ${pctText(spendPct)} while ordered sales ${salesWord} ${pctText(salesPct)}.`
      return toAttentionRow(r, latestSpend, spendBaseline, spendPct, reason)
    })
    .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0))
    .slice(0, limit)
}

export function selectHighSpendZeroAttributedSales(rows: SkuPerformanceRow[], limit = ATTENTION_SECTION_LIMIT): AttentionRow[] {
  return rows
    .filter(r => isCombinableRow(r) && r.flags.noAttributedSales)
    .map(r => {
      const latestSpend = r.selectedRange!.spend
      const reason = `${moneyDigits(latestSpend)} spend with 0 attributed sales on the latest complete day.`
      return toAttentionRow(r, latestSpend, 0, null, reason)
    })
    .sort((a, b) => b.latestDayValue - a.latestDayValue)
    .slice(0, limit)
}

function moneyDigits(value: number): string {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value)
}

function toAttentionRow(row: SkuPerformanceRow, latestDayValue: number, comparisonBaseline: number, changePercent: number | null, reason: string): AttentionRow {
  const window = row.selectedRange!
  return {
    sku: row.sku,
    asin: row.asin,
    productTitle: row.productTitle,
    orderedSales: window.sales,
    units: window.units,
    adSpend: window.spend,
    adAttributedSales: window.attributedSales,
    tacos: window.tacos,
    latestDayValue,
    comparisonBaseline,
    changePercent,
    reason,
  }
}

export interface TodayAttentionSections {
  salesDeclines: AttentionRow[]
  salesGrowth: AttentionRow[]
  spendUpSalesFlat: AttentionRow[]
  highSpendZeroSales: AttentionRow[]
}

export function buildAttentionSections(rows: SkuPerformanceRow[]): TodayAttentionSections {
  return {
    salesDeclines: selectBiggestSalesDeclines(rows),
    salesGrowth: selectBiggestSalesGrowth(rows),
    spendUpSalesFlat: selectSpendUpSalesFlat(rows),
    highSpendZeroSales: selectHighSpendZeroAttributedSales(rows),
  }
}

export function hasAnyAttentionItems(sections: TodayAttentionSections): boolean {
  return sections.salesDeclines.length > 0 || sections.salesGrowth.length > 0
    || sections.spendUpSalesFlat.length > 0 || sections.highSpendZeroSales.length > 0
}

// -------------------------------------------------------------- deep link ---

/** SKU Performance deep link -- SKU + a deterministic date range anchored to the SAME latestCompleteDate this page derived, so the destination page never recomputes (and possibly disagrees with) its own "latest day." */
export function buildSkuPerformanceDeepLink(params: { sku: string; latestCompleteDate: string }): string {
  const dateFrom = addDaysToDateString(params.latestCompleteDate, -29)
  const qs = new URLSearchParams({ sku: params.sku, dateFrom, dateTo: params.latestCompleteDate })
  return `/dashboard/sku-performance?${qs.toString()}`
}

// ---------------------------------------------------------- view state ---

export type TodayViewState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'incomplete_common_range' }
  | { kind: 'empty' }
  | { kind: 'ready'; latestCompleteDate: string; stale: boolean }

export function deriveTodayViewState(params: {
  loading: boolean
  status: number | null
  error: string | null
  result: SkuPerformanceSummaryResult | null
  now?: Date
}): TodayViewState {
  if (params.loading) return { kind: 'loading' }
  if (params.status === 401) return { kind: 'unauthorized' }
  if (params.status !== null && params.status >= 500) return { kind: 'unavailable' }
  if (params.error) return { kind: 'error', message: params.error }
  if (!params.result) return { kind: 'unavailable' }
  if (params.result.result === 'invalid_parameters') return { kind: 'error', message: params.result.reason }
  if (params.result.result === 'currency_mismatch') {
    return { kind: 'error', message: 'The selected marketplace spans more than one currency and cannot be safely summed.' }
  }
  const latestCompleteDate = deriveLatestCompleteDate(params.result.summary)
  if (!latestCompleteDate) return { kind: 'incomplete_common_range' }
  if (params.result.rows.length === 0) return { kind: 'empty' }
  return { kind: 'ready', latestCompleteDate, stale: isStale(latestCompleteDate, params.now) }
}
