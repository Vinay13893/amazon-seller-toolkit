/**
 * SKU Daily Trends (V0) — pure query-state, query-string, and view-state
 * logic. Kept out of the page component so it can be unit-tested directly
 * (see query.test.ts).
 */
import { MAX_SUMMARY_RANGE_DAYS } from '@/lib/sku-performance/validation'
import type {
  SkuPerformanceDailyDay,
  SkuPerformanceDailyResult,
  SkuPerformanceSummaryResult,
} from '@/lib/sku-performance/types'
import { isTrustworthyDayValue } from './format'

export const MARKETPLACE_ID = 'A21TJRUUN4KGV'
export const V0_DAY_RANGE = 30

export interface DateRangeState {
  dateFrom: string
  dateTo: string
}

/** Formats a Date as a YYYY-MM-DD calendar string in the local timezone (never UTC-shifted). */
export function toDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * "Latest 30 complete days" — ending YESTERDAY, never today: today's data
 * is still accumulating and can never honestly be called complete, so the
 * default range deliberately excludes it rather than showing a
 * still-partial current day as if it were final.
 */
export function defaultDateRange(now: Date = new Date()): DateRangeState {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const dateTo = toDateString(yesterday)
  const from = new Date(yesterday)
  from.setDate(from.getDate() - (V0_DAY_RANGE - 1))
  return { dateFrom: toDateString(from), dateTo }
}

/** Clamps a requested range to MAX_SUMMARY_RANGE_DAYS by pulling dateFrom forward -- never silently drops dateTo. */
export function clampRangeToMaxDays(dateFrom: string, dateTo: string): string {
  const from = new Date(`${dateFrom}T00:00:00Z`)
  const to = new Date(`${dateTo}T00:00:00Z`)
  const inclusiveDays = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1
  if (inclusiveDays <= MAX_SUMMARY_RANGE_DAYS) return dateFrom
  const clampedFrom = new Date(to)
  clampedFrom.setUTCDate(clampedFrom.getUTCDate() - (MAX_SUMMARY_RANGE_DAYS - 1))
  return toDateString(clampedFrom)
}

/**
 * `search` covers SKU, ASIN, and product title. The RPC ANDs skuFilter and
 * asinFilter together (`WHERE (sku ILIKE ...) AND (asin ILIKE ...)`), so
 * sending the same free-text term as both would incorrectly NARROW results
 * to rows matching on both fields at once, silently dropping a legitimate
 * SKU-only or ASIN-only match. Search is therefore never sent to the API
 * at all for this single free-text box -- it is applied entirely
 * client-side, against the page the API already returned (see
 * filterRowsByTitle). This deliberately does not search beyond the current
 * page (V0 has no pagination controls in scope).
 */
export function buildSummaryQueryString(params: { dateFrom: string; dateTo: string }): string {
  const qs = new URLSearchParams()
  qs.set('marketplaceId', MARKETPLACE_ID)
  qs.set('dateFrom', params.dateFrom)
  qs.set('dateTo', params.dateTo)
  qs.set('asOf', params.dateTo)
  return qs.toString()
}

export function buildDailyQueryString(params: { dateFrom: string; dateTo: string }): string {
  const qs = new URLSearchParams()
  qs.set('marketplaceId', MARKETPLACE_ID)
  qs.set('dateFrom', params.dateFrom)
  qs.set('dateTo', params.dateTo)
  return qs.toString()
}

// ------------------------------------------------------------- search ---

/**
 * The API already filters by skuFilter/asinFilter server-side; this adds a
 * client-side product-title match on TOP of that (never in place of it) so
 * "product title" search works without a dedicated API param, without
 * re-deciding which rows the server already excluded.
 */
export function filterRowsByTitle<T extends { productTitle: string | null; sku: string; asin: string | null }>(rows: T[], search: string): T[] {
  const term = search.trim().toLowerCase()
  if (!term) return rows
  return rows.filter(row =>
    (row.productTitle?.toLowerCase().includes(term) ?? false)
    || row.sku.toLowerCase().includes(term)
    || (row.asin?.toLowerCase().includes(term) ?? false)
  )
}

// ---------------------------------------------------------- view state ---

export type PageViewState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'no_comparable_data'; result: Extract<SkuPerformanceSummaryResult, { result: 'success' }> }
  | { kind: 'ready'; result: Extract<SkuPerformanceSummaryResult, { result: 'success' }> }

export function derivePageViewState(params: {
  loading: boolean
  status: number | null
  error: string | null
  result: SkuPerformanceSummaryResult | null
}): PageViewState {
  if (params.loading) return { kind: 'loading' }
  if (params.status === 401) return { kind: 'unauthorized' }
  // A 5xx here means the RPC/route itself could not run today -- most
  // plausibly because migration 065 has not been applied yet. Distinct from
  // a 4xx (a real, user-fixable request problem).
  if (params.status !== null && params.status >= 500) return { kind: 'unavailable' }
  if (params.error) return { kind: 'error', message: params.error }
  if (!params.result) return { kind: 'unavailable' }
  if (params.result.result === 'invalid_parameters') return { kind: 'error', message: params.result.reason }
  if (params.result.result === 'currency_mismatch') {
    return { kind: 'error', message: 'The selected marketplace spans more than one currency and cannot be safely summed.' }
  }
  if (params.result.rows.length === 0) return { kind: 'empty' }
  // Neither source has any usable history overlap for this scope at all --
  // every row's combined ACOS/TACOS will be not_applicable/unknown, so this
  // is surfaced honestly rather than rendered as a normal-looking table.
  if (params.result.dateRange.commonEffectiveDateFrom === null) {
    return { kind: 'no_comparable_data', result: params.result }
  }
  return { kind: 'ready', result: params.result }
}

export type ChartViewState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'identity_conflict'; result: Extract<SkuPerformanceDailyResult, { result: 'identity_conflict' }> }
  | { kind: 'no_comparable_data' }
  | { kind: 'ready'; days: SkuPerformanceDailyDay[] }

export function deriveChartViewState(params: {
  loading: boolean
  status: number | null
  error: string | null
  result: SkuPerformanceDailyResult | null
}): ChartViewState {
  if (params.loading) return { kind: 'loading' }
  if (params.status === 401) return { kind: 'unauthorized' }
  if (params.status !== null && params.status >= 500) return { kind: 'unavailable' }
  if (params.error) return { kind: 'error', message: params.error }
  if (!params.result) return { kind: 'unavailable' }
  if (params.result.result === 'invalid_parameters') return { kind: 'error', message: params.result.reason }
  if (params.result.result === 'identity_conflict') return { kind: 'identity_conflict', result: params.result }

  const hasComparableDay = params.result.days.some(
    day => isTrustworthyDayValue(day.sales.coverageState) || isTrustworthyDayValue(day.spend.coverageState)
  )
  if (!hasComparableDay) return { kind: 'no_comparable_data' }
  return { kind: 'ready', days: params.result.days }
}
