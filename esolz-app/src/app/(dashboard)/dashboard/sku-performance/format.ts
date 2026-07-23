/**
 * SKU Performance (P1-C1) — pure formatting/label logic.
 *
 * Deliberately separated from any React component: every function here is a
 * plain, side-effect-free mapping from an API-response value to a display
 * string/tone, so it can be unit-tested directly (this repo has no DOM
 * testing harness — see format.test.ts) and so no rendering decision is
 * duplicated or drifts between components.
 *
 * Truth rules this module exists to enforce (do not weaken these):
 *   - Never render a null/unknown value as ₹0 or any other silent zero.
 *   - Never invent a currency symbol/code when currencyCode is null.
 *   - A ratio's `state` (normal/not_applicable/undefined/undefined_high_risk/
 *     unknown) always drives the label — the numeric `value` is only ever
 *     shown for state === 'normal'.
 *   - A window's coverage state (complete/partial/before_history/
 *     source_not_complete/unknown) is surfaced, never silently ignored.
 *   - Every flag/label here reflects a value the API already computed —
 *     nothing here invents a new trend, ratio, or flag.
 */
import type {
  IdentityConflictReason,
  MappingState,
  Ratio,
  SalesTrend,
  SkuPerformanceRow,
  SpendTrend,
  WindowCoverageState,
  WindowMetrics,
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
    // An unrecognized ISO code from the API is still surfaced honestly, never silently dropped to a bare number.
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

// ------------------------------------------------------- coverage state ---

const WINDOW_COVERAGE_LABELS: Record<WindowCoverageState, string> = {
  complete: 'Complete',
  partial: 'Partial',
  before_history: 'Before history',
  source_not_complete: 'Source incomplete',
  unknown: 'Unknown',
}

export function windowCoverageLabel(state: WindowCoverageState): string {
  return WINDOW_COVERAGE_LABELS[state] ?? 'Unknown'
}

export function windowCoverageTone(state: WindowCoverageState): Tone {
  switch (state) {
    case 'complete':
      return 'positive'
    case 'partial':
    case 'source_not_complete':
      return 'warning'
    case 'unknown':
      return 'danger'
    case 'before_history':
      return 'muted'
    default:
      return 'muted'
  }
}

/**
 * A short, row-level "this range's numbers may be incomplete" warning,
 * derived only from coverage states the API already returned — never a new
 * computation. Returns null when both sources report complete coverage for
 * the selected range (the common, unremarkable case).
 */
export function selectedRangeCoverageWarning(window: WindowMetrics | null): string | null {
  if (!window) return null
  const problems: string[] = []
  if (window.salesCoverageState !== 'complete' && window.salesCoverageState !== 'before_history') {
    problems.push(`Sales: ${windowCoverageLabel(window.salesCoverageState)}`)
  }
  if (window.adsCoverageState !== 'complete' && window.adsCoverageState !== 'before_history') {
    problems.push(`Ads: ${windowCoverageLabel(window.adsCoverageState)}`)
  }
  if (problems.length === 0) return null
  return `Data incomplete for this range — ${problems.join(', ')}`
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

// --------------------------------------------------------------- flags ---

export interface AttentionChip {
  key: string
  label: string
  tone: Tone
}

/**
 * Attention-status chips — Product Spec §6.4's eight named flags, rendered
 * as-is from the row's own `flags` object (never recomputed here). An
 * identity_conflict row's only true flag is mappingIncomplete (every other
 * flag is suppressed server-side), so it never shows a misleading sales/
 * spend chip alongside the conflict.
 */
export function attentionChips(row: Pick<SkuPerformanceRow, 'flags'>): AttentionChip[] {
  const chips: AttentionChip[] = []
  const { flags } = row
  if (flags.salesDrop) chips.push({ key: 'salesDrop', label: 'Sales drop', tone: 'danger' })
  if (flags.spendSpike) chips.push({ key: 'spendSpike', label: 'Spend spike', tone: 'warning' })
  if (flags.noAttributedSales) chips.push({ key: 'noAttributedSales', label: 'Ad spend, no attributed sales', tone: 'warning' })
  if (flags.tacosDeterioration) chips.push({ key: 'tacosDeterioration', label: 'TACOS deteriorating', tone: 'danger' })
  if (flags.salesGrowingStableSpend) chips.push({ key: 'salesGrowingStableSpend', label: 'Growing, stable spend', tone: 'positive' })
  if (flags.salesGrowingSpendFalls) chips.push({ key: 'salesGrowingSpendFalls', label: 'Growing, spend falling', tone: 'positive' })
  if (flags.mappingIncomplete) chips.push({ key: 'mappingIncomplete', label: 'Mapping incomplete', tone: 'warning' })
  if (flags.dataDelayed) chips.push({ key: 'dataDelayed', label: 'Data delayed', tone: 'muted' })
  return chips
}

// ----------------------------------------------------------------- tone ---

const TONE_BADGE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400',
  danger: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
  muted: 'border-border bg-muted/50 text-muted-foreground',
}

/** Tailwind classes for an outline-variant Badge, keyed off the same Tone every label/chip function above already returns. */
export function toneBadgeClassName(tone: Tone): string {
  return TONE_BADGE_CLASSES[tone]
}
