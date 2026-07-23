/**
 * SKU Performance (P1-C1) — pure query-state and query-string logic.
 *
 * Separated from the page component for the same reason as format.ts: it can
 * be unit-tested directly with node:test (see query.test.ts), and it keeps
 * every URLSearchParams-building/pagination-math decision in one place
 * instead of scattered across JSX.
 */
import { DEFAULT_LIMIT, MAX_SUMMARY_RANGE_DAYS } from '@/lib/sku-performance/validation'
import type { SortValue } from '@/lib/sku-performance/validation'
import type { SkuPerformanceSummaryResult } from '@/lib/sku-performance/types'

export const MARKETPLACE_ID = 'A21TJRUUN4KGV'

export const SORT_OPTIONS: Array<{ value: SortValue; label: string }> = [
  { value: 'attention_desc', label: 'Needs attention first' },
  { value: 'sales_desc', label: 'Sales: high to low' },
  { value: 'sales_asc', label: 'Sales: low to high' },
  { value: 'spend_desc', label: 'Spend: high to low' },
  { value: 'spend_asc', label: 'Spend: low to high' },
  { value: 'tacos_desc', label: 'TACOS: high to low' },
  { value: 'tacos_asc', label: 'TACOS: low to high' },
  { value: 'sku_asc', label: 'SKU: A to Z' },
]

export type BasicFilterKey =
  | 'growingOnly' | 'decliningOnly' | 'spendSpikeOnly' | 'noAttributedSalesOnly'
  | 'highTacosOnly' | 'unmappedOnly' | 'identityConflictOnly'

export const BASIC_FILTERS: Array<{ key: BasicFilterKey; label: string }> = [
  { key: 'growingOnly', label: 'Growing' },
  { key: 'decliningOnly', label: 'Declining' },
  { key: 'spendSpikeOnly', label: 'Spend spike' },
  { key: 'noAttributedSalesOnly', label: 'No attributed sales' },
  { key: 'highTacosOnly', label: 'High TACOS' },
  { key: 'unmappedOnly', label: 'Unmapped' },
  { key: 'identityConflictOnly', label: 'Identity conflict' },
]

export interface SkuPerformanceQueryState {
  dateFrom: string
  dateTo: string
  asOf: string
  search: string
  sort: SortValue
  filters: Record<BasicFilterKey, boolean>
  limit: number
  offset: number
}

/** Formats a Date as a YYYY-MM-DD calendar string in the local timezone (never UTC-shifted). */
export function toDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Default range: the trailing 30 calendar days ending today, well inside the 400-inclusive-day ceiling. */
export function defaultQueryState(today: Date = new Date()): SkuPerformanceQueryState {
  const dateTo = toDateString(today)
  const from = new Date(today)
  from.setDate(from.getDate() - 29)
  return {
    dateFrom: toDateString(from),
    dateTo,
    asOf: dateTo,
    search: '',
    sort: 'attention_desc',
    filters: {
      growingOnly: false,
      decliningOnly: false,
      spendSpikeOnly: false,
      noAttributedSalesOnly: false,
      highTacosOnly: false,
      unmappedOnly: false,
      identityConflictOnly: false,
    },
    limit: DEFAULT_LIMIT,
    offset: 0,
  }
}

/**
 * `search` is applied to both skuFilter and asinFilter -- the summary RPC
 * ANDs its own filters together, so a single free-text box would otherwise
 * force the caller to choose one field. Sending the same term as both is a
 * deliberate OR-like widening at the query-building layer, not a new server
 * capability.
 */
export function buildSummaryQueryString(state: SkuPerformanceQueryState): string {
  const params = new URLSearchParams()
  params.set('marketplaceId', MARKETPLACE_ID)
  params.set('dateFrom', state.dateFrom)
  params.set('dateTo', state.dateTo)
  params.set('asOf', state.asOf)
  params.set('sort', state.sort)
  params.set('limit', String(state.limit))
  params.set('offset', String(state.offset))

  const search = state.search.trim()
  if (search) {
    params.set('skuFilter', search)
    params.set('asinFilter', search)
  }

  for (const { key } of BASIC_FILTERS) {
    if (state.filters[key]) params.set(key, 'true')
  }

  return params.toString()
}

export function activeFilterCount(filters: Record<BasicFilterKey, boolean>): number {
  return BASIC_FILTERS.filter(({ key }) => filters[key]).length
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

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'unknown' }
  | { kind: 'ready'; result: Extract<SkuPerformanceSummaryResult, { result: 'success' }> }

/**
 * A single source of truth for which of loading / error / empty / unknown /
 * ready state the page is in, so the component only ever branches on this
 * (never re-derives the same condition twice, never renders two states at
 * once).
 */
export function deriveViewState(params: {
  loading: boolean
  error: string | null
  result: SkuPerformanceSummaryResult | null
}): ViewState {
  if (params.loading) return { kind: 'loading' }
  if (params.error) return { kind: 'error', message: params.error }
  if (!params.result) return { kind: 'unknown' }
  if (params.result.result === 'invalid_parameters') return { kind: 'error', message: params.result.reason }
  if (params.result.result === 'currency_mismatch') {
    return { kind: 'error', message: 'The selected marketplace spans more than one currency and cannot be safely summed.' }
  }
  if (params.result.rows.length === 0) return { kind: 'empty' }
  return { kind: 'ready', result: params.result }
}

export function paginationLabel(pagination: { offset: number; returnedSkuCount: number; totalMatchingSkuCountAfterFilters: number }): string {
  if (pagination.totalMatchingSkuCountAfterFilters === 0) return '0 SKUs'
  const start = pagination.offset + 1
  const end = pagination.offset + pagination.returnedSkuCount
  return `${start}–${end} of ${pagination.totalMatchingSkuCountAfterFilters} SKUs`
}
