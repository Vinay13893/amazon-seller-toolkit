import { NextRequest, NextResponse } from 'next/server'
import { handleCronRelay } from '@/lib/review-requests/cron-relay'

export const runtime = 'nodejs'
export const maxDuration = 280

/**
 * GET /api/cron/review-requests/daily-ingest
 *
 * Vercel Cron entry point (see vercel.json, "0 3 * * *" -- once daily) for
 * the Amazon India EasyHOME Review Request Automation order-ingestion phase
 * only (rolling 3-day Orders API fetch + idempotent upsert). Never claims,
 * checks eligibility, or sends -- see
 * /api/cron/review-requests/process-eligibility for that separate,
 * bounded, every-4-hours phase. Split from the former combined
 * daily-run cron after the 2026-07-17 production timeout finding (see
 * BRAHMASTRA_MASTER_TRACKER.md sec18).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleCronRelay(request, '/api/review-requests/jobs/ingest', 'review-requests-daily-ingest')
}
