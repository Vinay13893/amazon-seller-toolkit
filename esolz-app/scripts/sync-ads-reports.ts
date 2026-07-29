// Phase 2C.1 / R10.2: daily auto-refresh for Amazon Ads reports Brahmastra reads.
// Syncs SP (Sponsored Products), SD (Sponsored Display), and SB (Sponsored Brands)
// campaign-level reports plus the 3 SP deep reports (advertised product / targeting /
// search term). SP+SD+SB campaign rows all go into internal_ads_campaign_daily_rows so
// top-level totals match the Amazon Ads Console "All campaign types" view.
// Intended to run on Render as a scheduled cron job — NOT on Vercel.
// Read-only against the Amazon Ads Reporting API: only ever creates a report and reads
// it back. Never calls a write endpoint, never touches bids/budgets/campaigns/keywords.
//
// Usage:
//   npx tsx scripts/sync-ads-reports.ts                                     # last 7 days (today excluded)
//   npx tsx scripts/sync-ads-reports.ts --days=2                            # last 2 days (manual test)
//   npx tsx scripts/sync-ads-reports.ts --from=2026-06-20 --to=2026-06-25
//   npx tsx scripts/sync-ads-reports.ts --report-timeout-ms=1500000         # default; report polling ceiling
//   npx tsx scripts/sync-ads-reports.ts --force-refresh                     # bypass the recent-success skip
//   npx tsx scripts/sync-ads-reports.ts --days=90 --backfill --chunk-days=7 --ad-products=SP,SD,SB
//       Backfill mode: splits the full date range into --chunk-days-sized windows and
//       runs campaign reports (SP/SD/SB) per chunk, then deep reports per chunk.
//       Each chunk is idempotent (skip logic still applies unless --force-refresh).
//       Failed chunks do not stop later chunks. --no-deep skips deep reports entirely.
//   npx tsx scripts/sync-ads-reports.ts --days=14 --ad-products=SP,SD,SB   # rolling 14-day daily cron
//
// Required env vars (Render): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Credentials are resolved in priority order:
//   1. An active amazon_ads_connections + amazon_ads_profiles row in the DB
//      (needs SPAPI_ENCRYPTION_KEY to decrypt the stored refresh token, plus
//      AMAZON_ADS_CLIENT_ID/AMAZON_ADS_CLIENT_SECRET — the in-app OAuth app).
//   2. A direct credential set via env vars (no DB connection needed):
//      AMZN_ADS_CLIENT_ID or AMAZON_ADS_CLIENT_ID
//      AMZN_ADS_CLIENT_SECRET or AMAZON_ADS_CLIENT_SECRET
//      AMZN_ADS_REFRESH_TOKEN or AMAZON_ADS_REFRESH_TOKEN
//      AMZN_ADS_PROFILE_ID or AMAZON_ADS_PROFILE_ID
//      AMZN_ADS_REGION or AMAZON_ADS_REGION (defaults to 'eu')
//      AMZN_ADS_MARKETPLACE or AMAZON_ADS_MARKETPLACE (descriptive only)
//
// Reliability hardening (Phase R1):
//   - Report polling timeout is configurable (default 25 min, raised from 15
//     min 2026-07-28 -- every report type hit the old 15-min ceiling with
//     Amazon still PENDING for 2 straight days, see BRAHMASTRA_MASTER_TRACKER.md
//     sec on the ads-refresh-failure diagnosis).
//   - One report failing/timing out never stops the other 3 from running.
//   - A per-workspace+profile concurrency lock prevents two sync runs (e.g.
//     an overlapping manual trigger) from racing each other.
//   - Stale "running" rows older than 2 hours are cleaned up at startup so
//     a crashed previous run can never look like an active lock forever.
//   - Re-running for the same exact (profile, report type, date range) within
//     a few hours reuses the in-flight/just-finished Amazon report instead of
//     requesting a brand new one, unless --force-refresh is passed.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import {
  refreshAdsAccessToken,
  requestAdsReport,
  waitForAdsReport,
  downloadAdsReportRows,
  type AdsApiContext,
  type AdsReportType,
} from '../src/lib/internal/amazon-ads-reporting-client'
import { jsonRowsToCsv } from '../src/lib/internal/json-rows-to-csv'
import { resolveDirectAdsCredentials } from '../src/lib/internal/amazon-ads-direct-credentials'
import { resolveBrahmastraProfile } from '../src/lib/internal/brahmastra-ads-profile-selection'
import { parseAdsCampaignDailyReport } from '../src/lib/internal/ads-campaign-daily-parser'
import {
  parseDeepReport,
  resolveAdvertisedProductPortfolio,
  type DeepReportKind,
} from '../src/lib/internal/ads-deep-report-parser'
import { campaignDailyRowFor, deepReportRowFor } from '../src/lib/internal/ads-report-row-mappers'
import { resolveReportTimeoutMs } from '../src/lib/internal/ads-report-timeout'
import { decideReportReuse, AMAZON_REPORT_RETENTION_MS as REUSE_RETENTION_MS } from '../src/lib/internal/ads-report-reuse'
import { splitRowsForUpsert } from '../src/lib/internal/ads-upsert-split'

