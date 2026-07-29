// Pure decision logic behind findReusableReport() in scripts/sync-ads-reports.ts.
// The DB query there already filters to rows within the 30-day Amazon
// report-retention window (AMAZON_REPORT_RETENTION_MS) and orders by
// started_at desc -- this module only decides, given the single most
// recent matching row (or none), whether to reuse it and whether it
// already succeeded recently enough to skip re-importing. Extracted so
// this decision is covered by a real test independent of any live
// Supabase call.
export type ReusableReportRow = { status: string; amazon_report_id: string | null; started_at: string }
export type ReuseDecision = { reuse: boolean; amazonReportId: string | null; alreadySucceeded: boolean }

export const AMAZON_REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const SUCCESS_SKIP_MS = 6 * 60 * 60 * 1000

export function decideReportReuse(row: ReusableReportRow | null, now: Date): ReuseDecision {
  if (!row || !row.amazon_report_id) return { reuse: false, amazonReportId: null, alreadySucceeded: false }
  const successCutoffMs = now.getTime() - SUCCESS_SKIP_MS
  const alreadySucceeded = row.status === 'success' && new Date(row.started_at).getTime() >= successCutoffMs
  return { reuse: true, amazonReportId: row.amazon_report_id, alreadySucceeded }
}
