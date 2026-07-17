/**
 * src/lib/review-requests/cron-relay.ts
 *
 * Shared Vercel Cron -> protected worker relay logic for the Review Request
 * Automation cron entry points (daily-ingest, process-eligibility). Both
 * routes need the identical CRON_SECRET bearer check, then an internal call
 * to their own protected POST worker route with the same
 * redirect/content-type/JSON-body verification -- extracted here once
 * rather than duplicated, matching this repo's "reuse before rewrite"
 * standing rule (BRAHMASTRA_MASTER_TRACKER.md sec17).
 *
 * Protects against the exact Vercel Deployment Protection/SSO silent-no-op
 * failure mode documented on the original combined cron route (now split):
 * an internal fetch to a per-deployment VERCEL_URL gets silently redirected
 * to Vercel SSO and treated as a fake HTTP 200 unless explicitly guarded
 * against. APP_BASE_URL must be set explicitly to the public production
 * alias -- never falls back to VERCEL_URL.
 */
import { NextResponse } from 'next/server'
import { isValidCronBearer } from './cron-auth'

const BACKGROUND_WORKER_SECRET_HEADER = 'x-background-worker-secret'
const INTERNAL_CALL_TIMEOUT_MS = 260_000

function getAppBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim()
  return explicit ? explicit.replace(/\/$/, '') : null
}

type InternalCallResult =
  | { ok: true; body: Record<string, unknown> | null }
  | { ok: false; path: string; reason: string }

async function callInternalRoute(
  baseUrl: string,
  path: string,
  secret: string,
  cronName: string,
): Promise<InternalCallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERNAL_CALL_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { [BACKGROUND_WORKER_SECRET_HEADER]: secret },
      signal: controller.signal,
      redirect: 'manual',
    })

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      const reason = `Request to ${path} was redirected instead of reaching the route (likely Vercel Deployment Protection/SSO). Check that APP_BASE_URL points at the public production alias, not a per-deployment URL.`
      console.error(JSON.stringify({ cron: cronName, path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      const reason = `Non-JSON response from ${path} (content-type: "${contentType || 'none'}", status: ${response.status}). Expected this app's own JSON route response.`
      console.error(JSON.stringify({ cron: cronName, path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (body === null) {
      const reason = `Response body from ${path} could not be parsed as JSON (status: ${response.status}).`
      console.error(JSON.stringify({ cron: cronName, path, ok: false, reason }))
      return { ok: false, path, reason }
    }

    if (!response.ok) {
      const reason = `${path} responded with HTTP ${response.status}.`
      console.error(JSON.stringify({ cron: cronName, path, ok: false, reason, body }))
      return { ok: false, path, reason }
    }

    return { ok: true, body }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'request_failed'
    console.error(JSON.stringify({ cron: cronName, path, ok: false, reason }))
    return { ok: false, path, reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Shared GET handler body for a review-requests cron entry point. Checks
 * CRON_SECRET, then relays to `workerPath` using BACKGROUND_WORKER_SECRET.
 * `cronName` is used only for structured log/error labeling.
 */
export async function handleCronRelay(request: Request, workerPath: string, cronName: string): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization')
  if (!isValidCronBearer(authHeader, process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const backgroundWorkerSecret = process.env.BACKGROUND_WORKER_SECRET
  const baseUrl = getAppBaseUrl()

  if (!backgroundWorkerSecret || !baseUrl) {
    const reason = !baseUrl
      ? 'APP_BASE_URL is not configured. Set it to the public production alias (e.g. https://esolz-app.vercel.app) in the Vercel project environment variables — do not rely on VERCEL_URL, which points to a protected per-deployment URL.'
      : 'BACKGROUND_WORKER_SECRET is not configured.'
    console.error(`[${cronName}] ${reason}`)
    return NextResponse.json({ ok: false, error: 'Cron target not configured', reason }, { status: 503 })
  }

  const runResult = await callInternalRoute(baseUrl, workerPath, backgroundWorkerSecret, cronName)
  if (!runResult.ok) {
    return NextResponse.json({
      ok: false,
      error: `${cronName} did not execute correctly.`,
      reason: runResult.reason,
    }, { status: 502 })
  }

  return NextResponse.json({ ok: true, result: runResult.body })
}
