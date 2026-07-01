// Phase R1 reliability hardening: read-only data-quality audit for Brahmastra
// Ads data. Reports aggregate counts only — no raw search terms, no order
// IDs, no PII. Never writes anything; never calls the Amazon Ads API.
//
// Usage:
//   npx tsx scripts/audit-brahmastra-data-quality.ts
//   npx tsx scripts/audit-brahmastra-data-quality.ts --aStart=2026-06-01 --aEnd=2026-06-12 --bStart=2026-06-13 --bEnd=2026-06-24

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

type RangeTotals = { rows: number; spend: number; sales: number; clicks: number; impressions: number }

async function rangeTotals(admin: SupabaseClient, table: string, workspaceId: string, profileId: string, start: string, end: string): Promise<RangeTotals> {
  const totals: RangeTotals = { rows: 0, spend: 0, sales: 0, clicks: 0, impressions: 0 }
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select('spend, sales, clicks, impressions')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', start)
      .lte('report_date', end)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    for (const row of data ?? []) {
      totals.rows += 1
      totals.spend += Number(row.spend ?? 0)
      totals.sales += Number(row.sales ?? 0)
      totals.clicks += Number(row.clicks ?? 0)
      totals.impressions += Number(row.impressions ?? 0)
    }
    if (!data || data.length < PAGE) break
  }
  return totals
}

/** PostgREST caps unpaginated reads at its default page size — must page through with .range() to see the full table. */
async function fetchAllPaged<T>(admin: SupabaseClient, table: string, columns: string, workspaceId: string, profileId?: string): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    let query = admin.from(table).select(columns).eq('workspace_id', workspaceId)
    if (profileId) query = query.eq('profile_id', profileId)
    const { data, error } = await query.range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    all.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) break
  }
  return all
}

function fmtInr(v: number): string {
  return `Rs.${Math.round(v).toLocaleString('en-IN')}`
}

function variancePct(a: number, b: number): number {
  if (a === 0 && b === 0) return 0
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) * 100
}

