// Phase 2A: shared date-range types/helpers so Brahmastra diagnostics can run
// against any user-selected window instead of a hardcoded June-15 drop.
// Pure date-string math (UTC, inclusive bounds) — no DOM/timezone dependency,
// safe to import from both server (API routes) and client (dashboard) code.

export type DateRange = { startDate: string; endDate: string }
export type AnalysisMode = 'single' | 'compare'

export const JUNE_15 = '2026-06-15'

// Default preset — the original June-15 drop investigation window.
export const DEFAULT_RANGE_A: DateRange = { startDate: '2026-06-01', endDate: '2026-06-14' }
export const DEFAULT_RANGE_B: DateRange = { startDate: '2026-06-15', endDate: '2026-06-23' }

export function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export function isValidRangeShape(range: DateRange): boolean {
  return isValidDateString(range.startDate) && isValidDateString(range.endDate)
}

/** Inclusive day count, e.g. 2026-06-01..2026-06-01 = 1 day. */
export function daysInRange(range: DateRange): number {
  const start = new Date(`${range.startDate}T00:00:00Z`).getTime()
  const end = new Date(`${range.endDate}T00:00:00Z`).getTime()
  return Math.round((end - start) / 86400000) + 1
}

export function inWindow(dateIso: string, range: DateRange): boolean {
  const d = dateIso.slice(0, 10)
  return d >= range.startDate && d <= range.endDate
}

export function rangeIncludesDate(range: DateRange, dateOnly: string): boolean {
  return dateOnly >= range.startDate && dateOnly <= range.endDate
}

export type RangeValidation = { valid: boolean; error: string | null }

export function validateRange(range: DateRange): RangeValidation {
  if (!isValidRangeShape(range)) return { valid: false, error: 'Dates must be in YYYY-MM-DD format.' }
  if (range.startDate > range.endDate) return { valid: false, error: 'Start date must be on or before end date.' }
  return { valid: true, error: null }
}

/** Compare mode requires Range A and Range B to cover the same number of days. */
export function validateCompareRanges(rangeA: DateRange, rangeB: DateRange): RangeValidation {
  const a = validateRange(rangeA)
  if (!a.valid) return a
  const b = validateRange(rangeB)
  if (!b.valid) return b
  const daysA = daysInRange(rangeA)
  const daysB = daysInRange(rangeB)
  if (daysA !== daysB) {
    return {
      valid: false,
      error: `Range A is ${daysA} day(s) but Range B is ${daysB} day(s) — Compare mode requires two equal-length ranges.`,
    }
  }
  return { valid: true, error: null }
}

export function usesJune15(rangeA: DateRange, rangeB?: DateRange | null): boolean {
  return rangeIncludesDate(rangeA, JUNE_15) || (!!rangeB && rangeIncludesDate(rangeB, JUNE_15))
}

export function minStartDate(rangeA: DateRange, rangeB?: DateRange | null): string {
  return rangeB && rangeB.startDate < rangeA.startDate ? rangeB.startDate : rangeA.startDate
}

export function maxEndDate(rangeA: DateRange, rangeB?: DateRange | null): string {
  return rangeB && rangeB.endDate > rangeA.endDate ? rangeB.endDate : rangeA.endDate
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return toDateOnly(d)
}

export type PresetId =
  | 'yesterday_vs_previous_day'
  | 'yesterday_vs_last_week'
  | 'last3_vs_previous3'
  | 'last7_vs_previous7'
  | 'june15_default'
  | 'custom'

export const PRESET_LABELS: Record<PresetId, string> = {
  yesterday_vs_previous_day: 'Yesterday vs previous day',
  yesterday_vs_last_week: 'Yesterday vs same day last week',
  last3_vs_previous3: 'Last 3 days vs previous 3 days',
  last7_vs_previous7: 'Last 7 days vs previous 7 days',
  june15_default: 'June 15 drop (default)',
  custom: 'Custom',
}

/** All presets except 'custom' resolve to a concrete {rangeA, rangeB} pair. */
export function buildPreset(presetId: PresetId, today: Date = new Date()): { rangeA: DateRange; rangeB: DateRange } | null {
  if (presetId === 'june15_default') return { rangeA: DEFAULT_RANGE_A, rangeB: DEFAULT_RANGE_B }
  if (presetId === 'custom') return null

  const todayStr = toDateOnly(today)
  const yesterday = addDays(todayStr, -1)

  switch (presetId) {
    case 'yesterday_vs_previous_day': {
      const dayBefore = addDays(yesterday, -1)
      return { rangeA: { startDate: dayBefore, endDate: dayBefore }, rangeB: { startDate: yesterday, endDate: yesterday } }
    }
    case 'yesterday_vs_last_week': {
      const sameDayLastWeek = addDays(yesterday, -7)
      return { rangeA: { startDate: sameDayLastWeek, endDate: sameDayLastWeek }, rangeB: { startDate: yesterday, endDate: yesterday } }
    }
    case 'last3_vs_previous3': {
      const bEnd = yesterday
      const bStart = addDays(bEnd, -2)
      const aEnd = addDays(bStart, -1)
      const aStart = addDays(aEnd, -2)
      return { rangeA: { startDate: aStart, endDate: aEnd }, rangeB: { startDate: bStart, endDate: bEnd } }
    }
    case 'last7_vs_previous7': {
      const bEnd = yesterday
      const bStart = addDays(bEnd, -6)
      const aEnd = addDays(bStart, -1)
      const aStart = addDays(aEnd, -6)
      return { rangeA: { startDate: aStart, endDate: aEnd }, rangeB: { startDate: bStart, endDate: bEnd } }
    }
    default:
      return null
  }
}

/** Auto baseline for Single Range mode: the immediately preceding period of equal length. */
export function autoBaselineFor(range: DateRange): DateRange {
  const days = daysInRange(range)
  const baselineEnd = addDays(range.startDate, -1)
  const baselineStart = addDays(baselineEnd, -(days - 1))
  return { startDate: baselineStart, endDate: baselineEnd }
}
