import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveJobsAuth } from '@/lib/internal/background-worker-auth'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import {
  listOrders,
  getSolicitationActionsForOrder,
  createProductReviewAndSellerFeedbackSolicitation,
} from '@/lib/amazon/spapi-client'
import { runDailyForward, DEFAULT_ROLLING_OVERLAP_DAYS } from '@/lib/review-requests/daily-run'

export const runtime = 'nodejs'
export const maxDuration = 280

// Same EasyHOME workspace as scripts/review-requests-catchup.ts -- this
// workstream is scoped to Amazon India / EasyHOME only (see
// REVIEW_REQUEST_AUTOMATION_SPEC.md).
const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const DEFAULT_BATCH_SIZE = 300
const DEFAULT_RATE_LIMIT_MS = 1100
const WORKER_ID_SYSTEM = 'nextjs-review-requests-cron'
const WORKER_ID_SESSION = 'nextjs-review-requests-manual'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseIntEnv(name: string, defaultVal: number): number {
  const raw = process.env[name]
  if (!raw) return defaultVal
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultVal
}

/**
 * POST /api/review-requests/jobs/run
 *
 * Protected daily-forward worker for the Review Request Automation
 * workstream. Auth via resolveJobsAuth() (same pattern as
 * /api/asins/jobs/process-next) -- either the background-worker secret
 * header (cron/system calls) or an authenticated workspace session. Not
 * exposed publicly without one of those.
 *
 * Live sending only ever happens when BOTH REVIEW_REQUESTS_ENABLED=true and
 * REVIEW_REQUESTS_DRY_RUN=false are set on this deployment -- committed
 * defaults keep this route dry-run-only (records eligible_dry_run, never
 * calls createProductReviewAndSellerFeedbackSolicitation). See
 * src/lib/review-requests/daily-run.ts for the full gating logic.
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
  const batchSize = parseIntEnv('REVIEW_REQUESTS_BATCH_SIZE', DEFAULT_BATCH_SIZE)
  const rateLimitMs = parseIntEnv('REVIEW_REQUESTS_RATE_LIMIT_MS', DEFAULT_RATE_LIMIT_MS)
  const liveSendEnabled = process.env.REVIEW_REQUESTS_ENABLED === 'true'
  const dryRun = process.env.REVIEW_REQUESTS_DRY_RUN !== 'false'

  const connection = await loadWorkspaceConnection(admin, workspaceId)
  if (!connection) {
    console.log('[review-requests.jobs.run] No active Amazon connection for this workspace.')
    return NextResponse.json({ ok: false, error: 'No active Amazon connection for this workspace.' })
  }

  const report = await runDailyForward(
    {
      admin,
      listOrdersFn: listOrders,
      getSolicitationFn: getSolicitationActionsForOrder,
      createSolicitationFn: createProductReviewAndSellerFeedbackSolicitation,
      sleepFn: sleep,
      nowFn: () => new Date(),
    },
    {
      workspaceId,
      marketplaceId: connection.marketplaceId ?? marketplaceId,
      accessToken: connection.accessToken,
      overlapDays,
      batchSize,
      rateLimitMs,
      liveSendEnabled,
      dryRun,
      workerId: auth.mode === 'system' ? WORKER_ID_SYSTEM : WORKER_ID_SESSION,
    },
  )

  console.log(JSON.stringify({ route: 'review-requests.jobs.run', mode: auth.mode, ...report }))

  return NextResponse.json({ ok: true, report })
}
