// Business Report sales-grain fix — historical repair / reconciliation
// script (spec Phase 6). Companion to scripts/sync-business-reports.ts,
// which fixes the ingestion bug going forward; this script re-derives and
// safely re-writes (only with explicit, multi-gated approval) historical
// SKU-level rows that were stored under the OLD, wrong multi-day-range
// grain, ONE ALREADY-VALIDATED CALENDAR DAY AT A TIME.
//
// SAFETY MODEL (read before running):
//   - DRY RUN IS THE DEFAULT for every invocation. No code path in this
//     script writes anything to Supabase unless --execute-write AND
//     --confirm="<exact phrase>" are BOTH passed, AND the reconciliation
//     verdict for that specific date is within the (currently
//     UN-approved) tolerance, AND TOLERANCE_APPROVED_BY_FOUNDER in
//     src/lib/internal/business-report-repair-write-gate.ts is `true`.
//     That constant is hardcoded `false` in this codebase today, so this
//     script cannot write to production no matter what flags are passed,
//     until a human deliberately changes that constant after the founder
//     has actually approved a reconciliation tolerance. See
//     evaluateWriteGate() for the exact, independently-checked gates.
//   - Never calls an Amazon WRITE endpoint. In --mode=live it calls the
//     exact same read-only createReport/getReport/getReportDocument
//     sequence as scripts/sync-business-reports.ts, one single calendar
//     day at a time (dateFrom === dateTo always — see
//     business-report-grain-guard.ts).
//   - --mode=inspect never calls Amazon at all — it only reads Supabase's
//     ALREADY-INGESTED internal_business_report_sales_traffic_daily
//     (by-date, ground truth) and internal_business_report_sku_sales_traffic
//     (by-SKU, the corrupted comparand) tables for the requested range, and
//     reports the discrepancy. This is the mode used to produce Phase 7's
//     evidence in a session with no live Amazon SP-API credentials
//     available — every field that would require a fresh Amazon call is
//     explicitly labeled unavailable, never fabricated.
//
// Usage:
//   npx tsx scripts/repair-business-report-sku-daily.ts --date-start=2026-07-01 --date-end=2026-07-28 --mode=inspect
//   npx tsx scripts/repair-business-report-sku-daily.ts --date-start=2026-07-01 --date-end=2026-07-28 --mode=live --workspace-id=... --marketplace-id=A21TJRUUN4KGV
//   npx tsx scripts/repair-business-report-sku-daily.ts --date-start=... --date-end=... --mode=live --execute-write --confirm="I UNDERSTAND THIS OVERWRITES PRODUCTION SKU SALES DATA"
//   npx tsx scripts/repair-business-report-sku-daily.ts --date-start=... --date-end=... --mode=live --strict-exact-match   # diagnostic: 0% tolerance
//   npx tsx scripts/repair-business-report-sku-daily.ts --date-start=... --date-end=... --mode=live --resume             # continue from checkpoint
//
// Exit codes (deterministic):
//   0 — every requested date was evaluated (dry-run) or written (write mode) without error.
//   1 — invalid arguments / missing requirement — nothing was attempted.
//   2 — at least one date could not be classified 'success'/'within_tolerance' — informational, not a crash.
//
// Required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (both modes); additionally SPAPI_ENCRYPTION_KEY, SPAPI_LWA_CLIENT_ID,
// SPAPI_LWA_CLIENT_SECRET for --mode=live. Never hardcoded, never logged.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import { refreshAccessToken } from '../src/lib/amazon/lwa'
import { createAmazonReport, getAmazonReportDocument, downloadAmazonReportDocument } from '../src/lib/amazon/reports'
import {
  SALES_AND_TRAFFIC_REPORT_TYPE,
  parseSalesAndTrafficReport,
  waitForSalesAndTrafficReport,
} from '../src/lib/internal/business-report-sp-api-client'
import {
  resolveMarketplaceTimezone,
  enumerateCalendarDays,
  marketplaceCalendarDayWindow,
  marketplaceTodayIso,
} from '../src/lib/internal/business-report-marketplace-time'
import { resolveSkuReportDate } from '../src/lib/internal/business-report-grain-guard'
import { validateSkuRows, classifyStructuralCompleteness } from '../src/lib/internal/business-report-run-outcome'
import { computeDateScopeReplacement, skuScopeKey } from '../src/lib/internal/business-report-date-scope-replace'
import {
  computeReconciliationDiff, reconciliationVerdict, PROPOSED_SALES_TOLERANCE_PCT, type ReconciliationMode,
} from '../src/lib/internal/business-report-reconciliation'
import { evaluateWriteGate, TOLERANCE_APPROVED_BY_FOUNDER, type WriteGateVerdict } from '../src/lib/internal/business-report-repair-write-gate'
import { computeRunId, resumeStartDate, recordDateCompleted, type RepairCheckpoint } from '../src/lib/internal/business-report-repair-checkpoint'

