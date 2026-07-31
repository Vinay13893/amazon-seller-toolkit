// Phase R8: automated Seller Central Business Report sync ("Sales and
// Traffic by Date" + "by ASIN/SKU") via the SP-API Reports API
// (GET_SALES_AND_TRAFFIC_REPORT). Read-only against Amazon — only ever
// creates a report and reads it back. Never calls a write endpoint, never
// touches Amazon Ads sync, never touches payment-transaction data.
//
// Sales-grain fix (this revision): Amazon's `salesAndTrafficByAsin`
// section has NO per-day breakdown of its own — for a multi-day request
// it is a TOTAL for the entire requested range, not one day. The
// PREVIOUS version of this script requested one 14-day rolling window per
// run and stored that window's SKU-level TOTAL under a single
// `report_date` (the window's last day), which compounds into massive
// (~9x-23x observed) inflation once multiple overlapping daily runs are
// summed downstream. This version requests SKU-level (and, incidentally,
// by-date) data ONE MARKETPLACE-LOCAL CALENDAR DAY AT A TIME — every
// request this script makes now has dateFrom === dateTo, so the by-ASIN
// section is always genuinely that one day's data, never a range total.
// See src/lib/internal/business-report-grain-guard.ts for the invariant
// this enforces (fail-closed, never silently distributes a range total
// across days).
//
// Usage:
//   npx tsx scripts/sync-business-reports.ts                          # default: last 14 days
//   npx tsx scripts/sync-business-reports.ts --days=30                # 30-day backfill/correction window
//   npx tsx scripts/sync-business-reports.ts --date-start=2026-06-15 --date-end=2026-06-15
//   npx tsx scripts/sync-business-reports.ts --workspace-id=... --marketplace-id=A21TJRUUN4KGV
//   npx tsx scripts/sync-business-reports.ts --dry-run                # parse only, write nothing
//   npx tsx scripts/sync-business-reports.ts --force-refresh          # re-request every day in range, even already-confirmed ones
//   npx tsx scripts/sync-business-reports.ts --report-timeout-ms=900000
//
// Required env vars (Render): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SPAPI_ENCRYPTION_KEY, SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET.
//
// Credentials: resolved from an active amazon_connections row (one per
// workspace) — decrypts the stored refresh token and exchanges it for a
// fresh LWA access token. Does NOT use AWS IAM/SigV4 (SP-API deprecated
// that requirement; LWA-only auth is correct here).
//
// Reliability (mirrors scripts/sync-ads-reports.ts's pattern):
//   - A per-workspace+marketplace concurrency lock (via internal_data_refresh_runs,
//     source='business_report_sp_api') prevents two sync runs from racing.
//   - Stale "running" rows older than 2 hours are cleaned up at startup.
//   - Each calendar day is its own Amazon report request + its own
//     internal_data_refresh_runs row (date_from === date_to always). A day
//     already 'confirmed complete' (status='success', rows_rejected=0) is
//     skipped without an Amazon call unless --force-refresh is passed —
//     see shouldSkipAlreadyConfirmedDate() — so the switch to per-day
//     requests doesn't multiply Amazon Reports API call volume on every
//     run of a rolling window whose earlier days are already correct.
//   - Re-running for the same exact single day within a few hours reuses
//     the in-flight/just-finished Amazon report instead of requesting a
//     new one, unless --force-refresh is passed.
//   - 429s are backed off (see waitForSalesAndTrafficReport).
//   - Days are processed strictly sequentially (never in parallel) —
//     bounded, predictable load on Amazon's low-quota Reports API.
//   - Manual CSV import (src/lib/internal/business-report-sales-traffic-parser.ts)
//     remains available as a backup path — this script only adds automation
//     on top of it; it does not replace or remove the manual importer.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import { refreshAccessToken } from '../src/lib/amazon/lwa'
import { createAmazonReport, getAmazonReportDocument, downloadAmazonReportDocument } from '../src/lib/amazon/reports'
import {
  SALES_AND_TRAFFIC_REPORT_TYPE,
  parseSalesAndTrafficReport,
  waitForSalesAndTrafficReport,
  resolveBusinessReportSkuPortfolio,
  type SalesAndTrafficByDateRow,
  type SalesAndTrafficByAsinRow,
} from '../src/lib/internal/business-report-sp-api-client'
import {
  resolveMarketplaceTimezone,
  marketplaceTodayIso,
  marketplaceYesterdayIso,
  addCalendarDays,
  enumerateCalendarDays,
  marketplaceCalendarDayWindow,
} from '../src/lib/internal/business-report-marketplace-time'
import { resolveSkuReportDate } from '../src/lib/internal/business-report-grain-guard'
import {
  validateSkuRows,
  classifyStructuralCompleteness,
  shouldSkipAlreadyConfirmedDate,
} from '../src/lib/internal/business-report-run-outcome'
import { computeDateScopeReplacement, skuScopeKey } from '../src/lib/internal/business-report-date-scope-replace'

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

