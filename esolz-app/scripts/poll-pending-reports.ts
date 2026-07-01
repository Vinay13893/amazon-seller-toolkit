// R10.3: Poll Amazon report IDs that previously timed out on our side.
// Amazon continues generating reports after we stop waiting. This script
// looks up all failed runs where we have an amazon_report_id but hit our
// polling timeout, then re-polls Amazon to see if they've since completed.
// If completed, it downloads, parses, and upserts the data — no new report
// request needed. Safe to run multiple times (idempotent upserts).
//
// Usage:
//   npx tsx scripts/poll-pending-reports.ts
//   npx tsx scripts/poll-pending-reports.ts --max-wait-ms=60000   # per-report poll ceiling (default 300000ms)
//   npx tsx scripts/poll-pending-reports.ts --lookback-hours=72   # how far back to search (default 48h)

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import {
  refreshAdsAccessToken,
  pollAdsReport,
  waitForAdsReport,
  downloadAdsReportRows,
  type AdsApiContext,
} from '../src/lib/internal/amazon-ads-reporting-client'
import { jsonRowsToCsv } from '../src/lib/internal/json-rows-to-csv'
import { resolveDirectAdsCredentials } from '../src/lib/internal/amazon-ads-direct-credentials'
import { resolveBrahmastraProfile } from '../src/lib/internal/brahmastra-ads-profile-selection'
import { parseAdsCampaignDailyReport, type AdsCampaignDailyRecord } from '../src/lib/internal/ads-campaign-daily-parser'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* no .env.local */ }

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/)
    if (m) args.set(m[1], m[2] ?? '1')
  }
  return args
}

const SOURCE_TO_TABLE: Record<string, { table: string; batchTable: string }> = {
  ads_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches' },
  ads_sd_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches' },
  ads_sb_campaign_daily: { table: 'internal_ads_campaign_daily_rows', batchTable: 'internal_ads_campaign_upload_batches' },
}