const AMAZON_CREDENTIALS_UNAVAILABLE = 'N/A — requires a live run with real Amazon credentials in the deployed environment, not available in this session'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  // no .env.local present — fine on Render, which sets real env vars directly
}

const SKU_TABLE = 'internal_business_report_sku_sales_traffic'
const BY_DATE_TABLE = 'internal_business_report_sales_traffic_daily'

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const withValue = arg.match(/^--([a-zA-Z-]+)=(.*)$/)
    if (withValue) { args.set(withValue[1], withValue[2]); continue }
    const bareFlag = arg.match(/^--([a-zA-Z-]+)$/)
    if (bareFlag) args.set(bareFlag[1], '1')
  }
  return args
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function isValidDateString(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

type PerSkuFinding = {
  sku: string | null
  childAsin: string | null
  parentAsin: string | null
  oldStoredOrderedSales: number | null
  oldStoredUnits: number | null
}

type DateReport = {
  date: string
  marketplaceTimezone: string
  amazonReportId: string
  requestedAt: string
  completedAt: string
  byDateRowsReceived: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  bySkuRowsReceived: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  skuRowsAccepted: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  skuRowsRejected: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  rejectionReasons: string[]
  existingStoredRows: number
  wouldInsert: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  wouldUpdate: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  wouldDelete: number | typeof AMAZON_CREDENTIALS_UNAVAILABLE
  accountOrderedSales: number | null
  summedSkuOrderedSales: number
  salesAbsDiff: number | null
  salesPctDiff: number | null
  accountUnits: number | null
  summedSkuUnits: number
  unitsAbsDiff: number | null
  unitsPctDiff: number | null
  reconciliationVerdict: WriteGateVerdict
  structuralStatus: 'success' | 'partial_success' | 'failed' | 'not_evaluated'
  writePermitted: boolean
  writeBlockedReason: string
  writeExecuted: boolean
  sampleSkuFindings: PerSkuFinding[]
}

const SAMPLE_SKUS = [
  'eva_mats_multi_16', 'LT_Baby_Play_Mat_S', 'LT_EVA_MULTI_16', 'LT_Baby_Play_Mat_R_L',
  'LT_Baby_Play_Mat_R_S', 'insulation_cover_1000', 'EH_DIAMOND_EVA_MULTI_PO18',
  'LIL_DIAMOND_EVA_MULTI_PO9_NEW', '54-Y94B-A1SC',
]

async function loadCheckpoint(path: string): Promise<RepairCheckpoint | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RepairCheckpoint
  } catch {
    return null
  }
}

function saveCheckpoint(path: string, checkpoint: RepairCheckpoint): void {
  writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf8')
}