const SOURCE = 'business_report_sp_api'
const BY_DATE_TABLE = 'internal_business_report_sales_traffic_daily'
const SKU_TABLE = 'internal_business_report_sku_sales_traffic'
const STALE_RUN_MS = 2 * 60 * 60 * 1000
const REPORT_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000

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

async function cleanupStaleRuns(admin: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString()
  const { data: staleRows } = await admin
    .from('internal_data_refresh_runs')
    .select('id')
    .eq('source', SOURCE)
    .eq('status', 'running')
    .lt('started_at', cutoff)
  if (!staleRows || staleRows.length === 0) return
  await admin
    .from('internal_data_refresh_runs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: 'Stale running sync cleaned up before this run; no data imported.' })
    .in('id', staleRows.map(r => r.id))
  console.log(`Cleaned up ${staleRows.length} stale running refresh-run row(s) older than 2 hours.`)
}

async function isSyncLocked(admin: SupabaseClient, workspaceId: string, marketplaceId: string): Promise<boolean> {
  const { data } = await admin
    .from('internal_data_refresh_runs')
    .select('id')
    .eq('source', SOURCE)
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('status', 'running')
    .limit(1)
  return Boolean(data && data.length > 0)
}

async function findReusableReport(admin: SupabaseClient, requestKey: string, forceRefresh: boolean): Promise<{ amazonReportId: string; alreadySucceeded: boolean } | null> {
  if (forceRefresh) return null
  const cutoff = new Date(Date.now() - REPORT_REUSE_WINDOW_MS).toISOString()
  const { data } = await admin
    .from('internal_data_refresh_runs')
    .select('status, amazon_report_id')
    .eq('report_request_key', requestKey)
    .gte('started_at', cutoff)
    .not('amazon_report_id', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data?.amazon_report_id) return null
  return { amazonReportId: data.amazon_report_id as string, alreadySucceeded: data.status === 'success' }
}

/** Most recent run row for this exact single day (any status) — feeds shouldSkipAlreadyConfirmedDate(). */
async function findLatestRunForDate(admin: SupabaseClient, workspaceId: string, marketplaceId: string, day: string): Promise<{ status: string; rowsRejected: number } | null> {
  const { data } = await admin
    .from('internal_data_refresh_runs')
    .select('status, rows_rejected')
    .eq('source', SOURCE)
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('date_from', day)
    .eq('date_to', day)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { status: data.status as string, rowsRejected: (data.rows_rejected as number) ?? 0 }
}

function byDateRow(row: SalesAndTrafficByDateRow, workspaceId: string, marketplaceId: string, filename: string) {
  return {
    workspace_id: workspaceId,
    marketplace_id: marketplaceId,
    report_date: row.date,
    ordered_product_sales: row.orderedProductSales,
    ordered_product_sales_b2b: row.orderedProductSalesB2b,
    units_ordered: row.unitsOrdered,
    units_ordered_b2b: row.unitsOrderedB2b,
    total_order_items: row.totalOrderItems,
    total_order_items_b2b: row.totalOrderItemsB2b,
    average_sales_per_order_item: row.averageSalesPerOrderItem,
    average_sales_per_order_item_b2b: row.averageSalesPerOrderItemB2b,
    average_units_per_order_item: row.averageUnitsPerOrderItem,
    sessions: row.sessions,
    page_views: row.pageViews,
    buy_box_percentage: row.buyBoxPercentage,
    unit_session_percentage: row.unitSessionPercentage,
    source_filename: filename,
  }
}

function skuRow(row: SalesAndTrafficByAsinRow, reportDate: string, workspaceId: string, marketplaceId: string, reportId: string, costMasterCategoryBySkuNorm: Map<string, string | null>) {
  const skuNorm = row.sku ? row.sku.toLocaleUpperCase('en-US') : null
  const category = skuNorm ? costMasterCategoryBySkuNorm.get(skuNorm) ?? null : null
  const portfolio = resolveBusinessReportSkuPortfolio(category, row.sku, row.childAsin, row.parentAsin)
  return {
    workspace_id: workspaceId,
    marketplace_id: marketplaceId,
    report_date: reportDate,
    parent_asin: row.parentAsin,
    child_asin: row.childAsin,
    sku: row.sku,
    sku_norm: skuNorm,
    portfolio,
    ordered_product_sales: row.orderedProductSales,
    ordered_product_sales_b2b: row.orderedProductSalesB2b,
    units_ordered: row.unitsOrdered,
    units_ordered_b2b: row.unitsOrderedB2b,
    total_order_items: row.totalOrderItems,
    total_order_items_b2b: row.totalOrderItemsB2b,
    sessions: row.sessions,
    page_views: row.pageViews,
    buy_box_percentage: row.buyBoxPercentage,
    unit_session_percentage: row.unitSessionPercentage,
    source_report_id: reportId,
  }
}

/**
 * The by-date table's unique key is (workspace_id, marketplace_id,
 * report_date). The manual CSV importer defaults marketplace_id to
 * 'unknown' (it has no real marketplace context), while this auto-sync
 * knows the real marketplace_id from amazon_connections — a naive upsert on
 * that 3-column key would create a SECOND row for the same date instead of
 * upgrading the manual row, double-counting that day's sales everywhere
 * route.ts sums this table. Merge by (workspace_id, report_date) instead,
 * regardless of the existing row's marketplace_id, so the auto-synced
 * value always replaces whatever was there (manual import or a prior auto
 * sync) — exactly one row per real-world day, ever.
 *
 * Unchanged by the sales-grain fix (spec: "keep by-date processing as-is
 * — it's already correct") beyond now always being called with exactly
 * one row (this script requests one day at a time).
 */
async function upsertByDateRows(admin: SupabaseClient, workspaceId: string, rows: Array<Record<string, unknown>>, dryRun: boolean): Promise<number> {
  if (rows.length === 0 || dryRun) return rows.length

  const { data: existingRows, error } = await admin
    .from(BY_DATE_TABLE)
    .select('id, report_date')
    .eq('workspace_id', workspaceId)
    .in('report_date', rows.map(r => r.report_date as string))
  if (error) throw new Error(`Reading existing ${BY_DATE_TABLE} rows failed: ${error.message}`)
  const existingIdByDate = new Map<string, string>()
  for (const row of existingRows ?? []) existingIdByDate.set(row.report_date as string, row.id as string)

  const insertRows: Array<Record<string, unknown>> = []
  const updateRows: Array<Record<string, unknown> & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByDate.get(row.report_date as string)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

  if (insertRows.length > 0) {
    const { error: insertError } = await admin.from(BY_DATE_TABLE).insert(insertRows)
    if (insertError) throw new Error(`Inserting ${BY_DATE_TABLE} rows failed: ${insertError.message}`)
  }
  if (updateRows.length > 0) {
    const { error: updateError } = await admin.from(BY_DATE_TABLE).upsert(updateRows, { onConflict: 'id' })
    if (updateError) throw new Error(`Updating ${BY_DATE_TABLE} rows failed: ${updateError.message}`)
  }
  return rows.length
}

/**
 * Full date-scope replacement (spec Phase 5) for the SKU/ASIN table,
 * scoped to exactly (workspace_id, marketplace_id, report_date) — this
 * script only ever calls it with rows for ONE already-grain-validated
 * day. Replaces the old plain upsert (insert-if-missing/update-if-present,
 * no delete), which let a stale row for a SKU that legitimately had zero
 * activity on a corrected day survive forever. Writes in a safe order:
 * insert + update BEFORE delete, so a mid-batch failure never loses a row
 * that isn't yet superseded by its replacement — if the delete step
 * fails, the scope is left with extra (soon-to-be-stale) rows rather than
 * missing rows, and the failure is thrown so the run is recorded failed,
 * never silently marked successful.
 */
async function replaceSkuDateScope(
  admin: SupabaseClient,
  workspaceId: string,
  marketplaceId: string,
  reportDate: string,
  rows: Array<Record<string, unknown>>,
  dryRun: boolean,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  const { data: existingRows, error } = await admin
    .from(SKU_TABLE)
    .select('id, sku_norm, child_asin, parent_asin')
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('report_date', reportDate)
  if (error) throw new Error(`Reading existing ${SKU_TABLE} rows failed: ${error.message}`)

  const existingScoped = (existingRows ?? []).map(r => ({
    id: r.id as string,
    key: skuScopeKey({ sku_norm: r.sku_norm as string | null, child_asin: r.child_asin as string | null, parent_asin: r.parent_asin as string | null }),
  }))
  const plan = computeDateScopeReplacement(
    existingScoped,
    rows,
    row => skuScopeKey({ sku_norm: (row.sku_norm as string | null) ?? null, child_asin: (row.child_asin as string | null) ?? null, parent_asin: (row.parent_asin as string | null) ?? null }),
  )

  if (dryRun) return { inserted: plan.toInsert.length, updated: plan.toUpdate.length, deleted: plan.toDeleteIds.length }

  if (plan.toInsert.length > 0) {
    const { error: insertError } = await admin.from(SKU_TABLE).insert(plan.toInsert)
    if (insertError) throw new Error(`Inserting ${SKU_TABLE} rows failed: ${insertError.message}`)
  }
  if (plan.toUpdate.length > 0) {
    const { error: updateError } = await admin.from(SKU_TABLE).upsert(plan.toUpdate, { onConflict: 'id' })
    if (updateError) throw new Error(`Updating ${SKU_TABLE} rows failed: ${updateError.message}`)
  }
  if (plan.toDeleteIds.length > 0) {
    const { error: deleteError } = await admin.from(SKU_TABLE).delete().in('id', plan.toDeleteIds)
    if (deleteError) throw new Error(`Deleting stale ${SKU_TABLE} rows failed: ${deleteError.message} (scope workspace=${workspaceId} marketplace=${marketplaceId} date=${reportDate} left with ${plan.toInsert.length + plan.toUpdate.length} correct rows plus ${plan.toDeleteIds.length} stale row(s) not yet removed — safe to re-run)`)
  }
  return { inserted: plan.toInsert.length, updated: plan.toUpdate.length, deleted: plan.toDeleteIds.length }
}

type DayOutcome = { day: string; status: 'success' | 'partial_success' | 'failed' | 'skipped'; reason: string | null; skuInserted: number; skuUpdated: number; skuDeleted: number }

async function syncOneDay(
  admin: SupabaseClient,
  accessToken: string,
  day: string,
  workspaceId: string,
  marketplaceId: string,
  timeZone: string,
  dryRun: boolean,
  forceRefresh: boolean,
  reportTimeoutMs: number,
): Promise<DayOutcome> {
  const requestKey = `${workspaceId}|${marketplaceId}|${SALES_AND_TRAFFIC_REPORT_TYPE}|${day}|${day}|DAY|SKU`

  const latestRun = await findLatestRunForDate(admin, workspaceId, marketplaceId, day)
  if (!dryRun && shouldSkipAlreadyConfirmedDate(latestRun, forceRefresh)) {
    console.log(`  ${day}: SKIPPED — already confirmed complete (use --force-refresh to redo).`)
    return { day, status: 'skipped', reason: 'already_confirmed_complete', skuInserted: 0, skuUpdated: 0, skuDeleted: 0 }
  }

  const reusable = await findReusableReport(admin, requestKey, forceRefresh)
  if (reusable?.alreadySucceeded) {
    console.log(`  ${day}: SKIPPED — already synced successfully within the last 6h (use --force-refresh to redo).`)
    await admin.from('internal_data_refresh_runs').insert({
      workspace_id: workspaceId, marketplace_id: marketplaceId, source: SOURCE, status: 'skipped',
      date_from: day, date_to: day, finished_at: new Date().toISOString(),
      report_request_key: requestKey, report_type: SALES_AND_TRAFFIC_REPORT_TYPE,
      error_message: 'Already synced recently for this exact date; use --force-refresh to redo.',
    })
    return { day, status: 'skipped', reason: 'reused_recent_success', skuInserted: 0, skuUpdated: 0, skuDeleted: 0 }
  }

  const reportOptions = { dateGranularity: 'DAY', asinGranularity: 'SKU' }
  const { data: runRow } = await admin
    .from('internal_data_refresh_runs')
    .insert({
      workspace_id: workspaceId, marketplace_id: marketplaceId, source: SOURCE, status: 'running',
      date_from: day, date_to: day, report_request_key: requestKey,
      report_type: SALES_AND_TRAFFIC_REPORT_TYPE, report_options: reportOptions,
    })
    .select('id')
    .single()
  const runId = runRow?.id as string | undefined

  try {
    let reportId: string
    if (reusable) {
      reportId = reusable.amazonReportId
      console.log(`  ${day}: reusing in-flight Amazon report ${reportId}.`)
    } else {
      const window = marketplaceCalendarDayWindow(day, timeZone)
      const created = await createAmazonReport(accessToken, {
        reportType: SALES_AND_TRAFFIC_REPORT_TYPE,
        marketplaceIds: [marketplaceId],
        dataStartTime: window.dataStartTime,
        dataEndTime: window.dataEndTime,
        reportOptions,
      })
      reportId = created.reportId
      console.log(`  ${day}: report requested (${reportId}).`)
    }
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_id: reportId, amazon_report_status: 'IN_QUEUE', amazon_report_created_at: new Date().toISOString() }).eq('id', runId)
    }

    const waitResult = await waitForSalesAndTrafficReport(accessToken, reportId, { maxWaitMs: reportTimeoutMs })
    if (waitResult.status !== 'DONE') {
      throw new Error(`Report ended in terminal state ${waitResult.status} (not DONE) — no data to import.`)
    }
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_status: 'DONE', amazon_report_completed_at: new Date().toISOString(), report_document_id: waitResult.reportDocumentId }).eq('id', runId)
    }

    const document = await getAmazonReportDocument(accessToken, waitResult.reportDocumentId)
    const rawJson = await downloadAmazonReportDocument(document)
    const parsed = parseSalesAndTrafficReport(rawJson)

    // Grain guard: this script only ever requests dateFrom === dateTo, so
    // this can never actually throw here — it documents and enforces the
    // invariant at the exact point a report_date is derived, rather than
    // trusting the request loop never to regress.
    const skuReportDate = resolveSkuReportDate(day, day)

    const byDateMatches = parsed.byDate.filter(r => r.date === day)
    const { accepted: acceptedSkuRows, rejected: rejectedSkuRows } = validateSkuRows(parsed.byAsin)
    const completeness = classifyStructuralCompleteness({
      byDateMatchCount: byDateMatches.length,
      byDateOrderedProductSales: byDateMatches[0]?.orderedProductSales ?? null,
      skuRowsFetched: parsed.byAsin.length,
      skuRowsRejected: rejectedSkuRows.length,
    })

    if (completeness.status === 'failed') {
      throw new Error(`Structurally incomplete report for ${day}: ${completeness.reason}. rows_rejected recorded truthfully; no data written; NOT marked successful.`)
    }

    const filename = `spapi-auto-${SALES_AND_TRAFFIC_REPORT_TYPE}-${day}`
    const byDateRows = byDateMatches.map(r => byDateRow(r, workspaceId, marketplaceId, filename))
    const byDateUpserted = await upsertByDateRows(admin, workspaceId, byDateRows, dryRun)

    const costMasterCategoryBySkuNorm = new Map<string, string | null>()
    if (acceptedSkuRows.length > 0) {
      const { data: costMasterRows } = await admin.from('internal_sku_cost_master').select('sku_norm, category').eq('workspace_id', workspaceId).limit(10000)
      for (const row of costMasterRows ?? []) costMasterCategoryBySkuNorm.set(row.sku_norm as string, (row.category as string | null) ?? null)
    }
    const skuRows = acceptedSkuRows.map(r => skuRow(r, skuReportDate, workspaceId, marketplaceId, reportId, costMasterCategoryBySkuNorm))
    const unmappedCount = skuRows.filter(r => r.portfolio === 'Unmapped / Needs Review').length
    const skuResult = await replaceSkuDateScope(admin, workspaceId, marketplaceId, skuReportDate, skuRows, dryRun)

    console.log(
      `  ${day}: by-date rows=${byDateUpserted}, SKU rows fetched=${parsed.byAsin.length} accepted=${acceptedSkuRows.length} rejected=${rejectedSkuRows.length} ` +
      `(${unmappedCount} unmapped) — insert=${skuResult.inserted} update=${skuResult.updated} delete=${skuResult.deleted} — status=${completeness.status}${completeness.reason ? ` (${completeness.reason})` : ''}.`,
    )

    if (runId) {
      await admin.from('internal_data_refresh_runs').update({
        status: completeness.status,
        finished_at: new Date().toISOString(),
        rows_fetched: parsed.byDate.length + parsed.byAsin.length,
        rows_inserted: byDateUpserted + skuResult.inserted,
        rows_updated: skuResult.updated,
        rows_rejected: rejectedSkuRows.length,
        error_message: completeness.reason,
      }).eq('id', runId)
    }

    return { day, status: completeness.status, reason: completeness.reason, skuInserted: skuResult.inserted, skuUpdated: skuResult.updated, skuDeleted: skuResult.deleted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ${day}: FAILED — ${message}`)
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message }).eq('id', runId)
    }
    return { day, status: 'failed', reason: message, skuInserted: 0, skuUpdated: 0, skuDeleted: 0 }
  }
}

async function main() {
  const args = parseArgs()
  const dryRun = args.has('dry-run')
  const forceRefresh = args.has('force-refresh')
  const reportTimeoutMs = args.has('report-timeout-ms') ? Number(args.get('report-timeout-ms')) : 900_000

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing requirement: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Resolve workspace + connection: explicit --workspace-id, else prefer
  // whichever active connection's workspace already has Brahmastra Business
  // Report activity (the manual-import workspace), falling back to the
  // first active connection if none do yet — avoids picking an unrelated
  // workspace when more than one Seller Central account is connected.
  let workspaceId = args.get('workspace-id') ?? null
  let connectionQuery = admin.from('amazon_connections').select('workspace_id, marketplace_id, refresh_token_encrypted, status')
  if (workspaceId) connectionQuery = connectionQuery.eq('workspace_id', workspaceId)
  const { data: connections, error: connError } = await connectionQuery.eq('status', 'active').limit(5)
  if (connError) {
    console.error('Missing requirement: could not query amazon_connections —', connError.message)
    process.exitCode = 1
    return
  }
  if (!connections || connections.length === 0) {
    console.error('Missing requirement: no active amazon_connections row found. Connect a Seller Central account via SP-API OAuth first (no refresh token stored).')
    process.exitCode = 1
    return
  }
  let connection = connections[0]
  if (connections.length > 1) {
    const { data: existingActivity } = await admin
      .from('internal_business_report_upload_batches')
      .select('workspace_id')
      .in('workspace_id', connections.map(c => c.workspace_id as string))
      .limit(1)
    const activeWorkspaceId = existingActivity?.[0]?.workspace_id as string | undefined
    if (activeWorkspaceId) connection = connections.find(c => c.workspace_id === activeWorkspaceId) ?? connection
  }
  workspaceId = connection.workspace_id as string
  const marketplaceId = args.get('marketplace-id') ?? (connection.marketplace_id as string)
  if (!marketplaceId) {
    console.error('Missing requirement: no marketplace_id available (pass --marketplace-id or fix amazon_connections.marketplace_id).')
    process.exitCode = 1
    return
  }

  // Timezone correctness (spec Phase 4): every calendar-day decision below
  // — "yesterday", the default range, and each report's requested window —
  // is anchored to the MARKETPLACE'S local timezone, never server-UTC and
  // never whatever timezone the machine running this script happens to be
  // in. Fails closed for an unrecognized marketplace rather than silently
  // assuming UTC.
  const timeZone = resolveMarketplaceTimezone(marketplaceId)
  if (!timeZone) {
    console.error(`Missing requirement: no known timezone for marketplace ${marketplaceId} — refusing to guess UTC. Add it to MARKETPLACE_TIMEZONES in src/lib/internal/business-report-marketplace-time.ts.`)
    process.exitCode = 1
    return
  }

  const dateEnd = args.get('date-end') ?? marketplaceYesterdayIso(timeZone) // yesterday (marketplace-local) by default — today's Business Report data is partial
  const dateStart = args.get('date-start') ?? addCalendarDays(dateEnd, -(args.has('days') ? Number(args.get('days')) : 14) + 1)
  const days = enumerateCalendarDays(dateStart, dateEnd)
  if (days.length === 0) {
    console.error(`Missing requirement: invalid date range ${dateStart} → ${dateEnd} (date-start after date-end).`)
    process.exitCode = 1
    return
  }

  console.log(`Business Report SP-API sync — workspace ${workspaceId}, marketplace ${marketplaceId} (${timeZone}), range ${dateStart} → ${dateEnd} (${days.length} day(s), one Amazon report per day)${dryRun ? ' (dry run)' : ''}. Marketplace "today" is ${marketplaceTodayIso(timeZone)}.`)

  await cleanupStaleRuns(admin)
  if (await isSyncLocked(admin, workspaceId, marketplaceId)) {
    console.log('SKIPPED — another Business Report sync is already running for this workspace+marketplace.')
    return
  }

  const refreshToken = decryptToken(connection.refresh_token_encrypted as string)
  const tokenResult = await refreshAccessToken(refreshToken)

  const outcomes: DayOutcome[] = []
  for (const day of days) {
    // Sequential, never parallel — bounded load on Amazon's low-quota
    // Reports API, and each day's failure is independent of the others
    // (a bad day doesn't abort the whole run).
    const outcome = await syncOneDay(admin, tokenResult.access_token, day, workspaceId, marketplaceId, timeZone, dryRun, forceRefresh, reportTimeoutMs)
    outcomes.push(outcome)
  }

  const succeeded = outcomes.filter(o => o.status === 'success').length
  const partial = outcomes.filter(o => o.status === 'partial_success').length
  const failed = outcomes.filter(o => o.status === 'failed').length
  const skipped = outcomes.filter(o => o.status === 'skipped').length
  console.log(`Sync complete${dryRun ? ' (dry run — no rows written)' : ''}: ${succeeded} succeeded, ${partial} partial, ${failed} failed, ${skipped} skipped (of ${days.length} day(s)).`)
  if (failed > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