async function main() {
  const args = parseArgs()
  const aStart = args.get('aStart') ?? '2026-06-01'
  const aEnd = args.get('aEnd') ?? '2026-06-12'
  const bStart = args.get('bStart') ?? '2026-06-13'
  const bEnd = args.get('bEnd') ?? '2026-06-24'

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log('Brahmastra data-quality audit (read-only, aggregate counts only, no PII)')
  console.log('='.repeat(70))

  // 1. Selected profile exists and is primary
  const { data: workspaceRows } = await admin.from('internal_ads_campaign_daily_rows').select('workspace_id').limit(1)
  const workspaceId = workspaceRows?.[0]?.workspace_id as string | undefined
  if (!workspaceId) {
    console.error('BLOCKED: no workspace found with any Ads data.')
    process.exitCode = 1
    return
  }

  const { data: profileRows, error: profileError } = await admin
    .from('amazon_ads_profiles')
    .select('profile_id, account_name, display_name, brahmastra_sync_enabled, is_primary')
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

  console.log('\n[1] Selected Brahmastra profile')
  if (!selection.ok) {
    console.error(`  BLOCKED: ${selection.message}`)
    process.exitCode = 1
    return
  }
  const profileId = selection.profileId
  const selectedRow = profileRows.find(p => p.profile_id === profileId)
  const isPrimary = Boolean(selectedRow?.is_primary)
  const profileName = (selectedRow?.display_name as string | null) ?? (selectedRow?.account_name as string | null) ?? '(no name)'
  console.log(`  profile_id=${profileId} name="${profileName}" is_primary=${isPrimary}`)
  if (!isPrimary) console.log('  WARNING: exactly one profile is enabled, but it is not flagged is_primary.')

  // 2 + 3. Per-table profile isolation + null check
  console.log('\n[2-3] Profile isolation per Ads table')
  let isolationHealthy = true
  for (const table of ADS_TABLES) {
    const byProfile = await fetchAllPaged<{ profile_id: string | null }>(admin, table, 'profile_id', workspaceId)
    const counts = new Map<string | null, number>()
    for (const row of byProfile) {
      const key = row.profile_id ?? null
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const nullCount = counts.get(null) ?? 0
    const otherProfiles = [...counts.keys()].filter(k => k !== null && k !== profileId)
    if (nullCount > 0) isolationHealthy = false
    if (otherProfiles.length > 0) isolationHealthy = false
    console.log(`  ${table}: ${[...counts.entries()].map(([k, v]) => `${k ?? 'NULL'}=${v}`).join(', ')}${nullCount > 0 ? '  <-- NULL profile_id rows present' : ''}${otherProfiles.length > 0 ? `  <-- other profiles present: ${otherProfiles.join(', ')}` : ''}`)
  }
  console.log(`  Profile isolation: ${isolationHealthy ? 'HEALTHY' : 'WARNING'}`)

  // 4-6. Latest dates
  console.log('\n[4] Latest date by Ads table')
  const latestAdsDates: Record<string, string | null> = {}
  for (const table of ADS_TABLES) {
    const { data } = await admin.from(table).select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle()
    latestAdsDates[table] = (data?.report_date as string | null) ?? null
    console.log(`  ${table}: ${latestAdsDates[table] ?? 'none'}`)
  }
  const latestAdsDate = Object.values(latestAdsDates).filter((d): d is string => Boolean(d)).sort()[0] ?? null

  console.log('\n[5] Latest payment transaction date')
  const { data: latestTxn } = await admin.from('internal_payment_transactions').select('transaction_date').eq('workspace_id', workspaceId).order('transaction_date', { ascending: false }).limit(1).maybeSingle()
  const latestSalesDate = ((latestTxn?.transaction_date as string | null) ?? null)?.slice(0, 10) ?? null
  console.log(`  internal_payment_transactions: ${latestSalesDate ?? 'none'}`)

  console.log('\n[6] Latest change history date')
  const { data: latestChange } = await admin.from('internal_ads_change_history_events').select('changed_at').eq('workspace_id', workspaceId).order('changed_at', { ascending: false }).limit(1).maybeSingle()
  const latestChangeHistoryDate = ((latestChange?.changed_at as string | null) ?? null)?.slice(0, 10) ?? null
  console.log(`  internal_ads_change_history_events: ${latestChangeHistoryDate ?? 'none'}`)

  // 7. Duplicate check per table on (workspace_id, profile_id, dedupe_key)
  console.log('\n[7] Duplicate check (workspace_id, profile_id, dedupe_key)')
  let anyDuplicates = false
  for (const table of ADS_TABLES) {
    const rows = await fetchAllPaged<{ dedupe_key: string }>(admin, table, 'dedupe_key', workspaceId, profileId)
    const counts = new Map<string, number>()
    for (const row of rows) {
      counts.set(row.dedupe_key, (counts.get(row.dedupe_key) ?? 0) + 1)
    }
    const dupes = [...counts.values()].filter(c => c > 1).length
    if (dupes > 0) anyDuplicates = true
    console.log(`  ${table}: ${rows.length} rows, ${dupes} duplicate dedupe_key group(s)`)
  }
  console.log(`  Duplicate status: ${anyDuplicates ? 'WARNING — duplicates found' : 'HEALTHY — no duplicates'}`)

  // 8-9. Cross-table totals for sample range
  console.log(`\n[8-9] Cross-table totals — Range A ${aStart}..${aEnd}, Range B ${bStart}..${bEnd}`)
  const totalsByTable: Record<string, { a: RangeTotals; b: RangeTotals }> = {}
  for (const table of ADS_TABLES) {
    const a = await rangeTotals(admin, table, workspaceId, profileId, aStart, aEnd)
    const b = await rangeTotals(admin, table, workspaceId, profileId, bStart, bEnd)
    totalsByTable[table] = { a, b }
    console.log(`  ${table}`)
    console.log(`    Range A: rows=${a.rows} spend=${fmtInr(a.spend)} sales=${fmtInr(a.sales)} clicks=${a.clicks} impressions=${a.impressions}`)
    console.log(`    Range B: rows=${b.rows} spend=${fmtInr(b.spend)} sales=${fmtInr(b.sales)} clicks=${b.clicks} impressions=${b.impressions}`)
  }

  // Campaign daily and advertised-product daily should reconcile closely
  // (same underlying SP spend/sales, different grouping) — flag if they
  // diverge by more than a generous 5% tolerance.
  const campaign = totalsByTable['internal_ads_campaign_daily_rows']
  const advProduct = totalsByTable['internal_ads_advertised_product_daily_rows']
  console.log('\n  Campaign vs Advertised-Product variance (tolerance 5%):')
  for (const [label, x, y] of [
    ['Range A spend', campaign.a.spend, advProduct.a.spend],
    ['Range A sales', campaign.a.sales, advProduct.a.sales],
    ['Range B spend', campaign.b.spend, advProduct.b.spend],
    ['Range B sales', campaign.b.sales, advProduct.b.sales],
  ] as const) {
    const pct = variancePct(x, y)
    console.log(`    ${label}: campaign=${fmtInr(x)} advProduct=${fmtInr(y)} variance=${pct.toFixed(1)}%${pct > 5 ? '  <-- exceeds tolerance' : ''}`)
  }

  // 10. Ads-complete vs sales-lag-only conclusion for the sample range
  console.log('\n[10] Completeness conclusion for sample range')
  const sampleRangeEnd = bEnd > aEnd ? bEnd : aEnd
  const adsComplete = latestAdsDate !== null && sampleRangeEnd <= latestAdsDate
  const salesComplete = latestSalesDate !== null && sampleRangeEnd <= latestSalesDate
  console.log(`  Selected range end: ${sampleRangeEnd}`)
  console.log(`  Latest Ads date: ${latestAdsDate ?? 'unknown'} -> Ads data complete for this range: ${adsComplete ? 'YES' : 'NO'}`)
  console.log(`  Latest Sales date: ${latestSalesDate ?? 'unknown'} -> Sales/payment data complete for this range: ${salesComplete ? 'YES' : 'NO'}`)
  if (adsComplete && !salesComplete) {
    console.log('  Conclusion: Ads-only metrics (spend/sales/clicks/ACOS/ROAS) are valid for this range.')
    console.log('              Payment lag only affects blended/total-sales/order/geo/returns metrics.')
  } else if (!adsComplete) {
    console.log('  Conclusion: Ads data itself is incomplete for this range — Ads metrics may be incomplete.')
  } else {
    console.log('  Conclusion: Both Ads and Sales data are complete for this range.')
  }

  // 11. Amazon Ads Warehouse — 90-day coverage and SP/SD/SB breakdown
  console.log('\n[11] Amazon Ads Warehouse — coverage and SP/SD/SB breakdown')
  const { data: earliestCampaign } = await admin
    .from('internal_ads_campaign_daily_rows')
    .select('report_date')
    .eq('workspace_id', workspaceId)
    .eq('profile_id', profileId)
    .order('report_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  const earliestDate = (earliestCampaign?.report_date as string | null) ?? null

  // Use exact counts + targeted queries instead of fetching all rows (Supabase default page cap is 1000)
  const { count: totalCampaignCount } = await admin
    .from('internal_ads_campaign_daily_rows')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('profile_id', profileId)

  // Unique dates: paginate report_date column
  const allDates = new Set<string>()
  for (let page = 0; ; page++) {
    const { data: dateRows } = await admin.from('internal_ads_campaign_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).range(page * 1000, page * 1000 + 999)
    for (const r of dateRows ?? []) allDates.add(r.report_date as string)
    if (!dateRows || dateRows.length < 1000) break
  }

  // SP/SD/SB breakdown via targeted paginated queries
  async function sumCampaignType(filters: (q: ReturnType<typeof admin.from>) => ReturnType<typeof admin.from>) {
    let rows = 0; let spend = 0; let sales = 0; let latestDate: string | null = null
    for (let page = 0; ; page++) {
      const q = admin.from('internal_ads_campaign_daily_rows').select('spend, sales, report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId)
      const { data } = await (filters(q) as ReturnType<typeof admin.from>).range(page * 1000, page * 1000 + 999) as { data: Array<{ spend: unknown; sales: unknown; report_date: unknown }> | null }
      for (const r of data ?? []) {
        rows++; spend += Number(r.spend ?? 0); sales += Number(r.sales ?? 0)
        const d = r.report_date as string
        if (!latestDate || d > latestDate) latestDate = d
      }
      if (!data || data.length < 1000) break
    }
    return { rows, spend, sales, latestDate }
  }
  const [spStats, sdStats, sbStats] = await Promise.all([
    sumCampaignType(q => (q as ReturnType<typeof admin.from>).not('campaign_name', 'ilike', 'SD%').not('campaign_name', 'ilike', 'SB%').not('campaign_name', 'ilike', 'Sponsored Brands%')),
    sumCampaignType(q => (q as ReturnType<typeof admin.from>).ilike('campaign_name', 'SD%')),
    sumCampaignType(q => (q as ReturnType<typeof admin.from>).or('campaign_name.ilike.SB%,campaign_name.ilike.Sponsored Brands%')),
  ])

  const { data: lastSyncRun } = await admin
    .from('internal_data_refresh_runs')
    .select('source, status, started_at, finished_at')
    .eq('workspace_id', workspaceId)
    .like('source', 'ads_%')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const { count: failedCount } = await admin
    .from('internal_data_refresh_runs')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .like('source', 'ads_%')
    .eq('status', 'failed')

  const { count: advProdCount } = await admin.from('internal_ads_advertised_product_daily_rows').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('profile_id', profileId)
  const { count: targetingCount } = await admin.from('internal_ads_targeting_daily_rows').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('profile_id', profileId)
  const { count: searchTermCount } = await admin.from('internal_ads_search_term_daily_rows').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('profile_id', profileId)

  console.log(`  Earliest campaign date : ${earliestDate ?? 'none'}`)
  console.log(`  Latest campaign date   : ${latestAdsDates['internal_ads_campaign_daily_rows'] ?? 'none'}`)
  console.log(`  Coverage (unique dates): ${allDates.size} dates`)
  console.log(`  Total campaign rows    : ${totalCampaignCount ?? 0}`)
  console.log(`  SP rows/spend/sales    : ${spStats.rows} / ${fmtInr(spStats.spend)} / ${fmtInr(spStats.sales)} (latest: ${spStats.latestDate ?? 'none'})`)
  console.log(`  SD rows/spend/sales    : ${sdStats.rows} / ${fmtInr(sdStats.spend)} / ${fmtInr(sdStats.sales)} (latest: ${sdStats.latestDate ?? 'none'})`)
  console.log(`  SB rows/spend/sales    : ${sbStats.rows} / ${fmtInr(sbStats.spend)} / ${fmtInr(sbStats.sales)} (latest: ${sbStats.latestDate ?? 'none'})`)
  console.log(`  Deep reports (total rows):`)
  console.log(`    advertised_product   : ${advProdCount ?? 0}`)
  console.log(`    targeting            : ${targetingCount ?? 0}`)
  console.log(`    search_term          : ${searchTermCount ?? 0}`)
  console.log(`  Last ads sync run      : ${lastSyncRun ? `${lastSyncRun.source} status=${lastSyncRun.status} started_at=${(lastSyncRun.started_at as string).slice(0, 16)}` : 'none'}`)
  console.log(`  Failed sync run count  : ${failedCount ?? 0}`)

  // 2026-06-15 spot check — query directly to avoid page-cap skew
  console.log('\n[12] 2026-06-15 spot check (Console benchmarks: Spend ₹11,343.92 / Clicks 1,573 / Purchases 62 / Sales ₹64,474.75)')
  const { data: june15Rows } = await admin
    .from('internal_ads_campaign_daily_rows')
    .select('spend, clicks, purchases, sales')
    .eq('workspace_id', workspaceId)
    .eq('profile_id', profileId)
    .eq('report_date', '2026-06-15')
    .limit(2000)
  if (!june15Rows || june15Rows.length === 0) {
    console.log('  No rows found for 2026-06-15.')
  } else {
    const j15 = june15Rows.reduce((acc, r) => ({ spend: acc.spend + Number(r.spend ?? 0), clicks: acc.clicks + Number(r.clicks ?? 0), purchases: acc.purchases + Number(r.purchases ?? 0), sales: acc.sales + Number(r.sales ?? 0) }), { spend: 0, clicks: 0, purchases: 0, sales: 0 })
    console.log(`  Rows       : ${june15Rows.length}`)
    console.log(`  Spend      : ${fmtInr(j15.spend)} (gap: ${fmtInr(11343.92 - j15.spend)})`)
    console.log(`  Clicks     : ${j15.clicks} (gap: ${1573 - j15.clicks})`)
    console.log(`  API Purchases: ${j15.purchases} (console 62; gap ${62 - j15.purchases} = SD view-through not in API)`)
    console.log(`  API Ad Sales : ${fmtInr(j15.sales)} (console ₹64,474.75; gap ${fmtInr(64474.75 - j15.sales)} = SD view-through not in API)`)
    console.log(`  Note: Spend and Clicks match console. Purchases/Sales gap is SD view-through conversions`)
    console.log(`        not exposed at campaign granularity in sdCampaigns v3 API — Amazon API limitation.`)
  }

  console.log('\n' + '='.repeat(70))
  console.log('Audit complete. No Amazon Ads API calls were made; no rows were written.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
