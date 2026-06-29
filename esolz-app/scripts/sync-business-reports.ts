// Phase R8: automated Seller Central Business Report sync ("Sales and
// Traffic by Date" + "by ASIN/SKU") via the SP-API Reports API
// (GET_SALES_AND_TRAFFIC_REPORT). Read-only against Amazon — only ever
// creates a report and reads it back. Never calls a write endpoint, never
// touches Amazon Ads sync, never touches payment-transaction data.
//
// Usage:
//   npx tsx scripts/sync-business-reports.ts                          # default: last 14 days
//   npx tsx scripts/sync-business-reports.ts --days=30                # 30-day backfill/correction window
//   npx tsx scripts/sync-business-reports.ts --date-start=2026-06-15 --date-end=2026-06-15
//   npx tsx scripts/sync-business-reports.ts --workspace-id=... --marketplace-id=A21TJRUUN4KGV
//   npx tsx scripts/sync-business-reports.ts --dry-run                # parse only, write nothing
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
//   - Re-running for the same exact (workspace, marketplace, date range)
//     within a few hours reuses the in-flight/just-finished Amazon report
//     instead of requesting a new one, unless --force-refresh is passed.
//   - 429s are backed off (see waitForSalesAndTrafficReport).
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
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

function byDateRow(row: SalesAndTrafficByDateRow, workspaceId: string, marketplaceId: string, filename: string, reportId: string) {
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

  const CHUNK = 500
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const { error: insertError } = await admin.from(BY_DATE_TABLE).insert(insertRows.slice(i, i + CHUNK))
    if (insertError) throw new Error(`Inserting ${BY_DATE_TABLE} rows failed: ${insertError.message}`)
  }
  for (let i = 0; i < updateRows.length; i += CHUNK) {
    const { error: updateError } = await admin.from(BY_DATE_TABLE).upsert(updateRows.slice(i, i + CHUNK), { onConflict: 'id' })
    if (updateError) throw new Error(`Updating ${BY_DATE_TABLE} rows failed: ${updateError.message}`)
  }
  return rows.length
}

/**
 * The SKU/ASIN table's uniqueness uses a coalesce()-based expression index
 * (sku_norm/child_asin/parent_asin are nullable), which PostgREST's
 * `.upsert({onConflict})` cannot target directly — it only matches a literal
 * column-list constraint. Manual select-existing-by-id + insert/update
 * split instead, same pattern as the Ads sync's dedupe-key upsert.
 */