function campaignDailyRowFor(record: AdsCampaignDailyRecord, workspaceId: string, profileId: string, batchId: string) {
  return {
    workspace_id: workspaceId,
    profile_id: profileId,
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

async function upsertByDedupeKey(
  admin: SupabaseClient,
  table: string,
  workspaceId: string,
  profileId: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ insertedCount: number; updatedCount: number }> {
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

async function main() {
  const args = parseArgs()
  const maxWaitMs = args.has('max-wait-ms') ? Number(args.get('max-wait-ms')) : 300_000
  const lookbackHours = args.has('lookback-hours') ? Number(args.get('lookback-hours')) : 48

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1; return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Find all timed-out runs with an amazon_report_id within the lookback window
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()
  const { data: timedOut, error: queryError } = await admin
    .from('internal_data_refresh_runs')
    .select('id, workspace_id, profile_id, source, date_from, date_to, amazon_report_id')
    .eq('status', 'failed')
    .not('amazon_report_id', 'is', null)
    .ilike('error_message', '%did not complete within%')
    .gt('started_at', since)
    .order('started_at', { ascending: true })

  if (queryError) { console.error(`DB query failed: ${queryError.message}`); process.exitCode = 1; return }
  if (!timedOut || timedOut.length === 0) { console.log('No timed-out reports found in the lookback window — nothing to do.'); return }

  console.log(`Found ${timedOut.length} timed-out report(s) from the last ${lookbackHours}h. Polling Amazon...`)

  // Resolve Amazon access token — DB connection path
  const { data: connections } = await admin.from('amazon_ads_connections').select('id, workspace_id, region, refresh_token_encrypted, status').eq('status', 'active')

  let ctx: AdsApiContext | null = null
  let refreshTokenForReuse: string | null = null

  if (connections && connections.length > 0) {
    const conn = connections[0]
    const { data: profiles } = await admin
      .from('amazon_ads_profiles')
      .select('profile_id, brahmastra_sync_enabled, is_primary')
      .eq('amazon_ads_connection_id', conn.id)
      .eq('status', 'active')
    const selection = resolveBrahmastraProfile((profiles ?? []).map(p => ({
      profileId: p.profile_id as string,
      brahmastraSyncEnabled: p.brahmastra_sync_enabled as boolean,
      isPrimary: p.is_primary as boolean,
    })))
    if (!selection.ok) { console.error(`Profile selection failed: ${selection.message}`); process.exitCode = 1; return }
    const refreshToken = decryptToken(conn.refresh_token_encrypted as string)
    const { accessToken } = await refreshAdsAccessToken(refreshToken)
    refreshTokenForReuse = refreshToken
    ctx = { region: conn.region as string, accessToken, profileId: selection.profileId }
  } else {
    const directCreds = resolveDirectAdsCredentials()
    if (!directCreds) { console.error('No Amazon Ads credentials found.'); process.exitCode = 1; return }
    const { accessToken } = await refreshAdsAccessToken(directCreds.refreshToken, { clientId: directCreds.clientId, clientSecret: directCreds.clientSecret })
    ctx = { region: directCreds.region, accessToken, profileId: directCreds.profileId, clientId: directCreds.clientId }
  }

  let succeeded = 0; let stillPending = 0; let failed = 0; let skipped = 0

  for (let i = 0; i < timedOut.length; i++) {
    const run = timedOut[i]
    const reportId = run.amazon_report_id as string
    const source = run.source as string
    const tableInfo = SOURCE_TO_TABLE[source]

    console.log(`\n[${i + 1}/${timedOut.length}] ${source} ${run.date_from} → ${run.date_to} (reportId: ${reportId})`)

    if (!tableInfo) {
      console.log(`  Skipping — no table mapping for source "${source}" (deep reports not handled here)`)
      skipped++; continue
    }

    // Refresh token every 5 reports to avoid expiry
    if (i > 0 && i % 5 === 0 && refreshTokenForReuse) {
      try {
        const { accessToken } = await refreshAdsAccessToken(refreshTokenForReuse)
        ctx.accessToken = accessToken
        console.log('  [token refreshed]')
      } catch { /* non-fatal */ }
    }

    // Quick status check first (one poll, no wait)
    try {
      const quickCheck = await pollAdsReport(ctx, reportId)
      if (quickCheck.status === 'PENDING' || quickCheck.status === 'PROCESSING') {
        console.log(`  Still generating on Amazon (${quickCheck.status}) — skipping, re-run later`)
        stillPending++; continue
      }
      if (quickCheck.status === 'FAILED') {
        console.log(`  Amazon permanently failed this report — marking as permanently_failed`)
        await admin.from('internal_data_refresh_runs').update({ status: 'failed', error_message: 'Amazon report generation FAILURE (permanent)' }).eq('id', run.id)
        failed++; continue
      }

      // COMPLETED — use the URL from this poll or wait briefly
      const downloadUrl = quickCheck.status === 'COMPLETED'
        ? quickCheck.url!
        : await waitForAdsReport(ctx, reportId, { maxWaitMs })

      const jsonRows = await downloadAdsReportRows(downloadUrl)
      const csv = jsonRowsToCsv(jsonRows)
      const result = parseAdsCampaignDailyReport(csv)
      if (!result.ok) throw new Error(result.error)

      const workspaceId = run.workspace_id as string
      const profileId = run.profile_id as string

      if (result.accepted.length > 0) {
        const { data: batch, error: batchError } = await admin
          .from(tableInfo.batchTable)
          .insert({
            workspace_id: workspaceId, profile_id: profileId,
            original_filename: `ads-api-poll-recovered-${source}-${run.date_from}-${run.date_to}`,
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
          .select('id').single()
        if (batchError || !batch) throw new Error(`Batch insert failed: ${batchError?.message}`)

        const dedupedRows = new Map<string, ReturnType<typeof campaignDailyRowFor>>()
        for (const record of result.accepted) {
          const row = campaignDailyRowFor(record, workspaceId, profileId, batch.id as string)
          dedupedRows.set(row.dedupe_key, row)
        }
        const { insertedCount, updatedCount } = await upsertByDedupeKey(admin, tableInfo.table, workspaceId, profileId, [...dedupedRows.values()])
        await admin.from(tableInfo.batchTable).update({ inserted_count: insertedCount, updated_count: updatedCount }).eq('id', batch.id)
        console.log(`  ✅ recovered: fetched ${jsonRows.length}, inserted ${insertedCount}, updated ${updatedCount}, rejected ${result.rejected.length}`)
      } else {
        console.log(`  ✅ recovered: 0 accepted rows (empty date range)`)
      }

      await admin.from('internal_data_refresh_runs')
        .update({ status: 'success', finished_at: new Date().toISOString(), rows_fetched: jsonRows.length, error_message: null })
        .eq('id', run.id)
      succeeded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ ${msg}`)
      failed++
    }
  }

  console.log(`\nDone — ${succeeded} recovered, ${stillPending} still pending on Amazon, ${failed} permanently failed, ${skipped} skipped`)
  if (failed > 0 || stillPending > 0) process.exitCode = 1
}

main().catch(err => { console.error(err); process.exitCode = 1 })
