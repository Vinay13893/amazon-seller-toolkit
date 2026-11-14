/** Preserve retry guidance without logging response bodies or credentials. */
export class AdsApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs: number | null) {
    super(message)
    this.name = 'AdsApiError'
  }
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value?.trim()) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null
}

/** Never retry earlier than Amazon requests. Leave long cooldowns for the next run. */
export function adsRetryDelay(error: unknown, fallbackMs: number): number | null {
  const delay = error instanceof AdsApiError ? Math.max(fallbackMs, error.retryAfterMs ?? 0) : fallbackMs
  return delay <= 300_000 ? delay : null
}
