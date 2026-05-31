import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

interface CheckerDebugResponse {
  ok: boolean
  node_env: string
  worker_url_present: boolean
  worker_secret_present: boolean
  worker_url_host: string | null
  worker_health_status: number | null
  worker_health_ok: boolean | null
  keyword_test_status: number | null
  keyword_test_body_status: string | null
  keyword_test_error: string | null
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Unknown request error'
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const nodeEnv = process.env.NODE_ENV ?? 'unknown'
  const workerUrl = process.env.CHECKER_WORKER_URL?.trim() ?? ''
  const workerSecret = process.env.CHECKER_WORKER_SECRET ?? ''

  const workerUrlPresent = workerUrl.length > 0
  const workerSecretPresent = workerSecret.length > 0
  const workerUrlHost = (() => {
    if (!workerUrlPresent) return null
    try {
      return new URL(workerUrl).host
    } catch {
      return null
    }
  })()

  const result: CheckerDebugResponse = {
    ok: false,
    node_env: nodeEnv,
    worker_url_present: workerUrlPresent,
    worker_secret_present: workerSecretPresent,
    worker_url_host: workerUrlHost,
    worker_health_status: null,
    worker_health_ok: null,
    keyword_test_status: null,
    keyword_test_body_status: null,
    keyword_test_error: null,
  }

  if (!workerUrlPresent) {
    return NextResponse.json(result)
  }

  try {
    const healthRes = await fetchWithTimeout(`${workerUrl.replace(/\/$/, '')}/health`, {
      method: 'GET',
    }, 15_000)

    result.worker_health_status = healthRes.status
    result.worker_health_ok = healthRes.ok
  } catch (err) {
    result.keyword_test_error = sanitizeErrorMessage(err)
    return NextResponse.json(result)
  }

  try {
    const keywordRes = await fetchWithTimeout(`${workerUrl.replace(/\/$/, '')}/keyword-rank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(workerSecretPresent ? { 'x-checker-secret': workerSecret } : {}),
      },
      body: JSON.stringify({
        workspace_id: 'debug',
        tracked_keyword_id: 'debug',
        asin: 'B09D9Q1B26',
        keyword: 'baking paper roll',
        marketplace: 'amazon.in',
        marketplace_id: 'A21TJRUUN4KGV',
      }),
    }, 30_000)

    result.keyword_test_status = keywordRes.status

    const body = await keywordRes.json().catch(() => null) as { status?: unknown; error_message?: unknown } | null
    if (body && typeof body.status === 'string') {
      result.keyword_test_body_status = body.status
    }

    if (!keywordRes.ok) {
      result.keyword_test_error = body && typeof body.error_message === 'string'
        ? body.error_message
        : `Worker keyword test returned HTTP ${keywordRes.status}`
    }
  } catch (err) {
    result.keyword_test_error = sanitizeErrorMessage(err)
  }

  result.ok = Boolean(
    result.worker_url_present
      && result.worker_secret_present
      && result.worker_health_ok
      && result.keyword_test_status
      && result.keyword_test_status >= 200
      && result.keyword_test_status < 300,
  )

  return NextResponse.json(result)
}
