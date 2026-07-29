// Report-polling timeout resolution, shared by scripts/sync-ads-reports.ts
// and scripts/poll-pending-reports.ts. Extracted 2026-07-28 -- every Ads
// report type hit the old 900,000ms (15 min) default ceiling with Amazon
// still PENDING for 2 straight days (2026-07-27/28), while
// ads_sd_campaign_daily's own 1,500,000ms override kept succeeding. Raised
// the default to match. Extracted into its own pure function so this
// default is covered by a real test instead of only living inline in argv
// parsing.
export const DEFAULT_REPORT_TIMEOUT_MS = 1_500_000 // 25 min

export function resolveReportTimeoutMs(args: Map<string, string>): number {
  return args.has('report-timeout-ms') ? Number(args.get('report-timeout-ms')) : DEFAULT_REPORT_TIMEOUT_MS
}
