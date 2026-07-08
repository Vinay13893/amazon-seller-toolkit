// Sync Health Layer MVP: read-only trust signal for each Brahmastra data
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
}

export type BrahmastraDataHealth = {
  sources: SourceHealth[]
  overallTrustworthy: boolean
  generatedAt: string
}

/** A future Top 5 Actions Engine rule must call this before emitting any action tied to a source. */
export function isSourceTrustworthy(status: SourceHealthStatus): boolean {
  return status === 'healthy'
}

const ADS_STALE_AFTER_CLOSED_DAYS = 2
const BUSINESS_REPORT_STALE_AFTER_CLOSED_DAYS = 2
const SETTLEMENT_STALE_AFTER_DAYS = 14
const ASIN_STALE_AFTER_HOURS = 24
const ASIN_RECENT_SNAPSHOT_SAMPLE = 20
const ASIN_PROBLEM_SNAPSHOT_WARN_RATIO = 0.5
const MAX_LISTING_IDS_SCANNED = 5000

// Mirrors the literal reason/status strings already established in
// scripts/process-asin-checker-jobs.ts. Duplicated here (not imported) so
// this read-only health module has zero dependency on that script.
const ASIN_PROBLEM_SCRAPE_STATUSES = new Set([
  'partial_pricing_rate_limited',
  'partial_pricing_unavailable',
  'partial_catalog_unavailable',
])

function closedDaysAgo(dateOnly: string | null, nowMs: number): number | null {
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

type RefreshRunRow = { status: string | null; started_at: string | null; finished_at: string | null; error_message: string | null } | null

function evaluateSyncedSource(params: {
  source: SourceKey
  label: string
  latestDate: string | null
  lastRun: RefreshRunRow
  staleAfterClosedDays: number
  nowMs: number
  hasEverRun: boolean
}): SourceHealth {
  const { source, label, latestDate, lastRun, staleAfterClosedDays, nowMs, hasEverRun } = params
  const authIssue = looksLikeAuthError(lastRun?.error_message ?? null)
  const rateLimitIssue = looksLikeRateLimit(lastRun?.error_message ?? null)
  const age = closedDaysAgo(latestDate, nowMs)

  let status: SourceHealthStatus
  let message: string

  if (!hasEverRun && !latestDate) {
    status = 'not_configured'
    message = `${label} has not run yet for this workspace.`
  } else if (authIssue) {
    status = 'auth_required'
    message = `${label} needs re-authentication — last sync reported an auth error.`
  } else if (rateLimitIssue) {
    status = 'rate_limited'
    message = `${label} hit a rate limit on its last run; using last successful data where available.`
  } else if (lastRun?.status === 'failed') {
    status = 'failed'
    message = `${label} sync failed on its last run.`
  } else if (age !== null && age > staleAfterClosedDays) {
    status = 'stale'
    message = `${label} data is stale — latest is ${latestDate}, more than ${staleAfterClosedDays} closed day(s) old.`
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
    lastAdsRunResult,
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
    admin.from('internal_data_refresh_runs').select('status, started_at, finished_at, error_message').eq('workspace_id', workspaceId).like('source', 'ads_%').order('started_at', { ascending: false }).limit(1).maybeSingle(),
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

  const ads = evaluateSyncedSource({
    source: 'ads',
    label: 'Amazon Ads',
    latestDate: profileId ? (earliestOfLatestAdsDates ?? latestAdsDate) : null,
    lastRun: (lastAdsRunResult.data as RefreshRunRow) ?? null,
    staleAfterClosedDays: ADS_STALE_AFTER_CLOSED_DAYS,
    nowMs,
    hasEverRun: Boolean(lastAdsRunResult.data),
  })
  if (!profileId) {
    ads.status = 'not_configured'
    ads.message = 'No Amazon Ads profile is selected for Brahmastra sync yet.'
    ads.blocksActions = true
  }

  const businessReportDate = (businessReportDateResult.data as { report_date?: string } | null)?.report_date ?? null
  const businessReport = evaluateSyncedSource({
    source: 'business_report',
    label: 'Business Reports',
    latestDate: businessReportDate,
    lastRun: (lastBusinessReportRunResult.data as RefreshRunRow) ?? null,
    staleAfterClosedDays: BUSINESS_REPORT_STALE_AFTER_CLOSED_DAYS,
    nowMs,
    hasEverRun: Boolean(lastBusinessReportRunResult.data),
  })

  // Settlement/payment: warning-only by design — settlement naturally lags
  // real-world sales by several days, so it never reports failed/auth_required
  // and never blocks actions, per the approved spec.
  const settlementDate = (settlementDateResult.data as { transaction_date?: string } | null)?.transaction_date?.slice(0, 10) ?? null
  const settlementAge = closedDaysAgo(settlementDate, nowMs)
  const settlement: SourceHealth = settlementDate
    ? {
        source: 'settlement',
        label: 'Settlement / Payment',
        status: settlementAge !== null && settlementAge > SETTLEMENT_STALE_AFTER_DAYS ? 'stale' : 'healthy',
        latestDate: settlementDate,
        lastRunStatus: null,
        lastRunAt: null,
        blocksActions: false,
        message: settlementAge !== null && settlementAge > SETTLEMENT_STALE_AFTER_DAYS
          ? `Settlement data has not updated in ${settlementAge} days — this is expected lag, not a failure.`
          : `Settlement data is current through ${settlementDate} (settlement naturally lags order dates).`,
      }
    : {
        source: 'settlement',
        label: 'Settlement / Payment',
        status: 'not_configured',
        latestDate: null,
        lastRunStatus: null,
        lastRunAt: null,
        blocksActions: false,
        message: 'No settlement/payment data imported yet for this workspace.',
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
      message: 'No ASINs are tracked yet for this workspace.',
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
      message = 'No successful ASIN price/availability snapshot has ever completed for this workspace.'
    } else if (ageHours !== null && ageHours > ASIN_STALE_AFTER_HOURS) {
      status = 'stale'
      message = `ASIN pricing/availability is stale — last successful snapshot was ${Math.round(ageHours)}h ago (threshold ${ASIN_STALE_AFTER_HOURS}h).`
    } else if (isRateLimitWarning) {
      status = 'rate_limited'
      message = `ASIN pricing is rate-limited; ${Math.round(problemRatio * 100)}% of the last ${recentStatuses.length} snapshots were incomplete. Using last successful price/BSR where available.`
    } else {
      status = 'healthy'
      message = `ASIN pricing/availability is current — last successful snapshot ${Math.round(ageHours ?? 0)}h ago.`
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
    }
  }

  const sources = [ads, businessReport, settlement, asinChecker]
  const overallTrustworthy = sources.every(s => !s.blocksActions)

  return {
    sources,
    overallTrustworthy,
    generatedAt: new Date(nowMs).toISOString(),
  }
}
