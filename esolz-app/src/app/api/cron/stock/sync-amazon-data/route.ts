import { NextRequest, NextResponse } from 'next/server'
import {
  advanceStockSyncJob,
  startStockSyncJob,
  type StockSyncConnection,
} from '@/lib/amazon/internal-stock-sync-runner'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 200

/**
 * GET /api/cron/stock/sync-amazon-data
 *
 * Scheduled run of the stock + sales sync (job_type 'internal_stock_sales_sync').
 *
 * WHY THIS EXISTS
 * ---------------
 * The stock sync only ever ran when someone clicked "Sync" in the Stock
 * dashboard, which drives /api/internal/stock-actions/sync-amazon-data one step
 * at a time from the browser. Nothing scheduled it, so FBA inventory and SKU
 * daily sales went stale after the last manual run (late June).
 *
 * This route runs the SAME step logic (shared via internal-stock-sync-runner)
 * server-side, with no browser. A full cycle (listings -> inventory -> ~5 SKUs
 * of sales per step) takes far longer than one invocation, so progress lives in
 * the amazon_sync_jobs row and each 15-minute run resumes it. A new cycle starts
 * only once the last completed one is older than REFRESH_INTERVAL_MS.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * Logging is aggregate-count only — never SKUs, tokens, workspace or user ids.
 */

const JOB_TYPE = 'internal_stock_sales_sync'
const LOOKBACK_DAYS = 90
// Stop starting new steps after this much wall-clock. A sales step takes
// roughly 15-25s, so this leaves headroom under maxDuration (200s).
const TIME_BUDGET_MS = 150_000
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000
// A 'running' job with no progress for this long is abandoned and reclaimed.
const STALE_RUNNING_MS = 3 * 60 * 60 * 1000

type WorkspaceResult = {
  status: 'skipped_fresh' | 'skipped_time_budget' | 'started' | 'resumed' | 'completed' | 'failed'
  reason?: string
  steps?: number
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const startedAt = Date.now()

  const { data: connections, error: connErr } = await admin
    .from('amazon_connections')
    .select('id, workspace_id, status, selling_partner_id, marketplace_id, refresh_token_encrypted')
    .eq('status', 'active')
  if (connErr) {
    console.error('[cron/stock/sync-amazon-data] failed to list connections')
    return NextResponse.json({ ok: false, error: 'connection_query_failed' }, { status: 500 })
  }

  const results: Record<string, WorkspaceResult> = {}
  const counts: Record<WorkspaceResult['status'], number> = {
    skipped_fresh: 0, skipped_time_budget: 0, started: 0, resumed: 0, completed: 0, failed: 0,
  }

  for (const conn of connections ?? []) {
    const workspaceId = conn.workspace_id as string
    if (!conn.selling_partner_id || !conn.refresh_token_encrypted) continue

    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      results[workspaceId] = { status: 'skipped_time_budget' }
      counts.skipped_time_budget++
      continue
    }

    const connection: StockSyncConnection = {
      id: conn.id as string,
      selling_partner_id: conn.selling_partner_id as string,
      marketplace_id: (conn.marketplace_id as string | null) ?? null,
      refresh_token_encrypted: conn.refresh_token_encrypted as string,
    }

    try {
      const res = await syncWorkspace(admin, workspaceId, connection, startedAt)
      results[workspaceId] = res
      counts[res.status]++
    } catch {
      console.error('[cron/stock/sync-amazon-data] workspace sync failed')
      results[workspaceId] = { status: 'failed', reason: 'workspace_sync_threw' }
      counts.failed++
    }
  }

  return NextResponse.json({
    ok: true,
    workspaces_seen: connections?.length ?? 0,
    ...counts,
    elapsed_ms: Date.now() - startedAt,
    results,
  })
}

async function syncWorkspace(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  connection: StockSyncConnection,
  invocationStartedAt: number,
): Promise<WorkspaceResult> {
  const nowIso = new Date().toISOString()

  // Reclaim abandoned in-flight jobs; keep the newest live one to resume.
  const { data: runningJobs, error: runningErr } = await admin
    .from('amazon_sync_jobs')
    .select('id, started_at, metadata')
    .eq('workspace_id', workspaceId)
    .eq('job_type', JOB_TYPE)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
  if (runningErr) return { status: 'failed', reason: 'running_job_query_failed' }

  let liveJobId: string | null = null
  for (const job of runningJobs ?? []) {
    const metadata = (job.metadata ?? {}) as { last_progress_at?: string }
    const lastActivity = new Date(metadata.last_progress_at ?? (job.started_at as string | null) ?? 0).getTime()
    if (Date.now() - lastActivity > STALE_RUNNING_MS) {
      const { error } = await admin
        .from('amazon_sync_jobs')
        .update({ status: 'failed', finished_at: nowIso, error_message: 'reclaimed_stale_running' })
        .eq('id', job.id as string)
      if (error) return { status: 'failed', reason: 'stale_job_reclaim_failed' }
    } else if (!liveJobId) {
      liveJobId = job.id as string
    }
  }

  let resumed = false
  if (liveJobId) {
    resumed = true
  } else {
    const { data: lastCompleted, error: completedErr } = await admin
      .from('amazon_sync_jobs')
      .select('finished_at')
      .eq('workspace_id', workspaceId)
      .eq('job_type', JOB_TYPE)
      .eq('status', 'completed')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (completedErr) return { status: 'failed', reason: 'completed_job_query_failed' }

    const lastMs = lastCompleted?.finished_at ? new Date(lastCompleted.finished_at as string).getTime() : 0
    if (Date.now() - lastMs < REFRESH_INTERVAL_MS) {
      return { status: 'skipped_fresh', reason: 'within_refresh_interval' }
    }

    const started = await startStockSyncJob(admin, { workspaceId, connection, days: LOOKBACK_DAYS })
    if (!started.ok) return { status: 'failed', reason: 'start_failed' }
    liveJobId = started.body.jobId
  }

  // Advance the job one step at a time until it finishes or time runs low.
  let steps = 0
  while (Date.now() - invocationStartedAt < TIME_BUDGET_MS) {
    const outcome = await advanceStockSyncJob(admin, { workspaceId, connection, jobId: liveJobId })
    steps++
    if (!outcome.ok) return { status: 'failed', reason: `advance_http_${outcome.status}`, steps }
    if (outcome.body.status !== 'running') return { status: 'completed', steps }
  }
  return { status: resumed ? 'resumed' : 'started', steps }
}
