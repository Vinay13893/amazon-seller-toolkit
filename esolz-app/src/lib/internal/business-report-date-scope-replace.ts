/**
 * Business Report sales-grain fix — safe date-scope replacement (spec
 * Phase 5).
 *
 * A plain upsert (insert-if-missing, update-if-present) is not enough for
 * `internal_business_report_sku_sales_traffic`: a corrected single-day
 * report can legitimately omit a SKU that had zero/no activity that day
 * (Amazon's by-SKU section only lists SKUs with activity), and a stale
 * row left over from the OLD, inflated multi-day-total ingestion for that
 * same (workspace, marketplace, report_date, sku) would silently survive
 * a naive upsert forever, because nothing in the new payload ever touches
 * it.
 *
 * The scope this module diffs within is exactly
 * (workspace_id, marketplace_id, report_date, source) — the same columns
 * already in the table's unique index (migration 053), so no schema
 * change is needed to express or enforce this scope; it is purely an
 * application-level diff over rows already fetched for that scope.
 *
 * This module only COMPUTES the diff (insert/update/delete-id sets). The
 * caller is responsible for actually writing it in a safe order (insert +
 * update before delete — see scripts/sync-business-reports.ts and
 * scripts/repair-business-report-sku-daily.ts) so that a mid-batch write
 * failure never loses a row that isn't yet superseded by its replacement.
 */

export type ExistingScopedRow = { id: string; key: string }

export type DateScopeReplacementPlan<T> = {
  toInsert: T[]
  toUpdate: Array<T & { id: string }>
  /** ids of existing rows whose key is NOT present in the new payload — stale, must be deleted for the scope to be a true replacement, not a merge. */
  toDeleteIds: string[]
}

/**
 * `keyOf` must return the same identity key used to build the unique index
 * (workspace/marketplace/report_date are already fixed for the whole call
 * — only the intra-day identity, e.g. sku_norm/child_asin/parent_asin,
 * needs to be part of `key` here).
 */
export function computeDateScopeReplacement<T>(
  existingRows: ExistingScopedRow[],
  newRows: T[],
  keyOf: (row: T) => string,
): DateScopeReplacementPlan<T> {
  const existingIdByKey = new Map<string, string>()
  for (const row of existingRows) existingIdByKey.set(row.key, row.id)

  const seenKeys = new Set<string>()
  const toInsert: T[] = []
  const toUpdate: Array<T & { id: string }> = []

  for (const row of newRows) {
    const key = keyOf(row)
    seenKeys.add(key)
    const existingId = existingIdByKey.get(key)
    if (existingId) toUpdate.push({ ...row, id: existingId })
    else toInsert.push(row)
  }

  const toDeleteIds: string[] = []
  for (const row of existingRows) {
    if (!seenKeys.has(row.key)) toDeleteIds.push(row.id)
  }

  return { toInsert, toUpdate, toDeleteIds }
}

/**
 * The exact intra-day identity key for `internal_business_report_sku_sales_traffic`
 * — mirrors the coalesce()-based expression in the table's unique index
 * (migration 053: `coalesce(sku_norm,''), coalesce(child_asin,''), coalesce(parent_asin,'')`)
 * exactly, so the application-level diff can never disagree with the
 * database's own uniqueness rule about what counts as "the same row."
 */
export function skuScopeKey(row: { sku_norm: string | null; child_asin: string | null; parent_asin: string | null }): string {
  return `${row.sku_norm ?? ''}|${row.child_asin ?? ''}|${row.parent_asin ?? ''}`
}
