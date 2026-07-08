// Sync Health Layer: read-only trust signal for each Brahmastra data
// source, so the dashboard (and later the Top 5 Actions Engine) never uses
// stale/broken data silently. This module only reads existing tables — it
// never writes, never calls Amazon APIs, and never touches Ads OAuth/token
// or profile-selection logic (it only calls the existing read-only
// resolveSelectedProfileForWorkspace helper to know which profile to scope
// Ads queries to).
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSelectedProfileForWorkspace } from './brahmastra-selected-profile'

export type SourceHealthStatus =
  | 'healthy'
  | 'stale'
  | 'failed'
  | 'auth_required'
  | 'rate_limited'
  | 'not_configured'

export type SourceKey = 'ads' | 'business_report' | 'settlement' | 'asin_checker'

export type SourceHealth = {
  source: SourceKey
  label: string
  status: SourceHealthStatus
  latestDate: string | null
  lastRunStatus: string | null
  lastRunAt: string | null
  /** Settlement is intentionally always false — it naturally lags and must never block actions. */
  blocksActions: boolean
  message: string
  /** Plain-language lines shown when the card is expanded. */
  details: string[]
}

export type OverallHealthLevel = 'healthy' | 'healthy_with_warnings' | 'warning' | 'critical'

export type BrahmastraDataHealth = {
  sources: SourceHealth[]
  overallLevel: OverallHealthLevel
  /** @deprecated use overallLevel — kept so isSourceTrustworthy()-style callers don't break. True for 'healthy' and 'healthy_with_warnings'. */
  overallTrustworthy: boolean
  generatedAt: string
}

/** A future Top 5 Actions Engine rule must call this before emitting any action tied to a source. */
export function isSourceTrustworthy(status: SourceHealthStatus): boolean {
  return status === 'healthy'
}

function computeOverallLevel(sources: SourceHealth[]): OverallHealthLevel {
  const blocking = sources.filter(s => s.blocksActions)
  if (blocking.some(s => s.status === 'failed' || s.status === 'auth_required')) return 'critical'
  if (blocking.some(s => s.status === 'stale' || s.status === 'rate_limited' || s.status === 'not_configured')) return 'warning'
  if (sources.some(s => !s.blocksActions && s.status !== 'healthy')) return 'healthy_with_warnings'
  return 'healthy'
}

const ADS_STALE_AFTER_DAYS = 2
const BUSINESS_REPORT_STALE_AFTER_DAYS = 2
const SETTLEMENT_STALE_AFTER_DAYS = 14
const ASIN_STALE_AFTER_HOURS = 24
const ASIN_RECENT_SNAPSHOT_SAMPLE = 20
const ASIN_PROBLEM_SNAPSHOT_WARN_RATIO = 0.5
const MAX_LISTING_IDS_SCANNED = 5000
const ADS_RUN_HISTORY_SCAN = 200

// Amazon Ads sync writes one internal_data_refresh_runs row per report type,
// not one row per "Ads sync". A single flaky/rate-limited report type must
// never make the whole Ads card look broken while the others are fine — so
// health is evaluated per source below, not from a single "most recent" row.
const ADS_SOURCES = [
  'ads_campaign_daily',
  'ads_sb_campaign_daily',
  'ads_sd_campaign_daily',
  'ads_advertised_product',
  'ads_targeting',
  'ads_search_term',
] as const

const ADS_SOURCE_LABELS: Record<(typeof ADS_SOURCES)[number], string> = {
  ads_campaign_daily: 'Sponsored Products campaigns',
  ads_sb_campaign_daily: 'Sponsored Brands campaigns',
  ads_sd_campaign_daily: 'Sponsored Display campaigns',
  ads_advertised_product: 'Advertised product report',
  ads_targeting: 'Targeting report',
  ads_search_term: 'Search term report',
}

// Mirrors the literal reason/status strings already established in
// scripts/process-asin-checker-jobs.ts. Duplicated here (not imported) so
// this read-only health module has zero dependency on that script.
const ASIN_PROBLEM_SCRAPE_STATUSES = new Set([
  'partial_pricing_rate_limited',
  'partial_pricing_unavailable',
  'partial_catalog_unavailable',
])