// Tolerate a missing .env.local (Render sets real env vars directly; this is
// only for local manual testing convenience).
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

function dateChunks(startDate: string, endDate: string, chunkDays: number): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = []
  let current = startDate
  while (current <= endDate) {
    const tentativeEnd = addDays(current, chunkDays - 1)
    const to = tentativeEnd <= endDate ? tentativeEnd : endDate
    chunks.push({ from: current, to })
    current = addDays(to, 1)
  }
  return chunks
}

function campaignDefsFor(adProducts: string[]): ReportDef[] {
  return REPORT_DEFS.filter(d => {
    if (d.kind !== null) return false
    if (d.type === 'spCampaigns') return adProducts.includes('SP')
    if (d.type === 'sdCampaigns') return adProducts.includes('SD')
    if (d.type === 'sbCampaigns') return adProducts.includes('SB')
    return false
  })
}

function deepReportDefs(): ReportDef[] {
  return REPORT_DEFS.filter(d => d.kind !== null)
}

const STALE_RUN_MS = 2 * 60 * 60 * 1000 // 2 hours — anything "running" longer than this is a crashed/abandoned attempt
// Reuse-window sizing (SUCCESS_SKIP_MS, AMAZON_REPORT_RETENTION_MS) and the
// reuse-vs-recreate decision itself now live in ads-report-reuse.ts
// (imported as decideReportReuse/REUSE_RETENTION_MS above) so they're
// covered by a real test independent of any live Supabase call.

// SD campaign report generation was first observed timing out right at the
// old 900s default polling ceiling (2026-07-07 incident) -- this per-
// report-type override predates and now simply matches the global
// `reportTimeoutMs` default (raised to the same 1,500,000ms 2026-07-28,
// after every report type started hitting the old 900s ceiling). Left in
// place, explicit, so this report type's ceiling can never silently
// regress if the global default ever changes again.
const SD_CAMPAIGN_TIMEOUT_MS = 1_500_000 // 25 min

// Bounded retry-with-backoff for HTTP 429 on report *creation* only — the
// exact failure mode observed on ads_sb_campaign_daily (2026-07-07). Any
// other error is not retried here. Capped at REPORT_CREATE_MAX_ATTEMPTS
// total attempts so a persistent 429 fails cleanly instead of looping.
const REPORT_CREATE_MAX_ATTEMPTS = 3
const REPORT_CREATE_BACKOFF_MS = [30_000, 90_000]

type ReportDef =
  // Campaign-level reports: SP, SD, and SB all go into the same table so
  // top-level totals match the Amazon Ads Console across all campaign types.
  | { type: 'spCampaigns' | 'sdCampaigns' | 'sbCampaigns'; source: string; table: string; batchTable: string; kind: null; timeoutMs?: number }
  // SP deep reports only (SD/SB don't offer equivalent granular breakdown APIs).
  | { type: AdsReportType; source: string; table: string; batchTable: string; kind: DeepReportKind; timeoutMs?: number }

