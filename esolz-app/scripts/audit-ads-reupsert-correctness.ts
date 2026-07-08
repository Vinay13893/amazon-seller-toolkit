// Build item #2 (APPROVED_BACKLOG.md): read-only verification that the Ads
// warehouse's trailing 14-day window is being re-upserted correctly, not
// left stale or duplicated. This is the gate that must be green before Ads
// Bleed (build item #3) can start.
//
// Read-only in every sense: no writes to any table, no calls to the Amazon
// Ads API. Reports aggregate counts only — no raw search terms, no order
// IDs, no PII.
//
// Usage:
//   npx tsx scripts/audit-ads-reupsert-correctness.ts
//   npx tsx scripts/audit-ads-reupsert-correctness.ts --workspaceId=<uuid> --days=14
//
// --- What "re-upsert" means here and how it's verified ---
// scripts/sync-ads-reports.ts re-syncs a rolling trailing window (the daily
// cron uses --days=14) every run. Rows are matched by dedupe_key (built in
// ads-campaign-daily-parser.ts / ads-deep-report-parser.ts as
// [reportDate, campaignId|campaignName, adGroup, targeting/keyword/searchTerm,
// matchType, sku, asin].join('|'), normalized) and the real conflict key is
// the DB-level unique index (workspace_id, profile_id, dedupe_key) added in
// migration 049. upsertByDedupeKey() in sync-ads-reports.ts is an
// application-level split (existing dedupe_key -> UPDATE by id, new ->
// INSERT), not a native ON CONFLICT — the unique index is the backstop that
// makes a bug in that split surface as a constraint violation instead of a
// silent duplicate.
//
// This script cannot re-run the Amazon Ads API itself without violating the
// "read-only against Amazon" constraint for a verification job, so instead
// of a live API diff it checks the evidence already sitting in Postgres:
//   1. No duplicate (workspace_id, profile_id, dedupe_key) groups in the
//      trailing window (would mean the unique index/onConflict logic failed).
//   2. Rows old enough to have been re-synced at least once (report_date
//      more than REUPSERT_EVIDENCE_MIN_AGE_DAYS old) show updated_at >
//      created_at — i.e. a later sync actually touched them, not just the
//      original insert. Below REUPSERT_EVIDENCE_PASS_RATIO is a WARN, not a
//      FAIL, since it's evidence of a a problem, not a constraint violation.
//   3. Row counts per report_date look sane (no unexplained zero-row gap
//      inside the window; no date wildly higher than the window's median,
//      which would suggest a duplicate-row leak the dedupe key didn't catch).
//   4. internal_data_refresh_runs shows sync windows actually overlapping
//      the trailing 14 days more than once — i.e. the "nightly re-upsert"
//      is really happening, not just a one-time backfill.
//
// --- reportId vs report_document_id ---
// The Amazon Ads Reporting API v3 (used by sync-ads-reports.ts) only has a
// `reportId` — an async report-generation job id, created via POST
// /reporting/reports, polled via GET /reporting/reports/{reportId} until
// status=COMPLETED, which then returns a one-time presigned `url` to
// download the CSV/JSON body. There is no separate "report document id" in
// this API. `reportId` is stored ONLY on internal_data_refresh_runs
// .amazon_report_id (used to reuse an in-flight/recent Amazon report instead
// of requesting a duplicate — see findReusableReport() in
// sync-ads-reports.ts) — it is never stored on the ads row tables
// themselves, which only carry upload_batch_id + dedupe_key.
// (The unrelated SP-API Reports flow used by scripts/sync-business-reports.ts
// for Business Reports does use a `reportDocumentId` concept — that is a
// different API and out of scope for this Ads-warehouse check.)

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { resolveBrahmastraProfile } from '../src/lib/internal/brahmastra-ads-profile-selection'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  // no .env.local present — fine outside local dev
}

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([a-zA-Z]+)=(.*)$/)
    if (m) args.set(m[1], m[2])
  }
  return args
}

const ADS_TABLES = [
  'internal_ads_campaign_daily_rows',
  'internal_ads_advertised_product_daily_rows',
  'internal_ads_targeting_daily_rows',
  'internal_ads_search_term_daily_rows',
] as const

const REUPSERT_EVIDENCE_MIN_AGE_DAYS = 3 // give ~2 nightly cron cycles to have touched the row
const REUPSERT_EVIDENCE_PASS_RATIO = 0.9
const ROW_COUNT_OUTLIER_MULTIPLE = 3

type TableCheck = {
  table: string
  totalRowsInWindow: number
  duplicateGroups: number
  reupsertEvidence: { eligibleRows: number; touchedRows: number; ratio: number | null; status: 'pass' | 'warn' | 'n/a' }
  rowCountByDate: Record<string, number>
  rowCountStatus: 'pass' | 'warn'
  rowCountNotes: string[]
}

