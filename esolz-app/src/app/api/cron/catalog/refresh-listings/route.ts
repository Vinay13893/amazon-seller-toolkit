import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import {
  searchListingsItems,
  extractNextPageToken,
  type ListingItem,
} from '@/lib/amazon/spapi-client'
import {
  buildFailedPageMetadata,
  buildSuccessfulPageMetadata,
  upsertCatalogListingsPage,
  type CatalogJobMetadata,
} from '@/lib/amazon/catalog-refresh-listings'

export const runtime = 'nodejs'
export const maxDuration = 200

/**
 * GET /api/cron/catalog/refresh-listings
 *
 * Scheduled refresh of the Amazon catalog (amazon_listing_items).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Listings Items sync only ever ran on-demand, driven page-by-page from
 * the browser via /api/amazon/sync/listings/{start,process}. Nothing refreshed
 * it on a schedule, so in production the catalog silently went stale (71 days
 * as of 2026-09-09). This cron closes that gap without touching the existing
 * user-initiated sync path.
 *
 * DESIGN
 * ------
 * Pure server-side work using the service-role admin client. It deliberately
 * does NOT make HTTP self-calls to the user-authenticated /process route:
 *   1. /process requires a browser session and would 401 a cron.
 *   2. Self-calling the per-deployment VERCEL_URL hits Vercel's Deployment
 *      Protection (SSO) wall and silently no-ops — the exact 2026-07-09
 *      incident documented in the asins snapshot cron.
 * Instead it reuses the same proven lib functions (searchListingsItems,
 * refreshAccessToken, decryptToken, extractNextPageToken) and the same upsert
 * shape (onConflict workspace_id,sku,marketplace_id) that /process uses.
 *
 * RESUMABILITY
 * ------------
 * SP-API listings paginate ~20 SKUs/page; a full catalog can exceed a single
 * function's time budget. Progress (page token + counters) is persisted in an
 * amazon_sync_jobs row of a DEDICATED job_type ('listings_sync_cron'), separate
 * from the user's 'listings_sync' jobs so the two never cancel or race each
 * other. Each invocation advances the in-flight job within a wall-clock budget
 * and stops cleanly; the next scheduled run resumes from the saved page token.
 * A fresh cycle only starts once the last completed cycle is older than
 * REFRESH_INTERVAL_MS, so a healthy catalog is not re-fetched every run.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Requests
 * without a valid match are rejected before anything else runs.
 *
 * Logging is aggregate-count only — never SKUs, tokens, workspace or user ids.
 */

const CRON_JOB_TYPE = 'listings_sync_cron'
const PAGE_SIZE = 20
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

// Stop starting new SP-API pages once this much wall-clock has elapsed, leaving
// headroom under maxDuration (200s) to persist progress and respond.
const TIME_BUDGET_MS = 170_000
// A completed cycle is considered fresh for this long before a new one starts.
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000 // 20h → comfortably once/day
// A 'running' cron job older than this is treated as abandoned (prior crash /
// timeout) and reclaimed rather than blocking future runs forever.
const STALE_RUNNING_MS = 60 * 60 * 1000 // 1h

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any

interface WorkspaceResult {
  status:
    | 'skipped_fresh'
    | 'skipped_no_connection'
    | 'resumed'
    | 'started'
    | 'completed'
    | 'failed'
  reason?: string
  pages_this_run?: number
  items_upserted_this_run?: number
  job_completed?: boolean
}

