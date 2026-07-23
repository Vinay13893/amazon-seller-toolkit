/**
 * SKU Daily Trends (V0) — pure formatting/label logic.
 *
 * Kept separate from any React component so it is directly unit-testable
 * with node:test (this repo has no DOM test harness — see format.test.ts)
 * and so no rendering decision drifts between the table and the chart.
 *
 * Truth rules this module exists to enforce:
 *   - Never render a null/unknown value as ₹0 or any other silent zero.
 *   - Never invent a currency symbol/code when currencyCode is null.
 *   - A ratio's `state` always drives the label — the numeric `value` is
 *     only ever shown for state === 'normal'.
 *   - An identity-conflict row/SKU never shows combined metrics.
 */
import type {
  IdentityConflictReason,
  MappingState,
  Ratio,
  SalesTrend,
  SkuPerformanceRow,
  SpendTrend,
  CoverageState,
} from '@/lib/sku-performance/types'
import type { SourceHealthStatus } from '@/lib/internal/brahmastra-data-health'

export type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'muted'

// ---------------------------------------------------------------- money ---

/** Never renders null as ₹0, and never invents a currency when currencyCode is null. */
export function formatMoney(value: number, currencyCode: string | null): string {
  const formatted = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  if (!currencyCode) return `${formatted} (currency not confirmed)`
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currencyCode, currencyDisplay: 'code' }).format(value)
  } catch {
    return `${currencyCode} ${formatted}`
  }
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value)
}

export function formatDate(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date)
}

export function formatDateTime(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatShortDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date)
}

// ---------------------------------------------------------------- ratio ---

export interface RatioDisplay {
  text: string
  tone: Tone
}

/**
 * A ratio's `state` always governs the label. `value` is only trusted (and
 * only ever shown) when state === 'normal' — every other state renders an
 * explicit word, never a number, never blank-as-zero.
 */
export function formatRatio(ratio: Ratio): RatioDisplay {
  switch (ratio.state) {
    case 'normal':
      return ratio.value === null
        ? { text: 'Unknown', tone: 'muted' }
        : { text: `${(ratio.value * 100).toFixed(1)}%`, tone: 'neutral' }
    case 'not_applicable':
      return { text: 'No ad activity', tone: 'muted' }
    case 'undefined':
      return { text: 'Undefined', tone: 'warning' }
    case 'undefined_high_risk':
      return { text: 'Undefined — high risk', tone: 'danger' }
    case 'unknown':
      return { text: 'Unknown', tone: 'muted' }
    default:
      return { text: 'Unknown', tone: 'muted' }
  }
}

/** D's narrower rule for the per-day breakdown beneath the chart: show a ratio ONLY when it's state === 'normal', blank otherwise (not even a word). */
export function formatRatioIfNormal(ratio: Ratio): string {
  return ratio.state === 'normal' && ratio.value !== null ? `${(ratio.value * 100).toFixed(1)}%` : ''
}

// -------------------------------------------------------- source health ---

const SOURCE_HEALTH_LABELS: Record<SourceHealthStatus, string> = {
  healthy: 'Healthy',
  stale: 'Stale',
  failed: 'Failed',
  auth_required: 'Reconnect required',
  rate_limited: 'Rate limited',
  not_configured: 'Not configured',
}

export function sourceHealthLabel(status: SourceHealthStatus | undefined): string {
  if (!status) return 'Unknown'
  return SOURCE_HEALTH_LABELS[status] ?? 'Unknown'
}

export function sourceHealthTone(status: SourceHealthStatus | undefined): Tone {
  switch (status) {
    case 'healthy':
      return 'positive'
    case 'stale':
    case 'rate_limited':
      return 'warning'
    case 'failed':
    case 'auth_required':
      return 'danger'
    case 'not_configured':
      return 'muted'
    default:
      return 'muted'
  }
}

// --------------------------------------------------------------- trends ---

const SALES_TREND_LABELS: Record<SalesTrend, string> = {
  growing: 'Growing',
  declining: 'Declining',
  flat: 'Flat',
  new_activity: 'New activity',
  no_activity: 'No activity',
  no_comparable_baseline: 'Not enough data',
}

const SPEND_TREND_LABELS: Record<SpendTrend, string> = {
  growing: 'Growing',
  declining: 'Declining',
  flat: 'Flat',
  new_spend: 'New spend',
  no_spend: 'No spend',
  no_comparable_baseline: 'Not enough data',
}