async function fetchWindowRowsPaged(admin: SupabaseClient, table: string, workspaceId: string, profileId: string, windowStart: string): Promise<Array<{ dedupe_key: string; report_date: string; created_at: string; updated_at: string }>> {
  const PAGE = 1000
  const all: Array<{ dedupe_key: string; report_date: string; created_at: string; updated_at: string }> = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select('dedupe_key, report_date, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', windowStart)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    all.push(...((data ?? []) as typeof all))
    if (!data || data.length < PAGE) break
  }
  return all
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function checkTable(admin: SupabaseClient, table: string, workspaceId: string, profileId: string, windowStart: string, todayIso: string, cutoffIso: string): Promise<TableCheck> {
  const windowRows = await fetchWindowRowsPaged(admin, table, workspaceId, profileId, windowStart)

  // 1. Duplicate dedupe_key groups within the window (the DB unique index
  // covers all-time, not just this window — checking the window specifically
  // keeps this fast and focused on what a nightly re-upsert would touch).
  const keyCounts = new Map<string, number>()
  for (const row of windowRows) keyCounts.set(row.dedupe_key, (keyCounts.get(row.dedupe_key) ?? 0) + 1)
  const duplicateGroups = [...keyCounts.values()].filter(c => c > 1).length

  // 2. Re-upsert evidence: rows old enough to have been re-synced at least
  // once should show updated_at > created_at.
  const eligible = windowRows.filter(r => r.report_date <= cutoffIso)
  const touched = eligible.filter(r => new Date(r.updated_at).getTime() > new Date(r.created_at).getTime())
  const ratio = eligible.length > 0 ? touched.length / eligible.length : null
  const reupsertStatus: TableCheck['reupsertEvidence']['status'] =
    eligible.length === 0 ? 'n/a' : (ratio !== null && ratio >= REUPSERT_EVIDENCE_PASS_RATIO ? 'pass' : 'warn')

  // 3. Row counts by report_date — flag gaps and outliers.
  const rowCountByDate: Record<string, number> = {}
  for (const row of windowRows) rowCountByDate[row.report_date] = (rowCountByDate[row.report_date] ?? 0) + 1
  const notes: string[] = []
  const counts = Object.values(rowCountByDate)
  const med = median(counts)
  // Only flag gaps for dates strictly before today — today's sync may not
  // have run yet, which is expected and not a correctness problem.
  for (let d = windowStart; d < todayIso; d = addDaysIso(d, 1)) {
    if (!(d in rowCountByDate)) notes.push(`${d}: no rows at all inside the trailing window (gap)`)
  }
  for (const [date, count] of Object.entries(rowCountByDate)) {
    if (med > 0 && count > med * ROW_COUNT_OUTLIER_MULTIPLE) notes.push(`${date}: ${count} rows is >${ROW_COUNT_OUTLIER_MULTIPLE}x the window median (${med}) — possible duplicate-row leak`)
  }
  const rowCountStatus: TableCheck['rowCountStatus'] = notes.length === 0 ? 'pass' : 'warn'

  return {
    table,
    totalRowsInWindow: windowRows.length,
    duplicateGroups,
    reupsertEvidence: { eligibleRows: eligible.length, touchedRows: touched.length, ratio, status: reupsertStatus },
    rowCountByDate,
    rowCountStatus,
    rowCountNotes: notes,
  }
}