async function markJobFailed(
  admin: Admin,
  jobId: string,
  errorMessage: string,
  metadata?: CatalogJobMetadata,
): Promise<{ ok: true } | { ok: false; reason: 'job_fail_state_update_failed' }> {
  const update: Record<string, unknown> = {
    status: 'failed',
    finished_at: new Date().toISOString(),
    error_message: errorMessage,
  }
  if (metadata) {
    update.metadata = metadata
  }

  const { error } = await admin
    .from('amazon_sync_jobs')
    .update(update)
    .eq('id', jobId)

  if (error) {
    console.error('[catalog/refresh-listings] failed to persist failed job state')
    return { ok: false, reason: 'job_fail_state_update_failed' }
  }

  return { ok: true }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const startedAt = Date.now()

  // Every workspace with a usable Amazon connection.
  const { data: connections, error: connErr } = await admin
    .from('amazon_connections')
    .select('id, workspace_id, selling_partner_id, marketplace_id, status, refresh_token_encrypted')
    .neq('status', 'revoked')

  if (connErr) {
    console.error('[catalog/refresh-listings] failed to list connections')
    return NextResponse.json({ ok: false, error: 'connection_query_failed' }, { status: 500 })
  }

  const results: Record<string, WorkspaceResult> = {}
  let workspacesProcessed = 0

  for (const conn of connections ?? []) {
    // Respect the shared time budget across ALL workspaces in one invocation.
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      results[conn.workspace_id] = { status: 'skipped_fresh', reason: 'time_budget_reached' }
      continue
    }

    try {
      const res = await refreshWorkspaceCatalog(admin, conn, startedAt)
      results[conn.workspace_id] = res
      if (res.status !== 'skipped_fresh' && res.status !== 'skipped_no_connection') {
        workspacesProcessed++
      }
    } catch {
      const reason = 'workspace_refresh_failed'
      console.error('[catalog/refresh-listings] workspace refresh failed')
      results[conn.workspace_id] = { status: 'failed', reason }
    }
  }

  return NextResponse.json({
    ok: true,
    workspaces_seen: connections?.length ?? 0,
    workspaces_processed: workspacesProcessed,
    elapsed_ms: Date.now() - startedAt,
    results,
  })
}