export function salesTrendLabel(trend: SalesTrend | null): string {
  if (trend === null) return '—'
  return SALES_TREND_LABELS[trend] ?? 'Unknown'
}

export function spendTrendLabel(trend: SpendTrend | null): string {
  if (trend === null) return '—'
  return SPEND_TREND_LABELS[trend] ?? 'Unknown'
}

export function trendTone(trend: SalesTrend | SpendTrend | null): Tone {
  if (trend === null) return 'muted'
  if (trend === 'growing' || trend === 'new_activity' || trend === 'new_spend') return 'positive'
  if (trend === 'declining') return 'danger'
  if (trend === 'no_comparable_baseline') return 'warning'
  return 'neutral'
}

// ---------------------------------------------------------- mapping state ---

const MAPPING_STATE_LABELS: Record<MappingState, string> = {
  mapped: 'Mapped',
  unmapped: 'Unmapped',
  identity_conflict: 'Identity conflict',
  not_applicable: 'No ad activity',
}

export function mappingStateLabel(state: MappingState): string {
  return MAPPING_STATE_LABELS[state] ?? state
}

export function mappingStateTone(state: MappingState): Tone {
  switch (state) {
    case 'mapped':
      return 'positive'
    case 'unmapped':
      return 'warning'
    case 'identity_conflict':
      return 'danger'
    case 'not_applicable':
      return 'muted'
    default:
      return 'muted'
  }
}

const IDENTITY_CONFLICT_REASON_LABELS: Record<IdentityConflictReason, string> = {
  raw_sku_collision: 'Raw SKU collision',
  advertised_asin_catalog_asin_mismatch: 'Catalog ASIN vs. advertised ASIN mismatch',
}

export function identityConflictReasonLabel(reason: IdentityConflictReason): string {
  return IDENTITY_CONFLICT_REASON_LABELS[reason] ?? reason
}

// ---------------------------------------------------------- data status ---

export interface DataStatusDisplay {
  label: string
  tone: Tone
  detail: string | null
}

/**
 * V0's single "Data status" table column — combines mapping state with
 * selected-range coverage into one honest label. An identity-conflict row
 * (whose selectedRange is always null) never gets a coverage detail
 * appended, since it has no combined metrics to be complete/incomplete
 * about.
 */
export function dataStatus(row: Pick<SkuPerformanceRow, 'mappingState' | 'selectedRange'>): DataStatusDisplay {
  if (row.mappingState === 'identity_conflict') {
    return { label: 'Identity conflict', tone: 'danger', detail: null }
  }
  const label = mappingStateLabel(row.mappingState)
  const tone = mappingStateTone(row.mappingState)
  const window = row.selectedRange
  if (!window) return { label, tone, detail: null }

  const problems: string[] = []
  if (window.salesCoverageState !== 'complete' && window.salesCoverageState !== 'before_history') {
    problems.push(`Sales ${window.salesCoverageState.replace(/_/g, ' ')}`)
  }
  if (window.adsCoverageState !== 'complete' && window.adsCoverageState !== 'before_history') {
    problems.push(`Ads ${window.adsCoverageState.replace(/_/g, ' ')}`)
  }
  if (problems.length === 0) return { label, tone, detail: null }
  return { label, tone: tone === 'positive' ? 'warning' : tone, detail: `Data incomplete — ${problems.join(', ')}` }
}

// -------------------------------------------------------- chart helpers ---

/** True only for a per-day coverage state that carries a real, trustworthy value — every other state must never be plotted as zero. */
export function isTrustworthyDayValue(state: CoverageState): boolean {
  return state === 'REPORTED_VALUE' || state === 'CONFIRMED_ZERO'
}

const TONE_BADGE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400',
  danger: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
  muted: 'border-border bg-muted/50 text-muted-foreground',
}

/** Tailwind classes for an outline-variant Badge, keyed off the same Tone every label function above already returns. */
export function toneBadgeClassName(tone: Tone): string {
  return TONE_BADGE_CLASSES[tone]
}

export function coverageStateLabel(state: CoverageState): string {
  switch (state) {
    case 'REPORTED_VALUE':
      return 'Reported'
    case 'CONFIRMED_ZERO':
      return 'Confirmed zero'
    case 'BEFORE_HISTORY':
      return 'Before available history'
    case 'SOURCE_NOT_COMPLETE':
      return 'Data delayed'
    case 'UNKNOWN':
      return 'Unknown'
    default:
      return 'Unknown'
  }
}
