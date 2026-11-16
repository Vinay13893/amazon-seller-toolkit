// Independent verifier: requests reports, reads warehouse rows, writes only
// aggregate verification evidence to internal_data_refresh_runs. Never imports
// report rows or changes bids, budgets, campaigns, workbook or Apps Script.
import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import { resolveSelectedProfileForWorkspace } from '../src/lib/internal/brahmastra-selected-profile'
import { resolveDirectAdsCredentials } from '../src/lib/internal/amazon-ads-direct-credentials'
import { adsRetryDelay, AdsApiError } from '../src/lib/internal/ads-api-error'
import { requestAdsReport, waitForAdsReport, downloadAdsReportRows, refreshAdsAccessToken, type AdsApiContext, type AdsReportType } from '../src/lib/internal/amazon-ads-reporting-client'
import { compareTotals, DATASETS, METRICS, emptyTotals, profileDay, shiftDate, RECONCILIATION_SOURCE, RECONCILIATION_VERSION, type Totals, type Comparison } from '../src/lib/internal/ads-reconciliation'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')
const definitions: { type: AdsReportType; dataset: typeof DATASETS[number]; sales: string; purchases: string }[] = [
  { type: 'spCampaigns', dataset: 'campaign', sales: 'sales1d', purchases: 'purchases1d' },
  { type: 'sbCampaigns', dataset: 'campaign', sales: 'sales', purchases: 'purchases' },
  { type: 'sdCampaigns', dataset: 'campaign', sales: 'sales', purchases: 'purchasesClicks' },
  { type: 'spAdvertisedProduct', dataset: 'advertised_product', sales: 'sales1d', purchases: 'purchases1d' },
  { type: 'spTargeting', dataset: 'targeting', sales: 'sales1d', purchases: 'purchases1d' },
  { type: 'spSearchTerm', dataset: 'search_term', sales: 'sales1d', purchases: 'purchases1d' },
]

