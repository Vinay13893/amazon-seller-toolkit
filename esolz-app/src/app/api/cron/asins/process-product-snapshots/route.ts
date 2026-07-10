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
 *
 * APP_BASE_URL must be set explicitly (e.g. https://esolz-app.vercel.app).
 * This function used to fall back to `https://${VERCEL_URL}` when
 * APP_BASE_URL was unset. VERCEL_URL is the unique *per-deployment*
 * hostname, which sits behind Vercel's Deployment Protection (SSO) wall.
 * A self-call to that hostname gets redirected to vercel.com/sso-api
 * instead of reaching enqueue/process-next, and because that redirect
 * previously wasn't distinguished from a real response, the old code
 * treated it as success and returned {ok:true} with nothing actually
 * having run — a silent no-op that looked healthy in every cron log for
 * 2+ days (root cause of the 2026-07-09 asin_snapshots staleness
 * incident: throughput dropped from ~90/hour to zero the moment the old
 * Render orchestrator loop was disabled and this cron took over). The
 * fallback is removed below; APP_BASE_URL missing is now a loud,
 * correctly-labeled configuration error instead of a silent skip, and
 * callInternalRoute() below independently verifies every response is
 * really JSON from our own route before trusting it.
 */

function getAppBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim()
  return explicit ? explicit.replace(/\/$/, '') : null
}

type InternalCallResult =
  | { ok: true; body: Record<string, unknown> | null }
  | { ok: false; path: string; reason: string }

/**
 * Calls an internal route and verifies the response actually came from our
 * own app code, not from an intermediary (Vercel SSO, a proxy/error page,
 * etc.). A response is only trusted when it is not a redirect, its
 * content-type is JSON, and its body parses successfully — anything else
 * fails loudly (returned to the caller, logged with console.error) instead
 * of being silently treated as a no-op success.
 */
async function callInternalRoute(
  baseUrl: string,
  path: string,
  secret: string,
): Promise<InternalCallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERNAL_CALL_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { [BACKGROUND_WORKER_SECRET_HEADER]: secret },
      signal: controller.signal,
      // Surface redirects instead of silently following them. A redirect
      // here means something other than our route handled the request —
      // most likely Vercel's Deployment Protection/SSO wall, which is
      // exactly the failure mode this fix targets.
      redirect: 'manual',
    })

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      const reason = `Request to ${path} was redirected instead of reaching the route (likely Vercel Deployment Protection/SSO). Check that APP_BASE_URL points at the public production alias, not a per-deployment URL.`
      console.error(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      const reason = `Non-JSON response from ${path} (content-type: "${contentType || 'none'}", status: ${response.status}). Expected this app's own JSON route response.`
      console.error(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (body === null) {
      const reason = `Response body from ${path} could not be parsed as JSON (status: ${response.status}).`
      console.error(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    if (!response.ok) {
      const reason = `${path} responded with HTTP ${response.status}.`
      console.error(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, reason, body }))
      return { ok: false, path, reason }
    }

    return { ok: true, body }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'request_failed'
    console.error(JSON.stringify({ cron: 'process-product-snapshots', path, ok: false, reason }))
    return { ok: false, path, reason }
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
    const reason = !baseUrl
      ? 'APP_BASE_URL is not configured. Set it to the public production alias (e.g. https://esolz-app.vercel.app) in the Vercel project environment variables — do not rely on VERCEL_URL, which points to a protected per-deployment URL.'
      : 'BACKGROUND_WORKER_SECRET is not configured.'
    console.error(`[cron.process-product-snapshots] ${reason}`)
    return NextResponse.json({ ok: false, error: 'Cron target not configured', reason }, { status: 503 })
  }

  const enqueueResult = await callInternalRoute(baseUrl, '/api/asins/jobs/enqueue', backgroundWorkerSecret)
  if (!enqueueResult.ok) {
    return NextResponse.json({
      ok: false,
      error: 'Enqueue step did not execute correctly.',
      failedStep: 'enqueue',
      reason: enqueueResult.reason,
    }, { status: 502 })
  }

  const processResult = await callInternalRoute(baseUrl, '/api/asins/jobs/process-next', backgroundWorkerSecret)
  if (!processResult.ok) {
    return NextResponse.json({
      ok: false,
      error: 'Process-next step did not execute correctly.',
      failedStep: 'process-next',
      reason: processResult.reason,
      enqueue: enqueueResult.body,
    }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    enqueue: enqueueResult.body,
    process: processResult.body,
  })
}
