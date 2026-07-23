/**
 * SKU Performance P1-B — request validation and bounds.
 *
 * Deliberately its own small module, not a shared import from
 * `pincode-monitoring/validation.ts` — the two features stay decoupled
 * (mirrors this codebase's existing convention of a per-feature validation
 * module, e.g. pincode-monitoring's own copy rather than a shared one).
 *
 * Fix 5 (P1-B correction round): limit/offset used to be parsed with
 * `Number.parseInt` and silently clamped/defaulted on garbage input
 * (`"10abc"` parsed as 10, `"not-a-number"` silently fell back to the
 * default). That let a caller's typo through as a *different*, unnoticed
 * request instead of a 400. Parsing here is now strict whole-string only —
 * anything that doesn't fully match a plain optionally-signed integer is
 * rejected outright, not coerced. Boolean flags are equally strict: only
 * the literal strings `true`/`false`/`1`/`0` are accepted; every other
 * value (including empty string or a typo like `"tru"`) is rejected rather
 * than silently treated as false.
 */

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500
export const MAX_OFFSET = 1_000_000
export const MAX_FILTER_LEN = 200
export const MAX_MARKETPLACE_LEN = 40
export const MAX_SKU_LEN = 200
export const MAX_DAILY_RANGE_DAYS = 400
export const MAX_SUMMARY_RANGE_DAYS = 400

export const VALID_SORTS = [
  'attention_desc', 'sales_desc', 'sales_asc', 'spend_desc', 'spend_asc',
  'tacos_desc', 'tacos_asc', 'sku_asc',
] as const
export type SortValue = (typeof VALID_SORTS)[number]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STRICT_INT_RE = /^-?\d+$/

export function isValidMarketplaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MARKETPLACE_LEN
}

/** Format AND calendar validity (rejects e.g. 2026-02-30) — a regex match alone is not enough. */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function isValidSort(value: unknown): value is SortValue {
  return typeof value === 'string' && (VALID_SORTS as readonly string[]).includes(value)
}

export function isValidFilterString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILTER_LEN
}

export function isValidSkuString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SKU_LEN
}

/**
 * Strict whole-string integer parse: the ENTIRE trimmed string must be an
 * optionally-signed run of digits — `"10abc"`, `"5xyz"`, `"3.5"`, `"1e5"`,
 * `" 5"`, and `""` all return null instead of a best-effort partial parse.
 */
export function parseStrictInt(raw: string): number | null {
  if (!STRICT_INT_RE.test(raw)) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export type LimitValidation = { ok: true; value: number } | { ok: false }

/** Absent -> DEFAULT_LIMIT. Present but not a strict integer in [1, MAX_LIMIT] -> rejected (never silently clamped or defaulted). */
export function validateLimit(raw: string | null): LimitValidation {
  if (raw === null) return { ok: true, value: DEFAULT_LIMIT }
  const parsed = parseStrictInt(raw)
  if (parsed === null || parsed < 1 || parsed > MAX_LIMIT) return { ok: false }
  return { ok: true, value: parsed }
}

export type OffsetValidation = { ok: true; value: number } | { ok: false }

/** Absent -> 0. Present but not a strict integer in [0, MAX_OFFSET] -> rejected (never silently clamped or defaulted). */
export function validateOffset(raw: string | null): OffsetValidation {
  if (raw === null) return { ok: true, value: 0 }
  const parsed = parseStrictInt(raw)
  if (parsed === null || parsed < 0 || parsed > MAX_OFFSET) return { ok: false }
  return { ok: true, value: parsed }
}

/** Optional query param → trimmed non-empty string, or null (never an empty-string filter). */
export function optionalFilter(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export type BooleanFlagValidation = { ok: true; value: boolean } | { ok: false }

/** Absent -> false. Only the literal strings true/false/1/0 are accepted; anything else (including "") is rejected, never silently treated as false. */
export function validateBooleanFlag(raw: string | null): BooleanFlagValidation {
  if (raw === null) return { ok: true, value: false }
  if (raw === 'true' || raw === '1') return { ok: true, value: true }
  if (raw === 'false' || raw === '0') return { ok: true, value: false }
  return { ok: false }
}

/**
 * Follow-up correction: the number of INCLUSIVE calendar dates spanned by
 * [dateFrom, dateTo] — both endpoints count as a full day. A plain
 * `dateTo - dateFrom` millisecond subtraction gives the day DIFFERENCE, one
 * fewer than the actual number of calendar dates in range, which let a
 * MAX_*_RANGE_DAYS=400 ceiling silently accept 401 inclusive dates.
 */
export function inclusiveDayCount(dateFrom: string, dateTo: string): number {
  return (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (24 * 60 * 60 * 1000) + 1
}

/** True when [dateFrom, dateTo] spans at most maxInclusiveDays calendar dates (both endpoints inclusive). */
export function isRangeWithinInclusiveDays(dateFrom: string, dateTo: string, maxInclusiveDays: number): boolean {
  return inclusiveDayCount(dateFrom, dateTo) <= maxInclusiveDays
}
