// Phase 2C.1: smallest-safe daily auto-refresh for the 4 Sponsored Products
// reports Brahmastra reads (campaign / advertised product / targeting /
// search term). Intended to run on Render as a scheduled cron job — NOT on
// Vercel. Read-only against the Amazon Ads Reporting API: only ever creates
// a report and reads it back. Never calls a write endpoint, never touches
// bids/budgets/campaigns/keywords/targets.
//
// Usage:
//   npx tsx scripts/sync-ads-reports.ts                  # last 7 days (today excluded)
//   npx tsx scripts/sync-ads-reports.ts --days=2         # last 2 days (manual test / backfill)
//   npx tsx scripts/sync-ads-reports.ts --from=2026-06-20 --to=2026-06-25
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
import { parseAdsCampaignDailyReport, type AdsCampaignDailyRecord } from '../src/lib/internal/ads-campaign-daily-parser'
import {
  parseDeepReport,
  resolveAdvertisedProductPortfolio,
  type DeepReportKind,
  type DeepReportRecord,
} from '../src/lib/internal/ads-deep-report-parser'

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
    const m = arg.match(/^--([a-zA-Z]+)=(.*)$/)
    if (m) args.set(m[1], m[2])
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

type ReportDef =
  | { type: 'spCampaigns'; source: string; table: string; batchTable: string; kind: null }
  | { type: AdsReportType; source: string; table: string; batchTable: string; kind: DeepReportKind }

const REPORT_DEFS: ReportDef[] = [
  { type: 'spCampaigns', source: 'ads_campaign_daily', table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches', kind: null },
  { type: 'spAdvertisedProduct', source: 'ads_advertised_product', table: 'internal_ads_advertised_product_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'advertised_product' },
  { type: 'spTargeting', source: 'ads_targeting', table: 'internal_ads_targeting_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'targeting' },
  { type: 'spSearchTerm', source: 'ads_search_term', table: 'internal_ads_search_term_daily_rows', batchTable: 'internal_ads_deep_report_upload_batches', kind: 'search_term' },
]

function campaignDailyRowFor(record: AdsCampaignDailyRecord, workspaceId: string, batchId: string) {
  return {
    workspace_id: workspaceId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    campaign_type: record.campaignType,
    targeting_type: record.targetingType,
    portfolio_name: record.portfolioName,
    ad_group_name: record.adGroupName,
    targeting: record.targeting,
    match_type: record.matchType,
    advertised_sku: record.advertisedSku,
    advertised_asin: record.advertisedAsin,
    search_term: record.searchTerm,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: record.easyhomePortfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'ads_api_auto',
  }
}

function deepReportRowFor(record: DeepReportRecord, kind: DeepReportKind, workspaceId: string, batchId: string, portfolio: string) {
  const base = {
    workspace_id: workspaceId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    ad_group_name: record.adGroupName,
    ad_group_id: record.adGroupId,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    units: record.units,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: portfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'ads_api_auto',
  }
  if (kind === 'advertised_product') return { ...base, advertised_asin: record.advertisedAsin, advertised_sku: record.advertisedSku }
  if (kind === 'targeting') {
    return {
      ...base,
      targeting: record.targeting,
      keyword: record.keyword,
      keyword_type: record.keywordType,
      keyword_id: record.keywordId,
      keyword_bid: record.keywordBid,
      match_type: record.matchType,
    }
  }
  return { ...base, search_term: record.searchTerm, targeting: record.targeting }
}

/** Same dedupe-by-key insert/update split already used by the manual-upload import routes. */
async function upsertByDedupeKey(admin: SupabaseClient, table: string, workspaceId: string, rows: Array<Record<string, unknown>>): Promise<{ insertedCount: number; updatedCount: number }> {
  if (rows.length === 0) return { insertedCount: 0, updatedCount: 0 }
  const CHUNK = 500
  const PAGE = 1000
  const existingIdByKey = new Map<string, string>()
  for (let page = 0; ; page += 1) {
    const { data: pageRows, error } = await admin
      .from(table)
      .select('id, dedupe_key')
      .eq('workspace_id', workspaceId)
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`Reading existing ${table} rows failed: ${error.message}`)
    for (const row of pageRows ?? []) existingIdByKey.set(row.dedupe_key as string, row.id as string)
    if (!pageRows || pageRows.length < PAGE) break
  }

  const insertRows: Array<Record<string, unknown>> = []
  const updateRows: Array<Record<string, unknown> & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(row.dedupe_key as string)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

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

async function syncOneReport(admin: SupabaseClient, ctx: AdsApiContext, workspaceId: string, def: ReportDef, startDate: string, endDate: string) {
  const { data: runRow } = await admin
    .from('internal_data_refresh_runs')
    .insert({ workspace_id: workspaceId, source: def.source, status: 'running', date_from: startDate, date_to: endDate })
    .select('id')
    .single()
  const runId = runRow?.id as string | undefined

  try {
    const reportId = await requestAdsReport(ctx, def.type, startDate, endDate)
    const downloadUrl = await waitForAdsReport(ctx, reportId)
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
          const row = campaignDailyRowFor(record, workspaceId, batch.id as string)
          dedupedRows.set(row.dedupe_key, row)
        }
        const upsertResult = await upsertByDedupeKey(admin, def.table, workspaceId, [...dedupedRows.values()])
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
          const row = deepReportRowFor(record, def.kind, workspaceId, batch.id as string, portfolio)
          dedupedRows.set(row.dedupe_key, row)
        }
        const upsertResult = await upsertByDedupeKey(admin, def.table, workspaceId, [...dedupedRows.values()])
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  ${def.source}: FAILED — ${message}`)
    if (runId) {
      await admin
        .from('internal_data_refresh_runs')
        .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message.slice(0, 2000) })
        .eq('id', runId)
    }
  }
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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log(`Brahmastra Ads report sync — range ${startDate} to ${endDate} (read-only, no Amazon write calls)`)

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

      const profile = profiles.find(p => p.profile_id === selection.profileId)!
      const profileLabel = (profile.display_name as string | null) ?? (profile.account_name as string | null) ?? selection.profileId

      let accessToken: string
      try {
        const refreshToken = decryptToken(connection.refresh_token_encrypted as string)
        const refreshed = await refreshAdsAccessToken(refreshToken)
        accessToken = refreshed.accessToken
      } catch (error) {
        console.error(`Workspace ${workspaceId}: Ads token refresh failed — ${error instanceof Error ? error.message : error}`)
        process.exitCode = 1
        continue
      }

      const ctx: AdsApiContext = { region: connection.region as string, accessToken, profileId: selection.profileId }
      console.log(`Workspace ${workspaceId}, profile ${selection.profileId} (${profileLabel}):`)
      for (const def of REPORT_DEFS) {
        await syncOneReport(admin, ctx, workspaceId, def, startDate, endDate)
      }
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

  let accessToken: string
  try {
    const refreshed = await refreshAdsAccessToken(directCreds.refreshToken, { clientId: directCreds.clientId, clientSecret: directCreds.clientSecret })
    accessToken = refreshed.accessToken
  } catch (error) {
    console.error(`Direct-credential Ads token refresh failed — ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    return
  }

  const ctx: AdsApiContext = { region: directCreds.region, accessToken, profileId: directCreds.profileId, clientId: directCreds.clientId }
  console.log(`Workspace ${workspaceId}, profile ${directCreds.profileId}:`)
  for (const def of REPORT_DEFS) {
    await syncOneReport(admin, ctx, workspaceId, def, startDate, endDate)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