/** --mode=inspect: reads ONLY already-ingested Supabase rows, never calls Amazon. Every Amazon-only field is explicitly marked unavailable, never fabricated. */
async function inspectDate(admin: SupabaseClient, workspaceId: string, marketplaceId: string, day: string, timeZone: string): Promise<DateReport> {
  const [{ data: byDateRow }, { data: skuRows }] = await Promise.all([
    admin.from(BY_DATE_TABLE).select('ordered_product_sales, units_ordered').eq('workspace_id', workspaceId).eq('marketplace_id', marketplaceId).eq('report_date', day).maybeSingle(),
    admin.from(SKU_TABLE).select('sku, child_asin, parent_asin, ordered_product_sales, units_ordered').eq('workspace_id', workspaceId).eq('marketplace_id', marketplaceId).eq('report_date', day),
  ])

  const accountOrderedSales = byDateRow ? (byDateRow.ordered_product_sales as number) : null
  const accountUnits = byDateRow ? (byDateRow.units_ordered as number) : null
  const rows = skuRows ?? []
  const summedSkuOrderedSales = rows.reduce((sum, r) => sum + (Number(r.ordered_product_sales) || 0), 0)
  const summedSkuUnits = rows.reduce((sum, r) => sum + (Number(r.units_ordered) || 0), 0)

  const diff = computeReconciliationDiff({
    accountOrderedSales: accountOrderedSales ?? 0,
    skuOrderedSalesSum: summedSkuOrderedSales,
    accountUnits: accountUnits ?? 0,
    skuUnitsSum: summedSkuUnits,
  })
  // Inspect mode reports the account-vs-stored-SKU discrepancy for VISIBILITY
  // only — it never gates a write (mode=inspect never writes at all, and
  // never calls Amazon, so it can't validate a corrected day's structure).
  const verdict = accountOrderedSales === null ? 'unknown' : reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT })

  const bySku = new Map<string, PerSkuFinding>()
  for (const sample of SAMPLE_SKUS) {
    const match = rows.find(r => r.sku === sample)
    bySku.set(sample, {
      sku: sample,
      childAsin: match ? (match.child_asin as string | null) : null,
      parentAsin: match ? (match.parent_asin as string | null) : null,
      oldStoredOrderedSales: match ? Number(match.ordered_product_sales) : null,
      oldStoredUnits: match ? Number(match.units_ordered) : null,
    })
  }

  return {
    date: day,
    marketplaceTimezone: timeZone,
    amazonReportId: AMAZON_CREDENTIALS_UNAVAILABLE,
    requestedAt: AMAZON_CREDENTIALS_UNAVAILABLE,
    completedAt: AMAZON_CREDENTIALS_UNAVAILABLE,
    byDateRowsReceived: AMAZON_CREDENTIALS_UNAVAILABLE,
    bySkuRowsReceived: AMAZON_CREDENTIALS_UNAVAILABLE,
    skuRowsAccepted: AMAZON_CREDENTIALS_UNAVAILABLE,
    skuRowsRejected: AMAZON_CREDENTIALS_UNAVAILABLE,
    rejectionReasons: [],
    existingStoredRows: rows.length,
    wouldInsert: AMAZON_CREDENTIALS_UNAVAILABLE,
    wouldUpdate: AMAZON_CREDENTIALS_UNAVAILABLE,
    wouldDelete: AMAZON_CREDENTIALS_UNAVAILABLE,
    accountOrderedSales,
    summedSkuOrderedSales,
    salesAbsDiff: diff.salesAbsDiff,
    salesPctDiff: diff.salesPctDiff,
    accountUnits,
    summedSkuUnits,
    unitsAbsDiff: diff.unitsAbsDiff,
    unitsPctDiff: diff.unitsPctDiff,
    reconciliationVerdict: verdict,
    structuralStatus: 'not_evaluated',
    writePermitted: false,
    writeBlockedReason: 'inspect_mode_never_writes',
    writeExecuted: false,
    sampleSkuFindings: [...bySku.values()],
  }
}

