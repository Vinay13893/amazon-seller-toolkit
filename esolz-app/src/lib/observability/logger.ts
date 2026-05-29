/**
 * Lightweight observability logger.
 *
 * SECURITY rules (enforced in redactMeta):
 * - Never logs actual values of keys containing:
 *   token, secret, password, key, authorization, cookie
 * - Case-insensitive matching for all redaction rules.
 * - Uses console only — no external sink required.
 */

const REDACT_KEYS = /token|secret|password|key|authorization|cookie/i

/** Replace sensitive values in a metadata object with [REDACTED]. */
function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = '[REDACTED]'
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactMeta(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  try {
    return ' ' + JSON.stringify(redactMeta(meta))
  } catch {
    return ' [unserializable metadata]'
  }
}

export function logInfo(scope: string, message: string, meta?: Record<string, unknown>): void {
  console.log(`[INFO][${scope}] ${message}${formatMeta(meta)}`)
}

export function logWarn(scope: string, message: string, meta?: Record<string, unknown>): void {
  console.warn(`[WARN][${scope}] ${message}${formatMeta(meta)}`)
}

export function logError(
  scope: string,
  message: string,
  error?: unknown,
  meta?: Record<string, unknown>,
): void {
  const errMsg = error instanceof Error ? error.message : String(error ?? '')
  console.error(`[ERROR][${scope}] ${message}${errMsg ? ' — ' + errMsg : ''}${formatMeta(meta)}`)
}