async function refreshWorkspaceCatalog(
  admin: Admin,
  conn: {
    id: string
    workspace_id: string
    selling_partner_id: string | null
    marketplace_id: string | null
    status: string
    refresh_token_encrypted: string | null
  },
  invocationStartedAt: number,
): Promise<WorkspaceResult> {
  if (!conn.selling_partner_id || !conn.refresh_token_encrypted) {
    return { status: 'skipped_no_connection', reason: 'missing_seller_id_or_token' }
  }

  const marketplaceId = conn.marketplace_id ?? DEFAULT_MARKETPLACE_ID
  const nowIso = new Date().toISOString()

  // ── Reclaim any abandoned in-flight cron job for this workspace ────────────
  const { data: runningJobs, error: runningJobErr } = await admin
    .from('amazon_sync_jobs')
    .select('id, metadata, started_at')
    .eq('workspace_id', conn.workspace_id)
    .eq('job_type', CRON_JOB_TYPE)
    .eq('status', 'running')
    .order('created_at', { ascending: false })

  if (runningJobErr) {
    return { status: 'failed', reason: 'running_job_query_failed' }
  }

  let job: { id: string; metadata: CatalogJobMetadata } | null = null

  for (const r of runningJobs ?? []) {
    const startedMs = r.started_at ? new Date(r.started_at).getTime() : 0
    if (Date.now() - startedMs > STALE_RUNNING_MS) {
      // Abandoned — mark failed so it stops blocking, don't resume mid-flight.
      const { error: reclaimErr } = await admin
        .from('amazon_sync_jobs')
        .update({ status: 'failed', finished_at: nowIso, error_message: 'reclaimed_stale_running' })
        .eq('id', r.id)
      if (reclaimErr) {
        console.error('[catalog/refresh-listings] failed to reclaim stale running job')
        return { status: 'failed', reason: 'stale_job_reclaim_failed' }
      }
    } else if (!job) {
      job = { id: r.id, metadata: (r.metadata ?? {}) as CatalogJobMetadata }
    }
  }

  let resumed = false
  if (job) {
    resumed = true
  } else {
    // No live job — only start a new cycle if the last completed one is stale.
    const { data: lastCompleted, error: completedJobErr } = await admin
      .from('amazon_sync_jobs')
      .select('finished_at')
      .eq('workspace_id', conn.workspace_id)
      .eq('job_type', CRON_JOB_TYPE)
      .eq('status', 'completed')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (completedJobErr) {
      return { status: 'failed', reason: 'completed_job_query_failed' }
    }

    const lastMs = lastCompleted?.finished_at
      ? new Date(lastCompleted.finished_at).getTime()
      : 0
    if (Date.now() - lastMs < REFRESH_INTERVAL_MS) {
      return { status: 'skipped_fresh', reason: 'within_refresh_interval' }
    }

    const { data: created, error: createErr } = await admin
      .from('amazon_sync_jobs')
      .insert({
        workspace_id: conn.workspace_id,
        connection_id: conn.id,
        job_type: CRON_JOB_TYPE,
        status: 'running',
        started_at: nowIso,
        metadata: {},
      })
      .select('id, metadata')
      .single()

    if (createErr || !created) {
      return { status: 'failed', reason: 'job_create_failed' }
    }
    job = { id: created.id, metadata: (created.metadata ?? {}) as CatalogJobMetadata }
  }

  // ── Refresh access token once for this workspace ───────────────────────────
  let accessToken: string
  try {
    const refreshToken = decryptToken(conn.refresh_token_encrypted)
    const result = await refreshAccessToken(refreshToken)
    accessToken = result.access_token
    const enc = encryptToken(accessToken)
    const exp = new Date(Date.now() + result.expires_in * 1000).toISOString()
    const { error: tokenPersistErr } = await admin
      .from('amazon_connections')
      .update({ access_token_encrypted: enc, access_token_expires_at: exp, updated_at: nowIso })
      .eq('id', conn.id)
    if (tokenPersistErr) {
      // Non-fatal: this invocation can continue with the in-memory token. The
      // next run can refresh again from the stored refresh token.
      console.warn('[catalog/refresh-listings] refreshed token persistence failed')
    }
  } catch {
    const reason = 'token_refresh_failed'
    const failed = await markJobFailed(admin, job.id, reason)
    if (!failed.ok) return { status: 'failed', reason: failed.reason }
    return { status: 'failed', reason }
  }

  // ── Page through listings within the shared time budget ────────────────────
  let pageToken = job.metadata.page_token ?? undefined
  let pages = job.metadata.pages ?? 0
  let itemsFetched = job.metadata.items_fetched ?? 0
  let itemsUpserted = job.metadata.items_upserted ?? 0
  let pagesThisRun = 0
  let upsertedThisRun = 0

  while (Date.now() - invocationStartedAt <= TIME_BUDGET_MS) {
    let items: ListingItem[] = []
    let nextPageToken: string | undefined
    try {
      const res = await searchListingsItems(accessToken, {
        sellerId: conn.selling_partner_id,
        marketplaceId,
        pageSize: PAGE_SIZE,
        pageToken,
      })
      items = res.items ?? []
      nextPageToken = extractNextPageToken(res as typeof res & Record<string, unknown>)
    } catch {
      const reason = 'spapi_listings_page_failed'
      // Persist progress so a retry resumes from the same page, then fail loudly.
      const failed = await markJobFailed(
        admin,
        job.id,
        reason,
        buildFailedPageMetadata({ pages, itemsFetched, itemsUpserted }, pageToken),
      )
      if (!failed.ok) return { status: 'failed', reason: failed.reason }
      return { status: 'failed', reason, pages_this_run: pagesThisRun, items_upserted_this_run: upsertedThisRun }
    }

    const syncedAt = new Date().toISOString()
    const pageUpserts = await upsertCatalogListingsPage({
      items,
      marketplaceId,
      workspaceId: conn.workspace_id,
      connectionId: conn.id,
      syncedAt,
      upsertListing: row =>
        admin
          .from('amazon_listing_items')
          .upsert(row, { onConflict: 'workspace_id,sku,marketplace_id' }),
    })

    if (!pageUpserts.ok) {
      const confirmedThisRun = upsertedThisRun + pageUpserts.confirmedUpserts
      const failed = await markJobFailed(
        admin,
        job.id,
        pageUpserts.reason,
        buildFailedPageMetadata({ pages, itemsFetched, itemsUpserted }, pageToken),
      )
      if (!failed.ok) return { status: 'failed', reason: failed.reason }
      console.error('[catalog/refresh-listings] listing upsert failed')
      return {
        status: 'failed',
        reason: pageUpserts.reason,
        pages_this_run: pagesThisRun,
        items_upserted_this_run: confirmedThisRun,
        job_completed: false,
      }
    }

    itemsFetched += items.length
    itemsUpserted += pageUpserts.confirmedUpserts
    upsertedThisRun += pageUpserts.confirmedUpserts
    pages++
    pagesThisRun++
    const successfulPageMetadata = buildSuccessfulPageMetadata(
      { pages: pages - 1, itemsFetched, itemsUpserted },
      nextPageToken,
    )

    // Persist progress after every page so any interruption is resumable.
    const { error: progressErr } = await admin
      .from('amazon_sync_jobs')
      .update({
        metadata: successfulPageMetadata,
      })
      .eq('id', job.id)
    if (progressErr) {
      console.error('[catalog/refresh-listings] failed to persist page progress')
      const failed = await markJobFailed(admin, job.id, 'page_progress_persist_failed')
      if (!failed.ok) return { status: 'failed', reason: failed.reason }
      return {
        status: 'failed',
        reason: 'page_progress_persist_failed',
        pages_this_run: pagesThisRun,
        items_upserted_this_run: upsertedThisRun,
        job_completed: false,
      }
    }

    pageToken = nextPageToken

    if (!nextPageToken) {
      // Reached the end — this cycle is complete.
      const completedAt = new Date().toISOString()
      const { error: completeErr } = await admin
        .from('amazon_sync_jobs')
        .update({ status: 'completed', finished_at: completedAt })
        .eq('id', job.id)
      if (completeErr) {
        console.error('[catalog/refresh-listings] failed to persist completed job state')
        const failed = await markJobFailed(admin, job.id, 'job_complete_state_update_failed')
        if (!failed.ok) return { status: 'failed', reason: failed.reason }
        return {
          status: 'failed',
          reason: 'job_complete_state_update_failed',
          pages_this_run: pagesThisRun,
          items_upserted_this_run: upsertedThisRun,
          job_completed: false,
        }
      }

      // Job completion is authoritative. This derived marker is best-effort:
      // its failure must never undo a successfully completed catalog cycle.
      let freshnessWarning: string | undefined
      try {
        const { error: connectionFreshErr } = await admin
          .from('amazon_connections')
          .update({ last_sync_at: completedAt })
          .eq('id', conn.id)
        if (connectionFreshErr) freshnessWarning = 'connection_freshness_persist_failed'
      } catch {
        freshnessWarning = 'connection_freshness_persist_failed'
      }
      if (freshnessWarning) {
        console.warn('[catalog/refresh-listings] completed catalog freshness marker update failed')
      }

      return {
        status: 'completed',
        ...(freshnessWarning ? { reason: freshnessWarning } : {}),
        pages_this_run: pagesThisRun,
        items_upserted_this_run: upsertedThisRun,
        job_completed: true,
      }
    }
  }

  // Time budget hit with more pages remaining — leave job 'running' for the
  // next scheduled invocation to resume.
  return {
    status: resumed ? 'resumed' : 'started',
    pages_this_run: pagesThisRun,
    items_upserted_this_run: upsertedThisRun,
    job_completed: false,
  }
}
