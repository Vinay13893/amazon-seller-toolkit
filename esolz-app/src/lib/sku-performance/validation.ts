/**
 * SKU Performance P1-B — request validation and bounds.
 *
 * Deliberately its own small module, not a shared import from
 * `pincode-monitoring/validation.ts` — the two features stay decoupled
 * (mirrors this codebase's existing convention of a per-feature validation
 * module, e.g. pincode-monitoring's own copy rather than a shared one).
 */

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500
export const MAX_OFFSET = 1_000_000
export const MAX_FILTER_LEN = 200
export const MAX_MARKETPLACE_LEN = 40
export const MAX_SKU_LEN = 200
export const MAX_DAILY_RANGE_DAYS = 400

export const VALID_SORTS = [
  'attention_desc', 'sales_desc', 'sales_asc', 'spend_desc', 'spend_asc',
  'tacos_desc', 'tacos_asc', 'sku_asc',
] as const
export type SortValue = (typeof VALID_SORTS)[number]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

export function clampLimit(rawLimit: string | null): number {
  const parsed = Number.parseInt(rawLimit ?? '', 10)
  return Math.min(MAX_LIMIT, Math.max(1, parsed || DEFAULT_LIMIT))
}

export function clampOffset(rawOffset: string | null): number {
  const parsed = Number.parseInt(rawOffset ?? '0', 10)
  return Math.min(MAX_OFFSET, Math.max(0, parsed || 0))
}

/** Optional query param → trimmed non-empty string, or null (never an empty-string filter). */
export function optionalFilter(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parseBooleanFlag(value: string | null): boolean {
  return value === 'true' || value === '1'
}