const REPORT_DEFS: ReportDef[] = [
  // ── Campaign-level (SP + SD + SB) — all into internal_ads_campaign_daily_rows ──
  { type: 'spCampaigns', source: 'ads_campaign_daily', table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  { type: 'sdCampaigns', source: 'ads_sd_campaign_daily', table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null, timeoutMs: SD_CAMPAIGN_TIMEOUT_MS },
  { type: 'sbCampaigns', source: 'ads_sb_campaign_daily', table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  // ── SP deep reports ──────────────────────────────────────────────────────────
  { type: 'spAdvertisedProduct', source: 'ads_advertised_product', table: 'internal_ads_advertised_product_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'advertised_product' },
  { type: 'spTargeting', source: 'ads_targeting', table: 'internal_ads_targeting_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'targeting' },
  { type: 'spSearchTerm', source: 'ads_search_term', table: 'internal_ads_search_term_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'search_term' },
]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRateLimitedError(message: string): boolean {
  return message.includes('429') || message.toLowerCase().includes('throttl')
}

/**
 * Wraps requestAdsReport with bounded retry-with-backoff, isolated per
 * report (a retry here never affects any other report type's own attempt).
 * Only HTTP 429 is retried — any other error (auth, malformed request,
 * etc.) surfaces immediately to the existing per-report failure handling.
 */
async function requestAdsReportWithRetry(ctx: AdsApiContext, reportType: AdsReportType, startDate: string, endDate: string, source: string): Promise<string> {
  for (let attempt = 1; attempt <= REPORT_CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestAdsReport(ctx, reportType, startDate, endDate)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isLastAttempt = attempt === REPORT_CREATE_MAX_ATTEMPTS
      if (!isRateLimitedError(message) || isLastAttempt) {
        if (attempt > 1) console.log(`  ${source}: giving up after ${attempt} attempt(s) creating report for ${startDate}..${endDate} — ${message}`)
        throw err
      }
      const backoffMs = REPORT_CREATE_BACKOFF_MS[attempt - 1]
      console.log(`  ${source}: rate limited (429) creating report for ${startDate}..${endDate} (attempt ${attempt}/${REPORT_CREATE_MAX_ATTEMPTS}) — backing off ${backoffMs}ms before retry`)
      await sleep(backoffMs)
    }
  }
  throw new Error(`${source}: report creation retry loop exited unexpectedly`)
}

// campaignDailyRowFor/deepReportRowFor now live in ads-report-row-mappers.ts
// (imported above) -- shared with scripts/poll-pending-reports.ts so both
// scripts stay byte-identical by construction instead of hand-duplicated.

/**
 * Same dedupe-by-key insert/update split already used by the manual-upload
 * import routes. Scoped by profile_id (in addition to workspace_id) so a
 * dedupe_key that happens to repeat across two different Ads profiles can
 * never be mistaken for the same row.
 */
async function upsertByDedupeKey(admin: SupabaseClient, table: string, workspaceId: string, profileId: string, rows: Array<Record<string, unknown>>): Promise<{ insertedCount: number; updatedCount: number }> {
  if (rows.length === 0) return { insertedCount: 0, updatedCount: 0 }
  const CHUNK = 500
  const PAGE = 1000
  const existingIdByKey = new Map<string, string>()
  for (let page = 0; ; page += 1) {
    const { data: pageRows, error } = await admin
      .from(table)
      .select('id, dedupe_key')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`Reading existing ${table} rows failed: ${error.message}`)
    for (const row of pageRows ?? []) existingIdByKey.set(row.dedupe_key as string, row.id as string)
    if (!pageRows || pageRows.length < PAGE) break
  }

  const { insertRows, updateRows } = splitRowsForUpsert(existingIdByKey, rows)

  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const { error } = await admin.from(table).insert(insertRows.slice(i, i + CHUNK))
    if (error) throw new Error(`Inserting ${table} rows failed: ${error.message}`)
  }
  for (let i = 0; i < updateRows.length; i += CHUNK) {
    const { error } = await admin.from(table).upsert(updateRows.slice(i, i + CHUNK), { onConflict: 'id' })
    if (error) throw new Error(`Updating ${table} rows failed: ${error.message}`)
  }
  return { insertedCount: insertRows.length, updatedCount: updateRows.length }
}

/** Marks any "running" Ads refresh row older than STALE_RUN_MS as failed so it can never be mistaken for an active lock or an in-flight report worth reusing. Never touches Ads data tables, never deletes rows. */
async function cleanupStaleRuns(admin: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString()
  const { data: staleRows } = await admin
    .from('internal_data_refresh_runs')
    .select('id')
    .like('source', 'ads_%')
    .eq('status', 'running')
    .lt('started_at', cutoff)
  if (!staleRows || staleRows.length === 0) return
  await admin
    .from('internal_data_refresh_runs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: 'Stale running report cleaned up before sync; no data imported.' })
    .in('id', staleRows.map(r => r.id))
  console.log(`Cleaned up ${staleRows.length} stale running refresh-run row(s) older than 2 hours.`)
}

/** True if a sync for this workspace+profile is already running (and not stale — cleanupStaleRuns must run first). */
async function isSyncLocked(admin: SupabaseClient, workspaceId: string, profileId: string): Promise<boolean> {
  const { data } = await admin
    .from('internal_data_refresh_runs')
    .select('id')
    .like('source', 'ads_%')
    .eq('workspace_id', workspaceId)
    .eq('profile_id', profileId)
    .eq('status', 'running')
    .limit(1)
  return Boolean(data && data.length > 0)
}

type ReusableReport = { amazonReportId: string; alreadySucceeded: boolean }

/** Checks for an existing Amazon report ID for this exact (workspace, profile, report type, date range) before requesting a new one.
 *  Always looks back up to Amazon's 30-day report retention window — a timed-out or failed run's report may have completed on
 *  Amazon's side by the time we retry, so we reuse it rather than submitting a duplicate. Only skips (alreadySucceeded=true)
 *  if the successful import is recent enough to avoid redundant re-imports on back-to-back manual runs. */
async function findReusableReport(admin: SupabaseClient, requestKey: string, forceRefresh: boolean): Promise<ReusableReport | null> {
  if (forceRefresh) return null
  const retentionCutoff = new Date(Date.now() - REUSE_RETENTION_MS).toISOString()
  const { data } = await admin
    .from('internal_data_refresh_runs')
    .select('status, amazon_report_id, started_at')
    .eq('report_request_key', requestKey)
    .gte('started_at', retentionCutoff)
    .not('amazon_report_id', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const decision = decideReportReuse(
    data ? { status: data.status as string, amazon_report_id: data.amazon_report_id as string | null, started_at: data.started_at as string } : null,
    new Date(),
  )
  if (!decision.reuse || !decision.amazonReportId) return null
  return { amazonReportId: decision.amazonReportId, alreadySucceeded: decision.alreadySucceeded }
}

type ReportOutcome = { source: string; status: 'success' | 'failed' | 'skipped' }

async function syncOneReport(
  admin: SupabaseClient,
  ctx: AdsApiContext,
  workspaceId: string,
  profileId: string,
  def: ReportDef,
  startDate: string,
  endDate: string,
  reportTimeoutMs: number,
  forceRefresh: boolean,
): Promise<ReportOutcome> {
  const requestKey = `${workspaceId}|${profileId}|${def.source}|${startDate}|${endDate}`
  const reusable = await findReusableReport(admin, requestKey, forceRefresh)

  if (reusable?.alreadySucceeded) {
    console.log(`  ${def.source}: SKIPPED — already synced successfully for this exact range within the last 6h (use --force-refresh to redo).`)
    await admin.from('internal_data_refresh_runs').insert({
      workspace_id: workspaceId, profile_id: profileId, source: def.source, status: 'skipped',
      date_from: startDate, date_to: endDate, finished_at: new Date().toISOString(),
      report_request_key: requestKey,
      error_message: 'Already synced recently for this exact date range; use --force-refresh to redo.',
    })
    return { source: def.source, status: 'skipped' }
  }

  const { data: runRow } = await admin
    .from('internal_data_refresh_runs')
    .insert({ workspace_id: workspaceId, profile_id: profileId, source: def.source, status: 'running', date_from: startDate, date_to: endDate, report_request_key: requestKey })
    .select('id')
    .single()
  const runId = runRow?.id as string | undefined

  try {
    let reportId: string
    if (reusable) {
      reportId = reusable.amazonReportId
      console.log(`  ${def.source}: reusing existing Amazon report ${reportId} (may already be completed on Amazon's side).`)
    } else {
      reportId = await requestAdsReportWithRetry(ctx, def.type, startDate, endDate, def.source)
    }
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_id: reportId, amazon_report_status: 'PENDING', amazon_report_created_at: new Date().toISOString() }).eq('id', runId)
    }

    const effectiveTimeoutMs = def.timeoutMs ?? reportTimeoutMs
    console.log(`  ${def.source}: waiting up to ${effectiveTimeoutMs}ms for report ${reportId} (window ${startDate}..${endDate})`)
    const downloadUrl = await waitForAdsReport(ctx, reportId, { maxWaitMs: effectiveTimeoutMs })
    if (runId) {
      await admin.from('internal_data_refresh_runs').update({ amazon_report_status: 'COMPLETED', amazon_report_completed_at: new Date().toISOString() }).eq('id', runId)
    }
    const jsonRows = await downloadAdsReportRows(downloadUrl)
    const csv = jsonRowsToCsv(jsonRows)

    let insertedCount = 0
    let updatedCount = 0
    let rejectedCount = 0

    if (def.kind === null) {
      const result = parseAdsCampaignDailyReport(csv)
      if (!result.ok) throw new Error(result.error)
      rejectedCount = result.rejected.length
      if (result.accepted.length > 0) {
        const { data: batch, error: batchError } = await admin
          .from(def.batchTable)
          .insert({
            workspace_id: workspaceId,
            profile_id: profileId,
            original_filename: `ads-api-auto-${def.source}-${startDate}-${endDate}`,
            report_date_start: result.stats.dateRangeStart,
            report_date_end: result.stats.dateRangeEnd,
            row_count: result.stats.totalRowCount,
            accepted_count: result.stats.acceptedCount,
            rejected_count: result.stats.rejectedCount,
            total_spend: result.stats.totalSpend,
            total_sales: result.stats.totalSales,
            campaign_count: result.stats.campaignCount,
            unmapped_campaign_count: result.stats.unmappedCampaignCount,
          })
          .select('id')
          .single()
        if (batchError || !batch) throw new Error(`Could not record upload batch: ${batchError?.message ?? 'unknown error'}`)

        const dedupedRows = new Map<string, ReturnType<typeof campaignDailyRowFor>>()
        for (const record of result.accepted) {
          const row = campaignDailyRowFor(record, workspaceId, profileId, batch.id as string)
          dedupedRows.set(row.dedupe_key, row)
        }
        const upsertResult = await upsertByDedupeKey(admin, def.table, workspaceId, profileId, [...dedupedRows.values()])
        insertedCount = upsertResult.insertedCount
        updatedCount = upsertResult.updatedCount
        await admin.from(def.batchTable).update({ inserted_count: insertedCount, updated_count: updatedCount }).eq('id', batch.id)
      }
    } else {
      const result = parseDeepReport(csv, def.kind)
      if (!result.ok) throw new Error(result.error)
      rejectedCount = result.rejected.length
      if (result.accepted.length > 0) {
        const costMasterCategoryBySkuNorm = new Map<string, string | null>()
        if (def.kind === 'advertised_product') {
          const { data } = await admin.from('internal_sku_cost_master').select('sku_norm, category').eq('workspace_id', workspaceId).limit(10000)
          for (const row of data ?? []) costMasterCategoryBySkuNorm.set(row.sku_norm as string, (row.category as string | null) ?? null)
        }
        let unmappedCount = 0
        const resolved = result.accepted.map(record => {
          const portfolio = def.kind === 'advertised_product'
            ? resolveAdvertisedProductPortfolio(record, costMasterCategoryBySkuNorm)
            : record.easyhomePortfolio
          if (portfolio === 'Unmapped / Needs Review') unmappedCount += 1
          return { record, portfolio }
        })

        const { data: batch, error: batchError } = await admin
          .from(def.batchTable)
          .insert({
            workspace_id: workspaceId,
            profile_id: profileId,
            report_kind: def.kind,
            original_filename: `ads-api-auto-${def.source}-${startDate}-${endDate}`,
            report_date_start: result.stats.dateRangeStart,
            report_date_end: result.stats.dateRangeEnd,
            row_count: result.stats.totalRowCount,
            accepted_count: result.stats.acceptedCount,
            rejected_count: result.stats.rejectedCount,
            total_spend: result.stats.totalSpend,
            total_sales: result.stats.totalSales,
            total_purchases: result.stats.totalPurchases,
            campaign_count: result.stats.campaignCount,
            unmapped_count: unmappedCount,
            attribution_window_used: result.stats.attributionWindowUsed,
          })
          .select('id')
          .single()
        if (batchError || !batch) throw new Error(`Could not record upload batch: ${batchError?.message ?? 'unknown error'}`)

        const dedupedRows = new Map<string, ReturnType<typeof deepReportRowFor>>()
        for (const { record, portfolio } of resolved) {
          const row = deepReportRowFor(record, def.kind, workspaceId, profileId, batch.id as string, portfolio)
          dedupedRows.set(row.dedupe_key, row)
        }
        const upsertResult = await upsertByDedupeKey(admin, def.table, workspaceId, profileId, [...dedupedRows.values()])
        insertedCount = upsertResult.insertedCount
        updatedCount = upsertResult.updatedCount
        await admin.from(def.batchTable).update({ inserted_count: insertedCount, updated_count: updatedCount }).eq('id', batch.id)
      }
    }

    await admin
      .from('internal_data_refresh_runs')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        rows_fetched: jsonRows.length,
        rows_inserted: insertedCount,
        rows_updated: updatedCount,
        rows_rejected: rejectedCount,
      })
      .eq('id', runId)

    console.log(`  ${def.source}: fetched ${jsonRows.length}, inserted ${insertedCount}, updated ${updatedCount}, rejected ${rejectedCount}`)
    return { source: def.source, status: 'success' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  ${def.source}: FAILED — ${message}`)
    if (runId) {
      await admin
        .from('internal_data_refresh_runs')
        .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message.slice(0, 2000) })
        .eq('id', runId)
    }
    return { source: def.source, status: 'failed' }
  }
}

type BackfillOptions = {
  backfill: boolean
  chunkDays: number
  adProducts: string[]
  noDeep: boolean
}

async function runSyncForProfile(
  admin: SupabaseClient,
  ctx: AdsApiContext,
  workspaceId: string,
  profileId: string,
  profileLabel: string,
  startDate: string,
  endDate: string,
  reportTimeoutMs: number,
  forceRefresh: boolean,
  bfOpts: BackfillOptions,
  getAccessToken?: () => Promise<string>,
): Promise<boolean> {
  const outcomes: ReportOutcome[] = []

  if (bfOpts.backfill) {
    const chunks = dateChunks(startDate, endDate, bfOpts.chunkDays)
    const campDefs = campaignDefsFor(bfOpts.adProducts)
    const dDeepDefs = bfOpts.noDeep ? [] : deepReportDefs()

    console.log(`  Backfill mode: ${chunks.length} chunks × ${campDefs.length} campaign type(s)${dDeepDefs.length > 0 ? ` + ${dDeepDefs.length} deep report(s)` : ' (no-deep)'}`)

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (getAccessToken) {
        try {
          ctx.accessToken = await getAccessToken()
          console.log(`  [token refreshed for campaign chunk ${i + 1}/${chunks.length}]`)
        } catch (err) {
          console.error(`  Token refresh failed at campaign chunk ${i + 1}: ${err instanceof Error ? err.message : err} — aborting remaining chunks`)
          break
        }
      }
      console.log(`\n  Campaign chunk ${i + 1}/${chunks.length}: ${chunk.from} → ${chunk.to}`)
      for (const def of campDefs) {
        outcomes.push(await syncOneReport(admin, ctx, workspaceId, profileId, def, chunk.from, chunk.to, reportTimeoutMs, forceRefresh))
      }
    }

    if (dDeepDefs.length > 0) {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (getAccessToken) {
          try {
            ctx.accessToken = await getAccessToken()
            console.log(`  [token refreshed for deep chunk ${i + 1}/${chunks.length}]`)
          } catch (err) {
            console.error(`  Token refresh failed at deep chunk ${i + 1}: ${err instanceof Error ? err.message : err} — aborting remaining chunks`)
            break
          }
        }
        console.log(`\n  Deep chunk ${i + 1}/${chunks.length}: ${chunk.from} → ${chunk.to}`)
        for (const def of dDeepDefs) {
          outcomes.push(await syncOneReport(admin, ctx, workspaceId, profileId, def, chunk.from, chunk.to, reportTimeoutMs, forceRefresh))
        }
      }
    }
  } else {
    const defs = bfOpts.adProducts.length > 0
      ? [
          ...campaignDefsFor(bfOpts.adProducts),
          ...(bfOpts.noDeep ? [] : deepReportDefs()),
        ]
      : REPORT_DEFS
    // Same per-request refresh the backfill path already does above — a
    // single token fetched once at script start can expire before later
    // reports run (campaign reports alone can take ~1h+ on this account),
    // so the report that happens to run last (search_term) was seeing
    // frequent 401s that had nothing to do with its own data/size.
    for (const def of defs) {
      if (getAccessToken) {
        try {
          ctx.accessToken = await getAccessToken()
        } catch (err) {
          console.error(`  Token refresh failed before ${def.source}: ${err instanceof Error ? err.message : err} — aborting remaining reports`)
          break
        }
      }
      outcomes.push(await syncOneReport(admin, ctx, workspaceId, profileId, def, startDate, endDate, reportTimeoutMs, forceRefresh))
    }
  }

  return printSummary(profileLabel, outcomes)
}

function printSummary(profileLabel: string, outcomes: ReportOutcome[]): boolean {
  const succeeded = outcomes.filter(o => o.status === 'success').length
  const skipped = outcomes.filter(o => o.status === 'skipped').length
  const failed = outcomes.filter(o => o.status === 'failed').length
  console.log(`  Summary (${profileLabel}): ${succeeded} succeeded, ${skipped} skipped, ${failed} failed — ${outcomes.map(o => `${o.source}=${o.status}`).join(', ')}`)
  return failed > 0
}

/** Mirrors the RLS pattern used across internal_* tables: the workspace with an active/trial "Internal Tester" plan. */
async function resolveInternalWorkspaceId(admin: SupabaseClient): Promise<string | null> {
  const { data: plan } = await admin.from('subscription_plans').select('id').eq('name', 'Internal Tester').maybeSingle()
  if (!plan) return null
  const { data: sub } = await admin
    .from('workspace_subscriptions')
    .select('workspace_id')
    .eq('plan_id', plan.id)
    .in('status', ['active', 'trial'])
    .limit(1)
    .maybeSingle()
  return (sub?.workspace_id as string | undefined) ?? null
}

async function main() {
  const args = parseArgs()
  const days = args.has('days') ? Number(args.get('days')) : 7
  const endDate = args.get('to') ?? addDays(todayIso(), -1)
  const startDate = args.get('from') ?? addDays(endDate, -(Math.max(1, days) - 1))
  const reportTimeoutMs = resolveReportTimeoutMs(args)
  const forceRefresh = args.has('force-refresh')

  const backfill = args.has('backfill')
  const chunkDays = args.has('chunk-days') ? Math.max(1, Number(args.get('chunk-days'))) : 7
  const adProducts = args.has('ad-products')
    ? (args.get('ad-products') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : []
  const noDeep = args.has('no-deep')

  const bfOpts: BackfillOptions = { backfill, chunkDays, adProducts, noDeep }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const modeLabel = backfill ? `, backfill chunk-days=${chunkDays} ad-products=${adProducts.length > 0 ? adProducts.join('+') : 'all'}${noDeep ? ' no-deep' : ''}` : ''
  console.log(`Brahmastra Ads report sync — range ${startDate} to ${endDate} (read-only, no Amazon write calls), report timeout ${reportTimeoutMs}ms${forceRefresh ? ', force-refresh' : ''}${modeLabel}`)

  await cleanupStaleRuns(admin)

  const { data: connections, error: connError } = await admin
    .from('amazon_ads_connections')
    .select('id, workspace_id, region, refresh_token_encrypted, status')
    .eq('status', 'active')
  if (connError) {
    console.error(`Could not read amazon_ads_connections: ${connError.message}`)
    process.exitCode = 1
    return
  }

  if (connections && connections.length > 0) {
    console.log('Using DB OAuth connection.')
    for (const connection of connections) {
      const workspaceId = connection.workspace_id as string
      const { data: profiles, error: profileError } = await admin
        .from('amazon_ads_profiles')
        .select('profile_id, status, account_name, display_name, brahmastra_sync_enabled, is_primary')
        .eq('amazon_ads_connection_id', connection.id)
        .eq('status', 'active')
      if (profileError || !profiles || profiles.length === 0) {
        console.error(`Workspace ${workspaceId}: no active Amazon Ads profile found — skipping. Run profile sync first.`)
        process.exitCode = 1
        continue
      }

      // Never default to "every profile" — a connection can carry many
      // advertiser profiles for unrelated businesses under the same Amazon
      // login. Only the one profile explicitly selected for Brahmastra in
      // Settings (or the designated primary, if more than one is enabled)
      // may be synced.
      const selection = resolveBrahmastraProfile(profiles.map(p => ({
        profileId: p.profile_id as string,
        brahmastraSyncEnabled: p.brahmastra_sync_enabled as boolean,
        isPrimary: p.is_primary as boolean,
      })))
      if (!selection.ok) {
        console.error(`Workspace ${workspaceId}: ${selection.message}`)
        process.exitCode = 1
        continue
      }

      if (await isSyncLocked(admin, workspaceId, selection.profileId)) {
        console.log(`Workspace ${workspaceId}, profile ${selection.profileId}: Another Amazon Ads sync is already running for this profile. Skipping.`)
        continue
      }

      const profile = profiles.find(p => p.profile_id === selection.profileId)!
      const profileLabel = (profile.display_name as string | null) ?? (profile.account_name as string | null) ?? selection.profileId

      let accessToken: string
      let refreshToken: string
      try {
        refreshToken = decryptToken(connection.refresh_token_encrypted as string)
        const refreshed = await refreshAdsAccessToken(refreshToken)
        accessToken = refreshed.accessToken
      } catch (error) {
        console.error(`Workspace ${workspaceId}: Ads token refresh failed — ${error instanceof Error ? error.message : error}`)
        process.exitCode = 1
        continue
      }

      const region = connection.region as string
      const getAccessToken = async () => {
        const refreshed = await refreshAdsAccessToken(refreshToken)
        return refreshed.accessToken
      }
      const ctx: AdsApiContext = { region, accessToken, profileId: selection.profileId }
      console.log(`Workspace ${workspaceId}, profile ${selection.profileId} (${profileLabel}):`)
      if (await runSyncForProfile(admin, ctx, workspaceId, selection.profileId, profileLabel, startDate, endDate, reportTimeoutMs, forceRefresh, bfOpts, getAccessToken)) process.exitCode = 1
    }
    return
  }

  // No DB OAuth connection — fall back to a directly-configured credential
  // set (AMZN_ADS_* or AMAZON_ADS_* refresh-token env vars) if present.
  const directCreds = resolveDirectAdsCredentials()
  if (!directCreds) {
    console.error('BLOCKED: no active row in amazon_ads_connections, and no direct Ads credential env vars found (AMZN_ADS_CLIENT_ID/AMAZON_ADS_CLIENT_ID, *_CLIENT_SECRET, *_REFRESH_TOKEN, *_PROFILE_ID). Connect an Amazon Ads account (Settings -> Connect Amazon Ads) or set the direct env vars before running this sync.')
    process.exitCode = 1
    return
  }

  console.log('Using direct env Amazon Ads credentials.')
  const workspaceId = await resolveInternalWorkspaceId(admin)
  if (!workspaceId) {
    console.error('BLOCKED: direct Ads credentials were found, but no internal workspace (Internal Tester plan) could be resolved to attribute the synced rows to.')
    process.exitCode = 1
    return
  }

  if (await isSyncLocked(admin, workspaceId, directCreds.profileId)) {
    console.log(`Workspace ${workspaceId}, profile ${directCreds.profileId}: Another Amazon Ads sync is already running for this profile. Skipping.`)
    return
  }

  let accessToken: string
  try {
    const refreshed = await refreshAdsAccessToken(directCreds.refreshToken, { clientId: directCreds.clientId, clientSecret: directCreds.clientSecret })
    accessToken = refreshed.accessToken
  } catch (error) {
    console.error(`Direct-credential Ads token refresh failed — ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    return
  }

  const getAccessToken = async () => {
    const refreshed = await refreshAdsAccessToken(directCreds.refreshToken, { clientId: directCreds.clientId, clientSecret: directCreds.clientSecret })
    return refreshed.accessToken
  }
  const ctx: AdsApiContext = { region: directCreds.region, accessToken, profileId: directCreds.profileId, clientId: directCreds.clientId }
  console.log(`Workspace ${workspaceId}, profile ${directCreds.profileId}:`)
  if (await runSyncForProfile(admin, ctx, workspaceId, directCreds.profileId, directCreds.profileId, startDate, endDate, reportTimeoutMs, forceRefresh, bfOpts, getAccessToken)) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
