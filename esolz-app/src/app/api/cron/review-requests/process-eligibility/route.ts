import { NextRequest, NextResponse } from 'next/server'
import { handleCronRelay } from '@/lib/review-requests/cron-relay'

export const runtime = 'nodejs'
export const maxDuration = 280

/**
 * GET /api/cron/review-requests/process-eligibility
 *
 * Vercel Cron entry point (see vercel.json, "0 * / 4 * * *" -- every 4
 * hours) for the Amazon India EasyHOME Review Request Automation bounded
 * eligibility-check-and-optionally-send phase. Reclaims any stale
 * `checking` claim first, then processes up to REVIEW_REQUESTS_BATCH_SIZE
 * due candidates within an internal runtime budget
 * (REVIEW_REQUESTS_RUNTIME_BUDGET_MS), stopping gracefully and returning a
 * partial-run summary rather than depending on Vercel's platform timeout.
 * Split from the former combined daily-run cron after the 2026-07-17
 * production timeout finding (see BRAHMASTRA_MASTER_TRACKER.md sec18).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleCronRelay(request, '/api/review-requests/jobs/process-eligibility', 'review-requests-process-eligibility')
}
