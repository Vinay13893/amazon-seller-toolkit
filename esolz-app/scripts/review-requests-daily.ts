// scripts/review-requests-daily.ts
//
// CLI wrapper for the daily-forward Review Request Automation workflow
// (src/lib/review-requests/daily-run.ts). Convenience for a manual/local
// run with the exact same core logic the protected route and cron use --
// this script is NOT itself the production entry point (that is
// src/app/api/cron/review-requests/daily-run, wired via vercel.json). See
// BRAHMASTRA_MASTER_TRACKER.md sec18 for the full design.
//
// Safety: identical env-gating to the route -- live sending only happens
// when REVIEW_REQUESTS_ENABLED=true AND REVIEW_REQUESTS_DRY_RUN=false are
// BOTH set. Committed defaults (ENABLED=false, DRY_RUN=true) keep this
// dry-run-only.
//
// Run:
//   npx tsx scripts/review-requests-daily.ts [--workspace-id=<uuid>]

import { pathToFileURL } from 'node:url'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import {
  listOrders,
  getSolicitationActionsForOrder,
  createProductReviewAndSellerFeedbackSolicitation,
} from '@/lib/amazon/spapi-client'
import { runDailyForward, DEFAULT_ROLLING_OVERLAP_DAYS } from '@/lib/review-requests/daily-run'

const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const DEFAULT_BATCH_SIZE = 300
const DEFAULT_RATE_LIMIT_MS = 1100

const args = process.argv.slice(2)
function getStrArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = args.find(a => a.startsWith(prefix))
  const value = found ? found.slice(prefix.length).trim() : ''
  return value.length > 0 ? value : null
}

function parseIntEnv(name: string, defaultVal: number): number {
  const raw = process.env[name]
  if (!raw) return defaultVal
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultVal
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const admin = createAdminClient()
  const workspaceId = getStrArg('workspace-id') ?? EASYHOME_WORKSPACE_ID
  const marketplaceId = process.env.REVIEW_REQUESTS_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID
  const overlapDays = parseIntEnv('REVIEW_REQUESTS_OVERLAP_DAYS', DEFAULT_ROLLING_OVERLAP_DAYS)
  const batchSize = parseIntEnv('REVIEW_REQUESTS_BATCH_SIZE', DEFAULT_BATCH_SIZE)
  const rateLimitMs = parseIntEnv('REVIEW_REQUESTS_RATE_LIMIT_MS', DEFAULT_RATE_LIMIT_MS)
  const liveSendEnabled = process.env.REVIEW_REQUESTS_ENABLED === 'true'
  const dryRun = process.env.REVIEW_REQUESTS_DRY_RUN !== 'false'

  if (liveSendEnabled && !dryRun) {
    console.warn(
      '[review-requests-daily] LIVE SEND IS ACTIVE (REVIEW_REQUESTS_ENABLED=true and ' +
      'REVIEW_REQUESTS_DRY_RUN=false) -- this run WILL POST real review requests to eligible orders.',
    )
  } else {
    console.log('[review-requests-daily] Dry-run mode -- no review requests will be sent.')
  }

  console.log('[review-requests-daily] Starting daily-forward run — workspace:', workspaceId)

  const connection = await loadWorkspaceConnection(admin, workspaceId)
  if (!connection) {
    console.log('[review-requests-daily] No active Amazon connection for this workspace — stopping.')
    process.exit(1)
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
      workerId: 'cli-review-requests-daily',
    },
  )

  console.log(JSON.stringify(report, null, 2))
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main().catch(err => {
    console.error('[review-requests-daily] Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
