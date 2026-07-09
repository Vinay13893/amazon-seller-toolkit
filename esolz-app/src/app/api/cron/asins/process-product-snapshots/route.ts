import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 200

const BACKGROUND_WORKER_SECRET_HEADER = 'x-background-worker-secret'
const INTERNAL_CALL_TIMEOUT_MS = 90_000

/**
 * GET /api/cron/asins/process-product-snapshots
 *
 * Vercel Cron entry point (see vercel.json, schedule: every 2 hours).
 * Replaces the checker-worker productPageOrchestrator loop that previously
 * pinged these same two routes every 3 minutes from Render. Behavior is
 * unchanged: this only enqueues + processes product_page_snapshot jobs via
 * SP-API in the existing routes below. It does not call checker-worker and
 * does not touch Playwright/keyword-rank/pincode/buy-box scraping.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
 * when CRON_SECRET is set on the project. Requests without a valid match are
 * rejected before anything else runs.
 */

function getAppBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const vercelUrl = process.env.VERCEL_URL?.trim()
  if (vercelUrl) return `https://${vercelUrl}`
  return null
}

async function callInternalRoute(
  baseUrl: string,
  path: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERNAL_CALL_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { [BACKGROUND_WORKER_SECRET_HEADER]: secret },
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null

    if (!response.ok) {
      console.warn(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, httpStatus: response.status }))
      return null
    }

    return body
  } catch (error) {
    console.warn(JSON.stringify({
      cron: 'process-product-snapshots',
      path,
      ok: false,
      error: error instanceof Error ? error.message : 'request_failed',
    }))
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const backgroundWorkerSecret = process.env.BACKGROUND_WORKER_SECRET
  const baseUrl = getAppBaseUrl()

  if (!backgroundWorkerSecret || !baseUrl) {
    console.warn('[cron.process-product-snapshots] BACKGROUND_WORKER_SECRET or app base URL is not configured; skipping run.')
    return NextResponse.json({ ok: false, error: 'Cron target not configured' }, { status: 503 })
  }

  const enqueueSummary = await callInternalRoute(baseUrl, '/api/asins/jobs/enqueue', backgroundWorkerSecret)
  const processSummary = await callInternalRoute(baseUrl, '/api/asins/jobs/process-next', backgroundWorkerSecret)

  return NextResponse.json({
    ok: true,
    enqueue: enqueueSummary,
    process: processSummary,
  })
}