/** --mode=live: real single-day Amazon SP-API fetch, mirroring scripts/sync-business-reports.ts's per-day request exactly. */
async function liveDate(
  admin: SupabaseClient,
  accessToken: string,
  workspaceId: string,
  marketplaceId: string,
  day: string,
  timeZone: string,
  reportTimeoutMs: number,
  toleranceMode: ReconciliationMode,
  executeWrite: boolean,
  confirmPhrase: string | null,
): Promise<DateReport> {
  const requestedAt = new Date().toISOString()
  const window = marketplaceCalendarDayWindow(day, timeZone)
  const created = await createAmazonReport(accessToken, {
    reportType: SALES_AND_TRAFFIC_REPORT_TYPE,
    marketplaceIds: [marketplaceId],
    dataStartTime: window.dataStartTime,
    dataEndTime: window.dataEndTime,
    reportOptions: { dateGranularity: 'DAY', asinGranularity: 'SKU' },
  })
  const waitResult = await waitForSalesAndTrafficReport(accessToken, created.reportId, { maxWaitMs: reportTimeoutMs })
  if (waitResult.status !== 'DONE') {
    throw new Error(`Report ${created.reportId} for ${day} ended in terminal state ${waitResult.status} (not DONE).`)
  }
  const completedAt = new Date().toISOString()
  const document = await getAmazonReportDocument(accessToken, waitResult.reportDocumentId)
  const rawJson = await downloadAmazonReportDocument(document)
  const parsed = parseSalesAndTrafficReport(rawJson)

  const skuReportDate = resolveSkuReportDate(day, day) // fail-closed grain guard, always day===day here
  const byDateMatches = parsed.byDate.filter(r => r.date === day)
  const { accepted, rejected } = validateSkuRows(parsed.byAsin)
  const completeness = classifyStructuralCompleteness({
    byDateMatchCount: byDateMatches.length,
    byDateOrderedProductSales: byDateMatches[0]?.orderedProductSales ?? null,
    skuRowsFetched: parsed.byAsin.length,
    skuRowsRejected: rejected.length,
  })

  const accountOrderedSales = byDateMatches[0]?.orderedProductSales ?? null
  const accountUnits = byDateMatches[0]?.unitsOrdered ?? null
  const summedSkuOrderedSales = accepted.reduce((sum, r) => sum + r.orderedProductSales, 0)
  const summedSkuUnits = accepted.reduce((sum, r) => sum + r.unitsOrdered, 0)
  const diff = computeReconciliationDiff({
    accountOrderedSales: accountOrderedSales ?? 0,
    skuOrderedSalesSum: summedSkuOrderedSales,
    accountUnits: accountUnits ?? 0,
    skuUnitsSum: summedSkuUnits,
  })
  const verdict: WriteGateVerdict = accountOrderedSales === null ? 'unknown' : reconciliationVerdict(diff, toleranceMode)

  const { data: existingRows } = await admin
    .from(SKU_TABLE)
    .select('id, sku_norm, child_asin, parent_asin, sku, ordered_product_sales, units_ordered')
    .eq('workspace_id', workspaceId).eq('marketplace_id', marketplaceId).eq('report_date', skuReportDate)
  const existingScoped = (existingRows ?? []).map(r => ({ id: r.id as string, key: skuScopeKey({ sku_norm: r.sku_norm as string | null, child_asin: r.child_asin as string | null, parent_asin: r.parent_asin as string | null }) }))
  const newRows = accepted.map(r => ({
    sku_norm: r.sku ? r.sku.toLocaleUpperCase('en-US') : null,
    child_asin: r.childAsin,
    parent_asin: r.parentAsin,
    sku: r.sku,
    ordered_product_sales: r.orderedProductSales,
    units_ordered: r.unitsOrdered,
  }))
  const plan = computeDateScopeReplacement(existingScoped, newRows, row => skuScopeKey(row))

  const gate = evaluateWriteGate({
    executeWriteFlag: executeWrite,
    confirmationPhrase: confirmPhrase,
    reconciliationVerdict: verdict,
    toleranceApproved: TOLERANCE_APPROVED_BY_FOUNDER,
    structuralStatus: completeness.status,
  })

  let writeExecuted = false
  if (gate.writePermitted) {
    // Unreachable in this codebase today (TOLERANCE_APPROVED_BY_FOUNDER is
    // hardcoded false) — kept as real, correct code for the day a founder
    // approval lands, rather than a stub, but this task never exercises it.
    if (plan.toInsert.length > 0) await admin.from(SKU_TABLE).insert(plan.toInsert)
    if (plan.toUpdate.length > 0) await admin.from(SKU_TABLE).upsert(plan.toUpdate, { onConflict: 'id' })
    if (plan.toDeleteIds.length > 0) await admin.from(SKU_TABLE).delete().in('id', plan.toDeleteIds)
    writeExecuted = true
  }

  const bySku = new Map<string, PerSkuFinding>()
  for (const sample of SAMPLE_SKUS) {
    const oldMatch = (existingRows ?? []).find(r => r.sku === sample)
    bySku.set(sample, {
      sku: sample,
      childAsin: oldMatch ? (oldMatch.child_asin as string | null) : null,
      parentAsin: oldMatch ? (oldMatch.parent_asin as string | null) : null,
      oldStoredOrderedSales: oldMatch ? Number(oldMatch.ordered_product_sales) : null,
      oldStoredUnits: oldMatch ? Number(oldMatch.units_ordered) : null,
    })
  }

  return {
    date: day,
    marketplaceTimezone: timeZone,
    amazonReportId: created.reportId,
    requestedAt,
    completedAt,
    byDateRowsReceived: parsed.byDate.length,
    bySkuRowsReceived: parsed.byAsin.length,
    skuRowsAccepted: accepted.length,
    skuRowsRejected: rejected.length,
    rejectionReasons: [...new Set(rejected.map(r => r.reason))],
    existingStoredRows: existingScoped.length,
    wouldInsert: plan.toInsert.length,
    wouldUpdate: plan.toUpdate.length,
    wouldDelete: plan.toDeleteIds.length,
    accountOrderedSales,
    summedSkuOrderedSales,
    salesAbsDiff: diff.salesAbsDiff,
    salesPctDiff: diff.salesPctDiff,
    accountUnits,
    summedSkuUnits,
    unitsAbsDiff: diff.unitsAbsDiff,
    unitsPctDiff: diff.unitsPctDiff,
    reconciliationVerdict: verdict,
    structuralStatus: completeness.status,
    writePermitted: gate.writePermitted,
    writeBlockedReason: gate.reason,
    writeExecuted,
    sampleSkuFindings: [...bySku.values()],
  }
}