function daysAgo(dateOnly: string | null, nowMs: number): number | null {
  if (!dateOnly) return null
  const then = new Date(`${dateOnly}T00:00:00Z`).getTime()
  return Math.floor((nowMs - then) / 86400000)
}

function hoursAgo(isoTimestamp: string | null, nowMs: number): number | null {
  if (!isoTimestamp) return null
  return (nowMs - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60)
}

function looksLikeAuthError(text: string | null): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return t.includes('401') || t.includes('unauthorized') || t.includes('invalid_grant') || t.includes('invalid grant') || t.includes('reauthenticate') || t.includes('re-authenticate')
}

function looksLikeRateLimit(text: string | null): boolean {
  if (!text) return false
  return text.includes('429') || text.toLowerCase().includes('rate limit') || text.toLowerCase().includes('throttl')
}

type RefreshRunRow = { source?: string; status: string | null; started_at: string | null; finished_at: string | null; error_message: string | null }

/** For simple single-run sources (Business Reports). Ads uses evaluateAdsSource instead — see note above. */
function evaluateSyncedSource(params: {
  source: SourceKey
  label: string
  latestDate: string | null
  lastRun: RefreshRunRow | null
  staleAfterDays: number
  nowMs: number
  hasEverRun: boolean
}): SourceHealth {
  const { source, label, latestDate, lastRun, staleAfterDays, nowMs, hasEverRun } = params
  const authIssue = looksLikeAuthError(lastRun?.error_message ?? null)
  const rateLimitIssue = looksLikeRateLimit(lastRun?.error_message ?? null)
  const age = daysAgo(latestDate, nowMs)

  let status: SourceHealthStatus
  let message: string

  if (!hasEverRun && !latestDate) {
    status = 'not_configured'
    message = `${label} has not been set up yet for this workspace.`
  } else if (authIssue) {
    status = 'auth_required'
    message = `${label} needs to be reconnected — the last sync couldn't sign in.`
  } else if (rateLimitIssue) {
    status = 'rate_limited'
    message = `${label} was slowed down by Amazon on its last sync; using the last good data where available.`
  } else if (lastRun?.status === 'failed') {
    status = 'failed'
    message = `${label} ran into a sync issue and needs a look.`
  } else if (age !== null && age > staleAfterDays) {
    status = 'stale'
    message = `${label} hasn't updated in ${age} day${age === 1 ? '' : 's'} (expected within ${staleAfterDays}).`
  } else if (latestDate) {
    status = 'healthy'
    message = `${label} data is current through ${latestDate}.`
  } else {
    status = 'not_configured'
    message = `${label} has no data yet for this workspace.`
  }

  return {
    source,
    label,
    status,
    latestDate,
    lastRunStatus: lastRun?.status ?? null,
    lastRunAt: lastRun?.started_at ?? null,
    blocksActions: status !== 'healthy',
    message,
    details: [
      `Last sync attempt: ${lastRun?.started_at ? new Date(lastRun.started_at).toISOString() : 'never'} (${lastRun?.status ?? 'no runs yet'})`,
      `Latest available data: ${latestDate ?? 'none yet'}`,
    ],
  }
}

