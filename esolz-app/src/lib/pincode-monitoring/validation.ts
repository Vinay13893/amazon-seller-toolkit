/**
 * Pincode Monitoring P0-B — hand-rolled request validation.
 *
 * This codebase has no Zod dependency anywhere (confirmed by grep across
 * `esolz-app/src` and `package.json` before writing this file) — the
 * existing convention (`keywords/products/route.ts`,
 * `scraping/pincode-availability/jobs/route.ts`) is small, local,
 * type-narrowing functions operating on `unknown`. This module follows that
 * convention rather than introducing a new validation dependency.
 *
 * Every regex here matches the exact CHECK constraint / regex already
 * enforced inside the P0-A migrations (060-063) — duplicated deliberately so
 * a malformed request is rejected with a clean 400 before ever reaching a
 * service-role RPC call, not left to surface as a raw Postgres error.
 */

export const ASIN_RE = /^[A-Z0-9]{10}$/
export const PINCODE_RE = /^[1-9][0-9]{5}$/ // 6-digit Indian pincode, first digit 1-9 (matches workspace_default_pincodes_pincode_format_chk)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_MARKETPLACE_LEN = 40 // matches every RPC's own MAX_MARKETPLACE_LEN ceiling (063 migration)

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isValidAsin(value: unknown): value is string {
  return typeof value === 'string' && ASIN_RE.test(value.toUpperCase())
}

export function isValidPincode(value: unknown): value is string {
  return typeof value === 'string' && PINCODE_RE.test(value)
}

export function isValidMarketplaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MARKETPLACE_LEN
}

export function normalizeAsin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return ASIN_RE.test(normalized) ? normalized : null
}

export function normalizePincodeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const pincodes = value.map(item => (typeof item === 'string' ? item.trim() : ''))
  if (pincodes.some(p => !PINCODE_RE.test(p))) return null
  return Array.from(new Set(pincodes))
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value }
}

export function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

/** Parses a JSON request body, returning null on a missing/malformed body rather than throwing — every route must handle the null case itself with its own 400 response. */
export async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