function addDaysIso(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const args = parseArgs()
  const days = Number.parseInt(args.get('days') ?? '14', 10)
  const todayIso = new Date().toISOString().slice(0, 10)
  const windowStart = addDaysIso(todayIso, -days)
  const cutoffIso = addDaysIso(todayIso, -REUPSERT_EVIDENCE_MIN_AGE_DAYS)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log('Ads warehouse trailing re-upsert correctness check (read-only, aggregate counts only, no PII, no Amazon API calls)')
  console.log('='.repeat(78))
  console.log(`Window: ${windowStart} .. ${todayIso} (${days} days) — re-upsert evidence requires report_date <= ${cutoffIso}`)

  let workspaceId = args.get('workspaceId')
  if (!workspaceId) {
    const { data } = await admin.from('internal_ads_campaign_daily_rows').select('workspace_id').limit(1)
    workspaceId = data?.[0]?.workspace_id as string | undefined
  }
  if (!workspaceId) {
    console.error('BLOCKED: no workspace found with any Ads data (pass --workspaceId= to target a specific one).')
    process.exitCode = 1
    return
  }
  console.log(`Workspace: ${workspaceId}`)

  const { data: profileRows, error: profileError } = await admin
    .from('amazon_ads_profiles')
    .select('profile_id, brahmastra_sync_enabled, is_primary')
    .eq('workspace_id', workspaceId)
  if (profileError || !profileRows) {
    console.error(`BLOCKED: could not read amazon_ads_profiles — ${profileError?.message ?? 'unknown error'}`)
    process.exitCode = 1
    return
  }
  const selection = resolveBrahmastraProfile(profileRows.map(p => ({
    profileId: p.profile_id as string,
    brahmastraSyncEnabled: p.brahmastra_sync_enabled as boolean,
    isPrimary: p.is_primary as boolean,
  })))
  if (!selection.ok) {
    console.error(`BLOCKED: ${selection.message}`)
    process.exitCode = 1
    return
  }
  const profileId = selection.profileId
  console.log(`Profile: ${profileId}`)

  // Sync-run overlap evidence — is the nightly re-upsert actually happening,
  // not just a one-time backfill?
  const { data: recentRuns } = await admin
    .from('internal_data_refresh_runs')
    .select('source, date_from, date_to, status, started_at')
    .eq('workspace_id', workspaceId)
    .like('source', 'ads_%')
    .gte('started_at', new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000).toISOString())
    .order('started_at', { ascending: false })
    .limit(200)
  const runsBySource = new Map<string, Array<{ date_from: string; date_to: string; started_at: string }>>()
  for (const run of recentRuns ?? []) {
    const list = runsBySource.get(run.source as string) ?? []
    list.push({ date_from: run.date_from as string, date_to: run.date_to as string, started_at: run.started_at as string })
    runsBySource.set(run.source as string, list)
  }
  console.log('\n[Sync overlap evidence] Ads sources with >1 run whose window overlaps the trailing window in the last ' + (days * 2) + ' days:')
  let sourcesWithRepeatCoverage = 0
  for (const [source, runs] of runsBySource) {
    const overlapping = runs.filter(r => r.date_to >= windowStart)
    if (overlapping.length > 1) sourcesWithRepeatCoverage += 1
    console.log(`  ${source}: ${runs.length} run(s) total, ${overlapping.length} overlapping the trailing window`)
  }
  const overlapStatus: 'pass' | 'warn' = sourcesWithRepeatCoverage > 0 ? 'pass' : 'warn'
  console.log(`  Repeat-coverage status: ${overlapStatus.toUpperCase()} (${sourcesWithRepeatCoverage} source(s) show repeat coverage of the trailing window)`)

  const tableChecks: TableCheck[] = []
  for (const table of ADS_TABLES) {
    console.log(`\n[${table}]`)
    const check = await checkTable(admin, table, workspaceId, profileId, windowStart, todayIso, cutoffIso)
    tableChecks.push(check)
    console.log(`  Rows in window        : ${check.totalRowsInWindow}`)
    console.log(`  Duplicate key groups   : ${check.duplicateGroups} ${check.duplicateGroups > 0 ? '<-- FAIL' : '(none)'}`)
    console.log(`  Re-upsert evidence     : ${check.reupsertEvidence.touchedRows}/${check.reupsertEvidence.eligibleRows} eligible rows touched by a later sync` + (check.reupsertEvidence.ratio !== null ? ` (${(check.reupsertEvidence.ratio * 100).toFixed(1)}%)` : ' (no eligible rows yet)') + ` -> ${check.reupsertEvidence.status.toUpperCase()}`)
    console.log(`  Row-count-by-date     : ${check.rowCountStatus.toUpperCase()}`)
    for (const note of check.rowCountNotes) console.log(`    - ${note}`)
  }

  const anyDuplicates = tableChecks.some(c => c.duplicateGroups > 0)
  const anyReupsertWarn = tableChecks.some(c => c.reupsertEvidence.status === 'warn')
  const anyRowCountWarn = tableChecks.some(c => c.rowCountStatus === 'warn')

  const overallStatus: 'pass' | 'warn' | 'fail' = anyDuplicates
    ? 'fail'
    : (anyReupsertWarn || anyRowCountWarn || overlapStatus === 'warn')
      ? 'warn'
      : 'pass'

  const summary = {
    checkedAt: new Date().toISOString(),
    workspaceId,
    profileId,
    windowStart,
    windowEnd: todayIso,
    overallStatus,
    adsBleedUnblocked: overallStatus === 'pass',
    syncOverlapEvidence: { status: overlapStatus, sourcesWithRepeatCoverage, sourcesChecked: runsBySource.size },
    tables: tableChecks.map(c => ({
      table: c.table,
      rowsInWindow: c.totalRowsInWindow,
      duplicateGroups: c.duplicateGroups,
      reupsertEvidence: c.reupsertEvidence,
      rowCountStatus: c.rowCountStatus,
      rowCountNoteCount: c.rowCountNotes.length,
    })),
  }

  console.log('\n' + '='.repeat(78))
  console.log(`OVERALL STATUS: ${overallStatus.toUpperCase()}`)
  console.log('Ads Bleed (build item #3) unblocked by this check: ' + (summary.adsBleedUnblocked ? 'YES' : 'NO — see warnings/failures above'))
  console.log('\nJSON summary:')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