function evaluateAdsSource(params: {
  latestDataDate: string | null
  profileSelected: boolean
  runsBySource: Map<string, RefreshRunRow>
  staleAfterDays: number
  nowMs: number
}): SourceHealth {
  const { latestDataDate, profileSelected, runsBySource, staleAfterDays, nowMs } = params
  const label = 'Amazon Ads'

  if (!profileSelected) {
    return {
      source: 'ads',
      label,
      status: 'not_configured',
      latestDate: null,
      lastRunStatus: null,
      lastRunAt: null,
      blocksActions: true,
      message: 'No Amazon Ads account is selected for sync yet.',
      details: ['No Amazon Ads profile has been chosen for this workspace.'],
    }
  }

  const perSourceRuns = ADS_SOURCES.map(src => runsBySource.get(src) ?? null)
  const hasEverRun = perSourceRuns.some(Boolean)
  const authFailures = perSourceRuns.filter(r => r && looksLikeAuthError(r.error_message)).length
  const rateLimitFailures = perSourceRuns.filter(r => r && looksLikeRateLimit(r.error_message)).length
  // "Persistent" = the majority of report types show the same problem on
  // their own latest attempt — one flaky report type recovering on its own
  // must not make an otherwise-working re-auth look broken.
  const majority = Math.ceil(ADS_SOURCES.length / 2)
  const persistentAuthIssue = authFailures >= majority
  const persistentRateLimit = !persistentAuthIssue && rateLimitFailures >= majority
  const age = daysAgo(latestDataDate, nowMs)
  const mostRecentAttempt = perSourceRuns
    .filter((r): r is RefreshRunRow => Boolean(r?.started_at))
    .sort((a, b) => (b.started_at as string).localeCompare(a.started_at as string))[0] ?? null

  let status: SourceHealthStatus
  let message: string

  if (!hasEverRun && !latestDataDate) {
    status = 'not_configured'
    message = `${label} has not synced yet for this workspace.`
  } else if (persistentAuthIssue) {
    status = 'auth_required'
    message = `${label} needs to be reconnected — most recent syncs couldn't sign in.`
  } else if (persistentRateLimit) {
    status = 'rate_limited'
    message = `${label} is being slowed down by Amazon across most report types; using the last good data where available.`
  } else if (age !== null && age > staleAfterDays) {
    status = 'stale'
    message = `${label} hasn't updated in ${age} day${age === 1 ? '' : 's'} (expected within ${staleAfterDays}).`
  } else if (latestDataDate) {
    status = 'healthy'
    message = `${label} data is current through ${latestDataDate}.`
  } else {
    status = 'not_configured'
    message = `${label} has no data yet for this workspace.`
  }

  const details = ADS_SOURCES.map(src => {
    const run = runsBySource.get(src) ?? null
    const friendlyName = ADS_SOURCE_LABELS[src]
    if (!run) return `${friendlyName}: no sync recorded yet`
    const when = run.started_at ? new Date(run.started_at).toISOString() : 'unknown time'
    if (run.status === 'success') return `${friendlyName}: synced successfully (${when})`
    if (looksLikeAuthError(run.error_message)) return `${friendlyName}: sign-in issue on its last attempt (${when})`
    if (looksLikeRateLimit(run.error_message)) return `${friendlyName}: Amazon asked us to slow down on its last attempt (${when})`
    return `${friendlyName}: last attempt didn't finish, will retry automatically (${when})`
  })

  return {
    source: 'ads',
    label,
    status,
    latestDate: latestDataDate,
    lastRunStatus: mostRecentAttempt?.status ?? null,
    lastRunAt: mostRecentAttempt?.started_at ?? null,
    blocksActions: status !== 'healthy',
    message,
    details,
  }
}

