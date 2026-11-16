export const RECONCILIATION_VERSION = 1
export const RECONCILIATION_SOURCE = 'brahmastra_ads_reconciliation'
export const DATASETS = ['campaign', 'advertised_product', 'targeting', 'search_term'] as const
export const METRICS = ['spend', 'sales', 'clicks', 'purchases', 'impressions'] as const
export type Totals = Record<(typeof METRICS)[number], number>
export type Comparison = { dataset: string; date: string; passed: boolean; maxDiscrepancy: number }
export type Evidence = {
  version: number; day: string; dates: string[]; comparisons: Comparison[]; passed: boolean
}
export type EvidenceRun = { status: string; finished_at: string | null; report_options: Evidence | null }

export function shiftDate(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function profileDay(now: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function emptyTotals(): Totals {
  return { spend: 0, sales: 0, clicks: 0, purchases: 0, impressions: 0 }
}

export function compareTotals(dataset: string, date: string, warehouse: Totals, amazon: Totals): Comparison {
  const discrepancies = METRICS.map(metric => {
    const a = amazon[metric], w = warehouse[metric]
    if (!Number.isFinite(a) || !Number.isFinite(w) || a < 0 || w < 0) return Infinity
    if (a === 0) return w === 0 ? 0 : Infinity
    return Math.abs(w - a) / a
  })
  const maxDiscrepancy = Math.max(...discrepancies)
  return { dataset, date, passed: maxDiscrepancy <= 0.02 + 1e-12, maxDiscrepancy: Number.isFinite(maxDiscrepancy) ? maxDiscrepancy : -1 }
}

export function validEvidence(value: Evidence | null): value is Evidence {
  if (!value || value.version !== RECONCILIATION_VERSION || value.passed !== true || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)) return false
  if (!Array.isArray(value.dates) || new Set(value.dates).size !== 3 || value.dates.length !== 3 || !Array.isArray(value.comparisons) || value.comparisons.length !== 12) return false
  if (value.dates.some(day => day < shiftDate(value.day, -14) || day > shiftDate(value.day, -1))) return false
  return DATASETS.every(dataset => value.dates.every(date => {
    const matches = value.comparisons.filter(row => row && row.dataset === dataset && row.date === date)
    return matches.length === 1 && matches[0].passed && Number.isFinite(matches[0].maxDiscrepancy) && matches[0].maxDiscrepancy >= 0 && matches[0].maxDiscrepancy <= 0.02 + 1e-12
  }))
}

/** Latest attempt wins, including running/failed attempts. Repeated runs never add days. */
export function reconciliationGate(runsNewestFirst: EvidenceRun[], today: string, nowMs: number) {
  const latest = runsNewestFirst[0]
  const byDay = new Map<string, boolean>()
  for (const run of runsNewestFirst) {
    const day = run.report_options?.day
    if (day && !byDay.has(day)) byDay.set(day, run.status === 'success' && validEvidence(run.report_options))
  }
  let consecutiveDays = 0
  const finished = latest?.finished_at ? Date.parse(latest.finished_at) : NaN
  const fresh = Number.isFinite(finished) && nowMs >= finished && nowMs - finished <= 36 * 60 * 60 * 1000
  const latestDay = latest?.report_options?.day
  if (fresh && latest?.status === 'success' && (latestDay === today || latestDay === shiftDate(today, -1))) {
    for (let day = latestDay; consecutiveDays < 7 && byDay.get(day); day = shiftDate(day, -1)) consecutiveDays++
  }
  return { ready: consecutiveDays >= 7, consecutiveDays, requiredDays: 7, lastCheckedAt: latest?.finished_at ?? null,
    message: consecutiveDays >= 7 ? 'Seven verified days complete. Rule review and launch checks remain.' : `Ads reconciliation: ${consecutiveDays} of 7 consecutive verified days. Recommendations remain in validation.` }
}
