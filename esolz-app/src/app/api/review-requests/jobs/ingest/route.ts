import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveJobsAuth } from '@/lib/internal/background-worker-auth'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import { listOrders } from '@/lib/amazon/spapi-client'
import {
  runOrderIngestion,
  DEFAULT_ROLLING_OVERLAP_DAYS,
  DEFAULT_INGEST_CONCURRENCY,
  DEFAULT_INGESTION_RUNTIME_BUDGET_MS,
} from '@/lib/review-requests/order-ingestion'

export const runtime = 'nodejs'
export const maxDuration = 280

// Same EasyHOME workspace as the eligibility processor and
// scripts/review-requests-catchup.ts -- this workstream is scoped to
// Amazon India / EasyHOME only (see REVIEW_REQUEST_AUTOMATION_SPEC.md).
const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

function parseIntEnv(name: string, defaultVal: number): number {
  const raw = process.env[name]
  if (!raw) return defaultVal
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultVal
}

/**
 * POST /api/review-requests/jobs/ingest
 *
 * Protected order-ingestion worker for the Review Request Automation
 * workstream -- rolling-window Orders API fetch + idempotent upsert only.
 * Auth via resolveJobsAuth() (same pattern as /api/asins/jobs/process-next)
 * -- either the background-worker secret header (cron/system calls) or an
 * authenticated workspace session. Never claims, checks eligibility, or
 * sends -- see /api/review-requests/jobs/process-eligibility for that
 * separate, bounded phase.
 */
export async function POST(request: Request) {
  const auth = await resolveJobsAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const workspaceId = auth.mode === 'session' ? auth.workspaceId : EASYHOME_WORKSPACE_ID
  const marketplaceId = process.env.REVIEW_REQUESTS_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID
  const overlapDays = parseIntEnv('REVIEW_REQUESTS_OVERLAP_DAYS', DEFAULT_ROLLING_OVERLAP_DAYS)
  const concurrency = parseIntEnv('REVIEW_REQUESTS_INGEST_CONCURRENCY', DEFAULT_INGEST_CONCURRENCY)
  const runtimeBudgetMs = parseIntEnv('REVIEW_REQUESTS_INGEST_RUNTIME_BUDGET_MS', DEFAULT_INGESTION_RUNTIME_BUDGET_MS)

  const connection = await loadWorkspaceConnection(admin, workspaceId)
  if (!connection) {
    console.log('[review-requests.jobs.ingest] No active Amazon connection for this workspace.')
    return NextResponse.json({ ok: false, error: 'No active Amazon connection for this workspace.' })
  }

  const report = await runOrderIngestion(
    { admin, listOrdersFn: listOrders, nowFn: () => new Date() },
    {
      workspaceId,
      marketplaceId: connection.marketplaceId ?? marketplaceId,
      accessToken: connection.accessToken,
      overlapDays,
      concurrency,
      runtimeBudgetMs,
    },
  )

  console.log(JSON.stringify({ route: 'review-requests.jobs.ingest', mode: auth.mode, ...report }))

  return NextResponse.json({ ok: true, report })
}
