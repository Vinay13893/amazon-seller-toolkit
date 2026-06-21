// Minimal orchestrator: this worker does not hold Amazon OAuth/SP-API
// credentials (those live only in the Next.js app). It only pings the
// app's secured internal endpoints on an interval and logs aggregate
// counts — it never calls Amazon APIs or stores product data itself.

const APP_BASE_URL = process.env.APP_BASE_URL
const BACKGROUND_WORKER_SECRET = process.env.BACKGROUND_WORKER_SECRET
const CYCLE_INTERVAL_MS = 3 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

function logCycle(step: 'enqueue' | 'process', details: Record<string, unknown>): void {
  console.log(JSON.stringify({
    orchestrator: 'product-page-snapshot',
    step,
    ...details,
  }))
}

async function callAppEndpoint(path: string): Promise<Record<string, unknown> | null> {
  if (!APP_BASE_URL || !BACKGROUND_WORKER_SECRET) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'x-background-worker-secret': BACKGROUND_WORKER_SECRET },
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null

    if (!response.ok) {
      console.warn(JSON.stringify({ orchestrator: 'product-page-snapshot', path, ok: false, httpStatus: response.status }))
      return null
    }

    return body
  } catch (error) {
    console.warn(JSON.stringify({
      orchestrator: 'product-page-snapshot',
      path,
      ok: false,
      error: error instanceof Error ? error.message : 'request_failed',
    }))
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function runProductPageSnapshotCycle(): Promise<void> {
  const enqueueSummary = await callAppEndpoint('/api/asins/jobs/enqueue')
  if (enqueueSummary) logCycle('enqueue', enqueueSummary)

  const processSummary = await callAppEndpoint('/api/asins/jobs/process-next')
  if (processSummary) logCycle('process', processSummary)
}

export function startProductPageSnapshotOrchestrator(): void {
  if (!APP_BASE_URL || !BACKGROUND_WORKER_SECRET) {
    console.warn(
      '[product-page-orchestrator] APP_BASE_URL or BACKGROUND_WORKER_SECRET is not configured; automation is disabled.',
    )
    return
  }

  console.log(`[product-page-orchestrator] starting, interval_ms=${CYCLE_INTERVAL_MS}`)
  void runProductPageSnapshotCycle()
  setInterval(() => { void runProductPageSnapshotCycle() }, CYCLE_INTERVAL_MS)
}
