/**
 * checker-worker-client.ts
 *
 * HTTP client for the external checker worker service.
 *
 * Architecture rules:
 *  - In production, Python child_process MUST NOT be spawned. This client is
 *    the only way to run checkers in production.
 *  - If CHECKER_WORKER_URL is not configured, each run*Check() function throws
 *    CheckerWorkerUnavailableError so the route can save a safe snapshot.
 *  - In local development, Python adapters may still be used when CHECKER_WORKER_URL
 *    is absent.  Routes should check isWorkerConfigured() before deciding which path
 *    to take.
 *
 * Environment variables:
 *   CHECKER_WORKER_URL     Base URL of the checker worker service (no trailing slash).
 *                          e.g. https://my-checker-worker.example.com
 *   CHECKER_WORKER_SECRET  Optional shared secret sent as x-checker-secret header.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

/** Returns true when CHECKER_WORKER_URL is set in the environment. */
export function isWorkerConfigured(): boolean {
  return !!(process.env.CHECKER_WORKER_URL?.trim())
}

const WORKER_TIMEOUT_MS = 90_000  // 90 s

// ─── Error type ──────────────────────────────────────────────────────────────

/**
 * Thrown when the checker worker is not configured (no CHECKER_WORKER_URL)
 * or when the HTTP call to the worker fails.
 *
 * IMPORTANT: This error represents a system/infrastructure issue, NOT a
 * product issue. Callers must save a checker_unavailable snapshot and MUST NOT
 * report the product as unavailable, lost, or failing.
 */
export class CheckerWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckerWorkerUnavailableError'
  }
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

async function workerPost<T>(path: string, payload: unknown): Promise<T> {
  const baseUrl = process.env.CHECKER_WORKER_URL?.replace(/\/$/, '')
  if (!baseUrl) {
    throw new CheckerWorkerUnavailableError(
      'CHECKER_WORKER_URL is not configured. Checker worker is unavailable.',
    )
  }

  const secret = process.env.CHECKER_WORKER_SECRET ?? ''
  const url    = `${baseUrl}${path}`

  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-checker-secret': secret } : {}),
      },
      body:   JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new CheckerWorkerUnavailableError(
        `Checker worker returned HTTP ${res.status}`,
      )
      // body used only for debug logging below — never surfaced to the frontend
      void body
    }

    return res.json() as Promise<T>
  } catch (err) {
    if (err instanceof CheckerWorkerUnavailableError) throw err
    const msg = err instanceof Error ? err.message : 'Checker worker request failed'
    throw new CheckerWorkerUnavailableError(msg)
  } finally {
    clearTimeout(timer)
  }
}

// ─── Payload / Response types ─────────────────────────────────────────────────

export interface KeywordRankPayload {
  workspace_id:       string
  tracked_keyword_id: string
  asin:               string
  keyword:            string
  marketplace:        string
  marketplace_id?:    string
}

/**
 * Worker response for POST /keyword-rank.
 * `status` values: 'success' | 'checker_unavailable' | 'failed'
 */
export interface KeywordRankResponse {
  ok:               boolean
  found:            boolean
  organic_rank:     number | null
  sponsored_rank:   number | null
  page:             number | null
  position_on_page: number | null
  status:           string
  error_message:    string | null
}

export interface PincodePayload {
  workspace_id:   string
  tracked_asin_id: string
  asin:           string
  marketplace:    string
  pincode:        string
}

/**
 * Worker response for POST /pincode-availability.
 * `status` values: 'success' | 'checker_unavailable' | 'failed'
 * `available` is null when status !== 'success'.
 */
export interface PincodeResponse {
  ok:               boolean
  available:        boolean | null
  delivery_promise: string | null
  price:            number | null
  seller:           string | null
  status:           string
  error_message:    string | null
}

export interface BuyBoxPayload {
  workspace_id:    string
  tracked_asin_id: string
  asin:            string
  marketplace:     string
}

/**
 * Worker response for POST /buybox-check.
 * `status` values: 'success' | 'checker_unavailable' | 'failed'
 * `buybox_won` is null when status !== 'success'.
 */
export interface BuyBoxResponse {
  ok:            boolean
  buybox_won:    boolean | null
  buybox_owner:  string | null
  price:         number | null
  status:        string
  error_message: string | null
}

export interface BsrPayload {
  workspace_id:    string
  tracked_asin_id: string
  asin:            string
  marketplace:     string
}

/**
 * Worker response for POST /bsr-check.
 * `status` values: 'success' | 'checker_unavailable' | 'failed'
 * Numeric fields are null when status !== 'success'.
 */
export interface BsrResponse {
  ok:            boolean
  bsr:           number | null
  category:      string | null
  price:         number | null
  rating:        number | null
  review_count:  number | null
  status:        string
  error_message: string | null
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a keyword rank check via the external checker worker.
 * Throws CheckerWorkerUnavailableError if worker is not configured or unreachable.
 */
export async function runKeywordRankCheck(payload: KeywordRankPayload): Promise<KeywordRankResponse> {
  return workerPost<KeywordRankResponse>('/keyword-rank', payload)
}

/**
 * Run a pincode availability check via the external checker worker.
 * Throws CheckerWorkerUnavailableError if worker is not configured or unreachable.
 */
export async function runPincodeCheck(payload: PincodePayload): Promise<PincodeResponse> {
  return workerPost<PincodeResponse>('/pincode-availability', payload)
}

/**
 * Run a buy box check via the external checker worker.
 * Throws CheckerWorkerUnavailableError if worker is not configured or unreachable.
 */
export async function runBuyBoxFallbackCheck(payload: BuyBoxPayload): Promise<BuyBoxResponse> {
  return workerPost<BuyBoxResponse>('/buybox-check', payload)
}

/**
 * Run a BSR/product check via the external checker worker.
 * Throws CheckerWorkerUnavailableError if worker is not configured or unreachable.
 */
export async function runBsrFallbackCheck(payload: BsrPayload): Promise<BsrResponse> {
  return workerPost<BsrResponse>('/bsr-check', payload)
}