export async function buildBrahmastraDataHealth(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<BrahmastraDataHealth> {
  const nowMs = Date.now()

  const profileSelection = await resolveSelectedProfileForWorkspace(admin, workspaceId)
  const profileId = profileSelection.ok ? profileSelection.profileId : null

  const [
    adsDateRows,
    adsRunHistoryResult,
    businessReportDateResult,
    lastBusinessReportRunResult,
    settlementDateResult,
    listingIdsResult,
  ] = await Promise.all([
    profileId
      ? Promise.all([
          admin.from('internal_ads_campaign_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
          admin.from('internal_ads_advertised_product_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
          admin.from('internal_ads_targeting_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
          admin.from('internal_ads_search_term_daily_rows').select('report_date').eq('workspace_id', workspaceId).eq('profile_id', profileId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
        ])
      : Promise.resolve([{ data: null }, { data: null }, { data: null }, { data: null }] as { data: { report_date?: string } | null }[]),
    admin.from('internal_data_refresh_runs').select('source, status, started_at, finished_at, error_message').eq('workspace_id', workspaceId).like('source', 'ads_%').order('started_at', { ascending: false }).limit(ADS_RUN_HISTORY_SCAN),
    admin.from('internal_business_report_sales_traffic_daily').select('report_date').eq('workspace_id', workspaceId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
    admin.from('internal_data_refresh_runs').select('status, started_at, finished_at, error_message').eq('workspace_id', workspaceId).eq('source', 'business_report_sp_api').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('internal_payment_transactions').select('transaction_date').eq('workspace_id', workspaceId).order('transaction_date', { ascending: false }).limit(1).maybeSingle(),
    admin.from('amazon_listing_items').select('id').eq('workspace_id', workspaceId).limit(MAX_LISTING_IDS_SCANNED),
  ])

  const adsDates = (adsDateRows as { data: { report_date?: string } | null }[]).map(r => r.data?.report_date ?? null).filter((d): d is string => Boolean(d))
  const latestAdsDate = adsDates.length > 0 ? adsDates.sort().reverse()[0] : null
  // Conservative: Ads is only "complete through" the EARLIEST of the four
  // per-report-type latest dates, mirroring the existing minDate() convention
  // used by the main diagnostic route for the same four tables.
  const earliestOfLatestAdsDates = adsDates.length === 4 ? adsDates.sort()[0] : null

  // Reduce the run-history scan to the single latest row per Ads source
  // (rows already arrive newest-first, so the first occurrence wins).
  const adsRunsBySource = new Map<string, RefreshRunRow>()
  for (const row of (adsRunHistoryResult.data ?? []) as RefreshRunRow[]) {
    if (row.source && !adsRunsBySource.has(row.source)) adsRunsBySource.set(row.source, row)
  }

  const ads = evaluateAdsSource({
    latestDataDate: profileId ? (earliestOfLatestAdsDates ?? latestAdsDate) : null,
    profileSelected: Boolean(profileId),
    runsBySource: adsRunsBySource,
    staleAfterDays: ADS_STALE_AFTER_DAYS,
    nowMs,
  })

  const businessReportDate = (businessReportDateResult.data as { report_date?: string } | null)?.report_date ?? null
  const businessReport = evaluateSyncedSource({
    source: 'business_report',
    label: 'Business Reports',
    latestDate: businessReportDate,
    lastRun: (lastBusinessReportRunResult.data as RefreshRunRow) ?? null,
    staleAfterDays: BUSINESS_REPORT_STALE_AFTER_DAYS,
    nowMs,
    hasEverRun: Boolean(lastBusinessReportRunResult.data),
  })

  // Settlement/payment: warning-only by design — settlement naturally lags
  // real-world sales by several days, so it never reports failed/auth_required
  // and never blocks actions, per the approved spec.
  const settlementDate = (settlementDateResult.data as { transaction_date?: string } | null)?.transaction_date?.slice(0, 10) ?? null
  const settlementAge = daysAgo(settlementDate, nowMs)
  const settlementStale = settlementAge !== null && settlementAge > SETTLEMENT_STALE_AFTER_DAYS
  const settlement: SourceHealth = settlementDate
    ? {
        source: 'settlement',
        label: 'Settlement / Payment',
        status: settlementStale ? 'stale' : 'healthy',
        latestDate: settlementDate,
        lastRunStatus: null,
        lastRunAt: null,
        blocksActions: false,
        message: settlementStale
          ? `Settlement data hasn't updated in ${settlementAge} days — this is expected lag, not a failure.`
          : `Settlement data is current through ${settlementDate} (settlement naturally lags order dates by design).`,
        details: [
          `Latest settlement data: ${settlementDate}`,
          'Settlement/payment data always lags a few days behind order dates — this never blocks action recommendations.',
        ],
      }
    : {
        source: 'settlement',
        label: 'Settlement / Payment',
        status: 'not_configured',
        latestDate: null,
        lastRunStatus: null,
        lastRunAt: null,
        blocksActions: false,
        message: 'No settlement/payment data has been imported yet for this workspace.',
        details: ['No settlement/payment data imported yet.'],
      }

  // ASIN checker: asin_snapshots has no workspace_id column directly, so it
  // is scoped through amazon_listing_item_id (bounded scan, matching the
  // existing pagination convention used elsewhere in this codebase).
  const listingIds = ((listingIdsResult.data ?? []) as { id: string }[]).map(row => row.id)
  let asinChecker: SourceHealth
  if (listingIds.length === 0) {
    asinChecker = {
      source: 'asin_checker',
      label: 'ASIN Checker',
      status: 'not_configured',
      latestDate: null,
      lastRunStatus: null,
      lastRunAt: null,
      blocksActions: true,
      message: 'No products are being tracked yet for this workspace.',
      details: ['No ASINs are set up for price/availability checking yet.'],
    }
  } else {
    const [latestSuccessResult, recentSnapshotsResult] = await Promise.all([
      admin.from('asin_snapshots').select('checked_at').in('amazon_listing_item_id', listingIds).eq('scrape_status', 'success').order('checked_at', { ascending: false }).limit(1).maybeSingle(),
      admin.from('asin_snapshots').select('scrape_status').in('amazon_listing_item_id', listingIds).order('checked_at', { ascending: false }).limit(ASIN_RECENT_SNAPSHOT_SAMPLE),
    ])
    const latestSuccessAt = (latestSuccessResult.data as { checked_at?: string } | null)?.checked_at ?? null
    const ageHours = hoursAgo(latestSuccessAt, nowMs)
    const recentStatuses = ((recentSnapshotsResult.data ?? []) as { scrape_status: string | null }[]).map(r => r.scrape_status)
    const problemCount = recentStatuses.filter(s => s !== 'success' && (s === null || ASIN_PROBLEM_SCRAPE_STATUSES.has(s))).length
    const problemRatio = recentStatuses.length > 0 ? problemCount / recentStatuses.length : 0
    const isRateLimitWarning = recentStatuses.length > 0 && problemRatio > ASIN_PROBLEM_SNAPSHOT_WARN_RATIO

    let status: SourceHealthStatus
    let message: string
    if (!latestSuccessAt) {
      status = 'not_configured'
      message = 'No successful price/availability check has completed yet for this workspace.'
    } else if (ageHours !== null && ageHours > ASIN_STALE_AFTER_HOURS) {
      status = 'stale'
      message = `Product pricing/availability hasn't refreshed in ${Math.round(ageHours)}h (expected within ${ASIN_STALE_AFTER_HOURS}h).`
    } else if (isRateLimitWarning) {
      status = 'rate_limited'
      message = `Product pricing is being checked more slowly than usual (Amazon rate limit); ${Math.round(problemRatio * 100)}% of the last ${recentStatuses.length} checks were incomplete. Last known price/BSR/Buy Box/availability is still shown — no data is being lost, only refreshed less often.`
    } else {
      status = 'healthy'
      message = `Product pricing/availability is current — last successful check ${Math.round(ageHours ?? 0)}h ago.`
    }

    asinChecker = {
      source: 'asin_checker',
      label: 'ASIN Checker',
      status,
      latestDate: latestSuccessAt,
      lastRunStatus: null,
      lastRunAt: null,
      blocksActions: status !== 'healthy',
      message,
      details: [
        `Last successful check: ${latestSuccessAt ? new Date(latestSuccessAt).toISOString() : 'never'}`,
        `${recentStatuses.length} recent checks sampled; ${problemCount} were incomplete (rate-limited or unavailable).`,
      ],
    }
  }

  const sources = [ads, businessReport, settlement, asinChecker]
  const overallLevel = computeOverallLevel(sources)

  return {
    sources,
    overallLevel,
    overallTrustworthy: overallLevel === 'healthy' || overallLevel === 'healthy_with_warnings',
    generatedAt: new Date(nowMs).toISOString(),
  }
}