async function main() {
  const workspaceId = process.argv.find(arg => arg.startsWith('--workspace-id='))?.split('=')[1]
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !workspaceId) throw new Error('Required runtime configuration is missing: database URL, service key, or --workspace-id. Configure credentials in the worker environment.')
  const admin = createClient(url, key, { auth: { persistSession: false } })
  const selection = await resolveSelectedProfileForWorkspace(admin, workspaceId)
  if (!selection.ok) throw new Error('No unambiguous selected Ads profile.')
  const profileId = selection.profileId
  const profile = await admin.from('amazon_ads_profiles').select('timezone,currency_code,amazon_ads_connection_id').eq('workspace_id', workspaceId).eq('profile_id', profileId).single()
  if (profile.error || !profile.data?.timezone || !profile.data.currency_code) throw new Error('Selected profile timezone/currency is unavailable.')
  const timezone = profile.data.timezone as string
  const day = profileDay(new Date(), timezone)
  const windowStart = shiftDate(day, -14), windowEnd = shiftDate(day, -1)
  let getContext: () => Promise<AdsApiContext>
  if (profile.data.amazon_ads_connection_id) {
    const connection = await admin.from('amazon_ads_connections').select('region,refresh_token_encrypted').eq('workspace_id', workspaceId).eq('id', profile.data.amazon_ads_connection_id).eq('status', 'active').single()
    if (connection.error || !connection.data) throw new Error('Selected profile connection is unavailable.')
    const token = decryptToken(connection.data.refresh_token_encrypted)
    const region = connection.data.region
    getContext = async () => ({ region, profileId, accessToken: (await refreshAdsAccessToken(token)).accessToken })
  } else {
    const credentials = resolveDirectAdsCredentials()
    if (!credentials || credentials.profileId !== profileId) throw new Error('Direct credentials must match the selected profile.')
    getContext = async () => ({ profileId, region: credentials.region, clientId: credentials.clientId,
      accessToken: (await refreshAdsAccessToken(credentials.refreshToken, credentials)).accessToken })
  }
  if (process.argv.includes('--check-config')) {
    await getContext()
    console.log('Selected profile, database access and Amazon authentication verified. No reports requested.')
    return
  }
  // Draw without replacement. Samples are recorded before any requests.
  const offsets = Array.from({ length: 14 }, (_, i) => i + 1)
  const dates = Array.from({ length: 3 }, () => shiftDate(day, -offsets.splice(randomInt(offsets.length), 1)[0])).sort()
  const startedAt = new Date().toISOString()
  const baseEvidence = { version: RECONCILIATION_VERSION, day, dates, currency: profile.data.currency_code, timezone }
  const inserted = await admin.from('internal_data_refresh_runs').insert({
    workspace_id: workspaceId, profile_id: profileId, source: RECONCILIATION_SOURCE,
    status: 'running', date_from: windowStart, date_to: windowEnd, started_at: startedAt,
    report_options: { ...baseEvidence, passed: false, comparisons: [] },
  }).select('id').single()
  if (inserted.error || !inserted.data) throw new Error('Unable to record verification start.')
  const runId = inserted.data.id
  try {
    const requiredSources = ['ads_campaign_daily', 'ads_sb_campaign_daily', 'ads_sd_campaign_daily', 'ads_advertised_product', 'ads_targeting', 'ads_search_term']
    const history = await admin.from('internal_data_refresh_runs')
      .select('source,status,date_from,date_to,finished_at,rows_rejected')
      .eq('workspace_id', workspaceId).eq('profile_id', profileId)
      .in('source', requiredSources).neq('status', 'skipped')
      .order('started_at', { ascending: false }).limit(200)
    if (history.error) throw new Error('Unable to verify preceding sync coverage.')
    for (const source of requiredSources) {
      const latest = history.data?.find(row => row.source === source)
      const finished = latest?.finished_at ? Date.parse(latest.finished_at) : NaN
      if (!latest || latest.status !== 'success' || !latest.date_from || !latest.date_to
        || latest.date_from > windowStart || latest.date_to < windowEnd
        || !Number.isFinite(finished) || Date.now() - finished > 36 * 3600000
        || Number(latest.rows_rejected) > 0) throw new Error('A required nightly report lacks complete trailing-14-day coverage.')
    }
    const warehouse = new Map<string, Totals>()
    const amazon = new Map<string, Totals>()
    for (const dataset of DATASETS) {
      for (const date of dates) {
        const totals = emptyTotals()
        // Stable paging; every query carries workspace AND profile scope.
        for (let offset = 0; ; offset += 1000) {
          const response = await admin.from(`internal_ads_${dataset === 'campaign' ? 'campaign' : dataset}_daily_rows`)
            .select('spend,sales,clicks,purchases,impressions').eq('workspace_id', workspaceId).eq('profile_id', profileId)
            .eq('report_date', date).order('id').range(offset, offset + 999)
          if (response.error) throw new Error('Unable to read warehouse metrics.')
          for (const row of response.data ?? []) for (const metric of METRICS) {
            const value = Number(row[metric])
            if (row[metric] === null || !Number.isFinite(value) || value < 0) throw new Error('Invalid warehouse metrics.')
            totals[metric] += value
          }
          if (!response.data || response.data.length < 1000) break
        }
        warehouse.set(`${dataset}|${date}`, totals)
        amazon.set(`${dataset}|${date}`, emptyTotals())
      }
    }
    for (const definition of definitions) {
      const ctx = await getContext()
      let reportId = ''
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          reportId = await requestAdsReport(ctx, definition.type, windowStart, windowEnd)
          break
        } catch (error) {
          if (!(error instanceof AdsApiError) || error.status !== 429 || attempt === 3) throw new Error('Independent report request failed.')
          const delay = adsRetryDelay(error, 30_000 * 2 ** attempt)
          if (delay === null) throw new Error('Independent report requires a later retry.')
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      const download = await waitForAdsReport(ctx, reportId, { maxWaitMs: 1_500_000 })
      const rows = await downloadAdsReportRows(download)
      const fields = { spend: 'cost', sales: definition.sales, clicks: 'clicks', purchases: definition.purchases, impressions: 'impressions' }
      for (const row of rows) {
        if (typeof row.date !== 'string' || row.date < windowStart || row.date > windowEnd) throw new Error('Independent report contains invalid dates.')
        if (!dates.includes(row.date)) continue
        const totals = amazon.get(`${definition.dataset}|${row.date}`)!
        for (const metric of METRICS) {
          const raw = row[fields[metric]]
          const value = Number(raw)
          if (raw === null || raw === undefined || !Number.isFinite(value) || value < 0) throw new Error('Independent report contains invalid metrics.')
          totals[metric] += value
        }
      }
      console.log(`Independent ${definition.type} comparison data received.`)
    }
    // A refresh during sampling can mix warehouse snapshots. Invalidate it.
    const concurrent = await admin.from('internal_data_refresh_runs').select('id').eq('workspace_id', workspaceId).eq('profile_id', profileId)
      .in('source', ['ads_campaign_daily', 'ads_sb_campaign_daily', 'ads_sd_campaign_daily', 'ads_advertised_product', 'ads_targeting', 'ads_search_term'])
      .or(`status.eq.running,started_at.gte.${startedAt},finished_at.gte.${startedAt}`).limit(1)
    if (concurrent.error || concurrent.data?.length) throw new Error('Ads sync overlapped verification; retry after sync finishes.')
    if (profileDay(new Date(), timezone) !== day) throw new Error('Verification crossed the profile day boundary; retry.')
    const comparisons: Comparison[] = DATASETS.flatMap(dataset => dates.map(date => compareTotals(dataset, date, warehouse.get(`${dataset}|${date}`)!, amazon.get(`${dataset}|${date}`)!)))
    // Empty reports cannot validate an operational account.
    const hasActivity = DATASETS.every(dataset => dates.some(date => amazon.get(`${dataset}|${date}`)!.impressions > 0))
    const passed = hasActivity && comparisons.every(result => result.passed)
    const saved = await admin.from('internal_data_refresh_runs').update({ status: passed ? 'success' : 'failed', finished_at: new Date().toISOString(),
      report_options: { ...baseEvidence, comparisons, passed }, error_message: passed ? null : 'Independent metrics differ by more than 2%, or no activity was returned.',
    }).eq('id', runId).eq('workspace_id', workspaceId).eq('profile_id', profileId)
    if (saved.error) throw new Error('Unable to save comparison evidence.')
    console.log(JSON.stringify({ passed, comparedDates: dates, comparisons: comparisons.length }))
    if (!passed) process.exitCode = 1
  } catch (error) {
    // Never serialize Amazon responses, URLs, tokens or report rows.
    const saved = await admin.from('internal_data_refresh_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: 'Independent verification failed or was incomplete. Retry after checking worker health.' }).eq('id', runId).eq('workspace_id', workspaceId).eq('profile_id', profileId)
    if (saved.error) console.error('Verification failure could not be recorded; running evidence remains blocking.')
    throw error
  }
}
main().catch(() => {
  console.error('Ads verification could not complete. Check runtime configuration, selected profile and report availability. No credentials or report contents are logged.')
  process.exitCode = 1
})