function writeJsonReport(outDir: string, runId: string, reports: DateReport[]): string {
  const path = resolve(outDir, `repair-report-${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify({ runId, generatedAt: new Date().toISOString(), dates: reports }, null, 2), 'utf8')
  return path
}

function writeCsvReport(outDir: string, runId: string, reports: DateReport[]): string {
  const header = [
    'date', 'accountOrderedSales', 'summedSkuOrderedSales', 'salesAbsDiff', 'salesPctDiff',
    'accountUnits', 'summedSkuUnits', 'unitsAbsDiff', 'unitsPctDiff',
    'reconciliationVerdict', 'structuralStatus', 'existingStoredRows', 'wouldInsert', 'wouldUpdate', 'wouldDelete',
    'writePermitted', 'writeBlockedReason', 'writeExecuted',
  ]
  const csvEscape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.join(',')]
  for (const r of reports) {
    lines.push(header.map(key => csvEscape((r as unknown as Record<string, unknown>)[key])).join(','))
  }
  const path = resolve(outDir, `repair-discrepancies-${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.csv`)
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

async function main() {
  const args = parseArgs()
  const dateStartArg = args.get('date-start')
  const dateEndArg = args.get('date-end')
  if (!isValidDateString(dateStartArg) || !isValidDateString(dateEndArg)) {
    console.error('Missing requirement: --date-start=YYYY-MM-DD and --date-end=YYYY-MM-DD are both required.')
    process.exitCode = 1
    return
  }
  if (dateStartArg > dateEndArg) {
    console.error(`Missing requirement: --date-start (${dateStartArg}) must not be after --date-end (${dateEndArg}).`)
    process.exitCode = 1
    return
  }

  const mode = args.get('mode') ?? 'inspect' // dry-run-safe default: never calls Amazon unless explicitly asked
  if (mode !== 'inspect' && mode !== 'live') {
    console.error(`Missing requirement: --mode must be "inspect" or "live" (got "${mode}").`)
    process.exitCode = 1
    return
  }
  const strictExactMatch = args.has('strict-exact-match')
  const toleranceMode: ReconciliationMode = strictExactMatch
    ? { kind: 'strict_exact_match' }
    : { kind: 'tolerance', salesTolerancePct: args.has('tolerance-pct') ? Number(args.get('tolerance-pct')) : PROPOSED_SALES_TOLERANCE_PCT }
  const executeWrite = args.has('execute-write')
  const confirmPhrase = args.get('confirm') ?? null
  const resume = args.has('resume')
  const reportTimeoutMs = args.has('report-timeout-ms') ? Number(args.get('report-timeout-ms')) : 900_000

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing requirement: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  let workspaceId = args.get('workspace-id') ?? null
  let marketplaceId = args.get('marketplace-id') ?? null
  let refreshTokenEncrypted: string | null = null
  if (!workspaceId || !marketplaceId || mode === 'live') {
    let connectionQuery = admin.from('amazon_connections').select('workspace_id, marketplace_id, refresh_token_encrypted, status')
    if (workspaceId) connectionQuery = connectionQuery.eq('workspace_id', workspaceId)
    const { data: connections, error: connError } = await connectionQuery.eq('status', 'active').limit(5)
    if (connError || !connections || connections.length === 0) {
      console.error('Missing requirement: could not resolve an active amazon_connections row (pass --workspace-id / --marketplace-id explicitly, or connect Seller Central first).')
      process.exitCode = 1
      return
    }
    const connection = connections[0]
    workspaceId = workspaceId ?? (connection.workspace_id as string)
    marketplaceId = marketplaceId ?? (connection.marketplace_id as string)
    refreshTokenEncrypted = connection.refresh_token_encrypted as string
  }
  if (!workspaceId || !marketplaceId) {
    console.error('Missing requirement: --workspace-id and --marketplace-id could not be resolved.')
    process.exitCode = 1
    return
  }

  const timeZone = resolveMarketplaceTimezone(marketplaceId)
  if (!timeZone) {
    console.error(`Missing requirement: no known timezone for marketplace ${marketplaceId} — refusing to guess UTC.`)
    process.exitCode = 1
    return
  }

  if (mode === 'live' && executeWrite && !TOLERANCE_APPROVED_BY_FOUNDER) {
    console.log('NOTE: --execute-write was passed, but TOLERANCE_APPROVED_BY_FOUNDER is hardcoded false in src/lib/internal/business-report-repair-write-gate.ts — every date in this run will still be dry-run only. This is intentional; see that file\'s doc comment.')
  }

  const outDir = args.get('out-dir') ?? resolve(process.cwd(), '.reports', 'business-report-repair')
  mkdirSync(outDir, { recursive: true })
  const checkpointPath = args.get('checkpoint-file') ?? resolve(outDir, 'checkpoint.json')
  const runId = computeRunId(workspaceId, marketplaceId, dateStartArg, dateEndArg, mode)
  const existingCheckpoint = resume ? await loadCheckpoint(checkpointPath) : null
  const effectiveDateStart = resume ? resumeStartDate(existingCheckpoint, runId, dateStartArg) : dateStartArg
  const days = enumerateCalendarDays(effectiveDateStart, dateEndArg)

  console.log(`Business Report SKU repair/reconciliation — mode=${mode}${strictExactMatch ? ' (strict exact match)' : ''}, workspace=${workspaceId}, marketplace=${marketplaceId} (${timeZone}), range ${dateStartArg} → ${dateEndArg}${resume ? ` (resuming from ${effectiveDateStart})` : ''}. Marketplace "today" is ${marketplaceTodayIso(timeZone)}. execute-write=${executeWrite}, confirm-phrase-provided=${Boolean(confirmPhrase)}, TOLERANCE_APPROVED_BY_FOUNDER=${TOLERANCE_APPROVED_BY_FOUNDER}.`)
  if (days.length === 0) {
    console.log('Nothing to do — range is already fully checkpointed.')
    return
  }

  let accessToken: string | null = null
  if (mode === 'live') {
    if (!refreshTokenEncrypted) {
      const { data: conn } = await admin.from('amazon_connections').select('refresh_token_encrypted').eq('workspace_id', workspaceId).eq('status', 'active').limit(1).maybeSingle()
      refreshTokenEncrypted = (conn?.refresh_token_encrypted as string | undefined) ?? null
    }
    if (!refreshTokenEncrypted) {
      console.error('Missing requirement: --mode=live needs an active amazon_connections row with a refresh token.')
      process.exitCode = 1
      return
    }
    const refreshToken = decryptToken(refreshTokenEncrypted)
    const tokenResult = await refreshAccessToken(refreshToken)
    accessToken = tokenResult.access_token
  }

  const reports: DateReport[] = []
  let checkpoint = existingCheckpoint
  let blockedCount = 0
  for (const day of days) {
    console.log(`Processing ${day}...`)
    let report: DateReport
    try {
      report = mode === 'inspect'
        ? await inspectDate(admin, workspaceId, marketplaceId, day, timeZone)
        : await liveDate(admin, accessToken as string, workspaceId, marketplaceId, day, timeZone, reportTimeoutMs, toleranceMode, executeWrite, confirmPhrase)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  ${day}: FAILED — ${message}`)
      console.error(`  Stopping — spec requires the repair script to stop on reconciliation/fetch failure rather than silently continue past a bad day.`)
      reports.push({
        date: day, marketplaceTimezone: timeZone, amazonReportId: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 'error',
        requestedAt: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : new Date().toISOString(),
        completedAt: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : new Date().toISOString(),
        byDateRowsReceived: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        bySkuRowsReceived: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        skuRowsAccepted: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        skuRowsRejected: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        rejectionReasons: [message], existingStoredRows: 0,
        wouldInsert: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        wouldUpdate: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        wouldDelete: mode === 'inspect' ? AMAZON_CREDENTIALS_UNAVAILABLE : 0,
        accountOrderedSales: null, summedSkuOrderedSales: 0, salesAbsDiff: null, salesPctDiff: null,
        accountUnits: null, summedSkuUnits: 0, unitsAbsDiff: null, unitsPctDiff: null,
        reconciliationVerdict: 'unknown', structuralStatus: 'failed',
        writePermitted: false, writeBlockedReason: 'fetch_or_reconciliation_error', writeExecuted: false,
        sampleSkuFindings: [],
      })
      process.exitCode = 2
      break // stop on failure, one date at a time, per spec — do not silently continue
    }
    reports.push(report)
    if (report.reconciliationVerdict !== 'within_tolerance') blockedCount += 1
    checkpoint = recordDateCompleted(checkpoint, runId, day)
    saveCheckpoint(checkpointPath, checkpoint)
    console.log(`  ${day}: verdict=${report.reconciliationVerdict}, structuralStatus=${report.structuralStatus}, writePermitted=${report.writePermitted} (${report.writeBlockedReason}), salesPctDiff=${report.salesPctDiff === null ? 'n/a' : report.salesPctDiff.toFixed(2) + '%'}.`)
  }

  const jsonPath = writeJsonReport(outDir, runId, reports)
  const csvPath = writeCsvReport(outDir, runId, reports)
  console.log(`\nJSON report: ${jsonPath}`)
  console.log(`CSV discrepancy report: ${csvPath}`)
  console.log(`Checkpoint file: ${checkpointPath}`)
  console.log(`\nSummary: ${reports.length} date(s) evaluated, ${blockedCount} not within tolerance, ${reports.filter(r => r.writeExecuted).length} actually written (must be 0 in this session).`)

  if (process.exitCode === 2) return // already set on the failure path above
  if (blockedCount > 0 && process.exitCode !== 1) process.exitCode = blockedCount === reports.length ? 2 : 2
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