async function upsertSkuRows(admin: SupabaseClient, workspaceId: string, marketplaceId: string, reportDate: string, rows: Array<Record<string, unknown>>, dryRun: boolean): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 }
  if (dryRun) return { inserted: rows.length, updated: 0 }

  const keyOf = (r: { sku_norm: unknown; child_asin: unknown; parent_asin: unknown }) =>
    `${r.sku_norm ?? ''}|${r.child_asin ?? ''}|${r.parent_asin ?? ''}`

  const { data: existingRows, error } = await admin
    .from(SKU_TABLE)
    .select('id, sku_norm, child_asin, parent_asin')
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', marketplaceId)
    .eq('report_date', reportDate)
  if (error) throw new Error(`Reading existing ${SKU_TABLE} rows failed: ${error.message}`)
  const existingIdByKey = new Map<string, string>()
  for (const row of existingRows ?? []) existingIdByKey.set(keyOf(row), row.id as string)

  const insertRows: Array<Record<string, unknown>> = []
  const updateRows: Array<Record<string, unknown> & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(keyOf(row as { sku_norm: unknown; child_asin: unknown; parent_asin: unknown }))
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

  const CHUNK = 500
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const { error: insertError } = await admin.from(SKU_TABLE).insert(insertRows.slice(i, i + CHUNK))
    if (insertError) throw new Error(`Inserting ${SKU_TABLE} rows failed: ${insertError.message}`)
  }
  for (let i = 0; i < updateRows.length; i += CHUNK) {
    const { error: updateError } = await admin.from(SKU_TABLE).upsert(updateRows.slice(i, i + CHUNK), { onConflict: 'id' })
    if (updateError) throw new Error(`Updating ${SKU_TABLE} rows failed: ${updateError.message}`)
  }
  return { inserted: insertRows.length, updated: updateRows.length }
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

  const dateEnd = args.get('date-end') ?? addDays(todayIso(), -1) // yesterday by default — today's Business Report data is partial
  const dateStart = args.get('date-start') ?? addDays(dateEnd, -(args.has('days') ? Number(args.get('days')) : 14) + 1)

  console.log(`Business Report SP-API sync — workspace ${workspaceId}, marketplace ${marketplaceId}, range ${dateStart} → ${dateEnd}${dryRun ? ' (dry run)' : ''}`)

  await cleanupStaleRuns(admin)
  if (await isSyncLocked(admin, workspaceId, marketplaceId)) {
    console.log('SKIPPED — another Business Report sync is already running for this workspace+marketplace.')
    return
  }

  const requestKey = `${workspaceId}|${marketplaceId}|${SALES_AND_TRAFFIC_REPORT_TYPE}|${dateStart}|${dateEnd}|DAY|SKU`
  const reusable = await findReusableReport(admin, requestKey, forceRefresh)
  if (reusable?.alreadySucceeded) {
    console.log('SKIPPED — already synced successfully for this exact range within the last 6h (use --force-refresh to redo).')
    await admin.from('internal_data_refresh_runs').insert({
      workspace_id: workspaceId, marketplace_id: marketplaceId, source: SOURCE, status: 'skipped',
      date_from: dateStart, date_to: dateEnd, finished_at: new Date().toISOString(),
      report_request_key: requestKey, report_type: SALES_AND_TRAFFIC_REPORT_TYPE,
      error_message: 'Already synced recently for this exact date range; use --force-refresh to redo.',
    })
    return
  }

  const reportOptions = { dateGranularity: 'DAY', asinGranularity: 'SKU' }
  const { data: runRow } = await admin
    .from('internal_data_refresh_runs')
    .insert({
      workspace_id: workspaceId, marketplace_id: marketplaceId, source: SOURCE, status: 'running',
      date_from: dateStart, date_to: dateEnd, report_request_key: requestKey,
      report_type: SALES_AND_TRAFFIC_REPORT_TYPE, report_options: reportOptions,
    })
    .select('id')
    .single()
  const runId = runRow?.id as string | undefined

  try {
    const refreshToken = decryptToken(connection.refresh_token_encrypted as string)
    const tokenResult = await refreshAccessToken(refreshToken)

    let reportId: string
    if (reusable) {
      reportId = reusable.amazonReportId
      console.log(`Reusing in-flight Amazon report ${reportId} instead of requesting a new one.`)
    } else {
      const created = await createAmazonReport(tokenResult.access_token, {
        reportType: SALES_AND_TRAFFIC_REPORT_TYPE,
        marketplaceIds: [marketplaceId],
        dataStartTime: `${dateStart}T00:00:00Z`,
        dataEndTime: `${dateEnd}T23:59:59Z`,
        reportOptions,
      })
      reportId = created.reportId
      console.log('Report requested:', reportId)
    }
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_id: reportId, amazon_report_status: 'IN_QUEUE', amazon_report_created_at: new Date().toISOString() }).eq('id', runId)
    }

    const waitResult = await waitForSalesAndTrafficReport(tokenResult.access_token, reportId, { maxWaitMs: reportTimeoutMs })
    if (waitResult.status !== 'DONE') {
      throw new Error(`Report ended in terminal state ${waitResult.status} (not DONE) — no data to import.`)
    }
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_status: 'DONE', amazon_report_completed_at: new Date().toISOString(), report_document_id: waitResult.reportDocumentId }).eq('id', runId)
    }

    const document = await getAmazonReportDocument(tokenResult.access_token, waitResult.reportDocumentId)
    const rawJson = await downloadAmazonReportDocument(document)
    const parsed = parseSalesAndTrafficReport(rawJson)
    console.log(`Parsed ${parsed.byDate.length} by-date row(s), ${parsed.byAsin.length} by-SKU/ASIN row(s).`)

    const filename = `spapi-auto-${SALES_AND_TRAFFIC_REPORT_TYPE}-${dateStart}-${dateEnd}`
    const byDateRows = parsed.byDate.map(r => byDateRow(r, workspaceId!, marketplaceId, filename, reportId))
    const byDateInserted = await upsertByDateRows(admin, workspaceId!, byDateRows, dryRun)

    let skuInserted = 0
    let unmappedCount = 0
    if (parsed.byAsin.length > 0) {
      const { data: costMasterRows } = await admin.from('internal_sku_cost_master').select('sku_norm, category').eq('workspace_id', workspaceId).limit(10000)
      const costMasterCategoryBySkuNorm = new Map<string, string | null>()
      for (const row of costMasterRows ?? []) costMasterCategoryBySkuNorm.set(row.sku_norm as string, (row.category as string | null) ?? null)

      // The report is range-level, but salesAndTrafficByAsin has no per-day
      // breakdown when dateGranularity=DAY spans multiple days in one
      // request — Amazon returns ASIN totals for the WHOLE requested range
      // in that case. For a single-day request (date-start === date-end)
      // the ASIN rows correctly represent that one day.
      const skuReportDate = dateStart === dateEnd ? dateStart : dateEnd
      const skuRows = parsed.byAsin.map(r => skuRow(r, skuReportDate, workspaceId!, marketplaceId, reportId, costMasterCategoryBySkuNorm))
      unmappedCount = skuRows.filter(r => r.portfolio === 'Unmapped / Needs Review').length
      const skuResult = await upsertSkuRows(admin, workspaceId!, marketplaceId, skuReportDate, skuRows, dryRun)
      skuInserted = skuResult.inserted + skuResult.updated
    }

    console.log(`By-date rows upserted: ${byDateInserted}. SKU/ASIN rows upserted: ${skuInserted} (${unmappedCount} unmapped to a portfolio).`)

    if (runId) {
      await admin.from('internal_data_refresh_runs').update({
        status: 'success',
        finished_at: new Date().toISOString(),
        rows_fetched: parsed.byDate.length + parsed.byAsin.length,
        rows_inserted: byDateInserted + skuInserted,
        rows_updated: 0,
        rows_rejected: 0,
      }).eq('id', runId)
    }
    console.log(dryRun ? 'Dry run complete — no rows written.' : 'Sync complete.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Business Report sync failed:', message)
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message }).eq('id', runId)
    }
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
