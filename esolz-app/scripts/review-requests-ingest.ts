// scripts/review-requests-ingest.ts
//
// CLI wrapper for the order-ingestion phase of the Review Request
// Automation workflow (src/lib/review-requests/order-ingestion.ts).
// Convenience for a manual/local run with the exact same core logic the
// protected route and cron use -- this script is NOT itself the production
// entry point (that is src/app/api/cron/review-requests/daily-ingest,
// wired via vercel.json). See BRAHMASTRA_MASTER_TRACKER.md sec18 for the
// full design.
//
// This phase never claims, checks eligibility, or sends -- see
// scripts/review-requests-process-eligibility.ts for that separate phase.
//
// Run:
//   npx tsx scripts/review-requests-ingest.ts [--workspace-id=<uuid>]

import { pathToFileURL } from 'node:url'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadWorkspaceConnection } from '@/lib/amazon/connection'
import { listOrders } from '@/lib/amazon/spapi-client'
import { runOrderIngestion, DEFAULT_ROLLING_OVERLAP_DAYS } from '@/lib/review-requests/order-ingestion'

const EASYHOME_WORKSPACE_ID = '55a321c9-7729-4662-a494-9f1f1aa86846'
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

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

async function main() {
  const admin = createAdminClient()
  const workspaceId = getStrArg('workspace-id') ?? EASYHOME_WORKSPACE_ID
  const marketplaceId = process.env.REVIEW_REQUESTS_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID
  const overlapDays = parseIntEnv('REVIEW_REQUESTS_OVERLAP_DAYS', DEFAULT_ROLLING_OVERLAP_DAYS)

  console.log('[review-requests-ingest] Starting order-ingestion run — workspace:', workspaceId)

  const connection = await loadWorkspaceConnection(admin, workspaceId)
  if (!connection) {
    console.log('[review-requests-ingest] No active Amazon connection for this workspace — stopping.')
    process.exit(1)
  }

  const report = await runOrderIngestion(
    { admin, listOrdersFn: listOrders, nowFn: () => new Date() },
    {
      workspaceId,
      marketplaceId: connection.marketplaceId ?? marketplaceId,
      accessToken: connection.accessToken,
      overlapDays,
    },
  )

  console.log(JSON.stringify(report, null, 2))
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main().catch(err => {
    console.error('[review-requests-ingest] Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
