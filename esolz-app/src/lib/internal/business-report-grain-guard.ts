/**
 * Business Report sales-grain fix — the single invariant this entire fix
 * exists to enforce:
 *
 *   A row stored as one SKU-day may only come from an Amazon report
 *   request where dateFrom === dateTo === the stored report_date
 *   (marketplace-local). Never store a multi-day by-SKU payload as daily.
 *   Never split/estimate/infer a range total across days. The system must
 *   FAIL CLOSED (reject, not silently distribute) if this is violated.
 *
 * Root cause this replaces: scripts/sync-business-reports.ts used to do
 *   `const skuReportDate = dateStart === dateEnd ? dateStart : dateEnd`
 * — a silent fallback that stored a multi-day range TOTAL under the last
 * day's date whenever dateStart !== dateEnd. `resolveSkuReportDate` below
 * replaces that ternary with a throw, so a caller that still asks for a
 * multi-day SKU report cannot silently mis-attribute it.
 */

export class SkuGrainViolationError extends Error {
  readonly dateFrom: string
  readonly dateTo: string
  constructor(dateFrom: string, dateTo: string) {
    super(
      `Refusing to store salesAndTrafficByAsin rows as a single day: requested range is ` +
        `${dateFrom}..${dateTo} (${dateFrom === dateTo ? 1 : 'more than 1'} day(s)). Amazon's ` +
        `by-ASIN/by-SKU section has no per-day breakdown of its own — it is a TOTAL for the ` +
        `entire requested range. A multi-day request must never be persisted as one day's SKU ` +
        `figures. Request SKU-level data one calendar day at a time instead.`,
    )
    this.name = 'SkuGrainViolationError'
    this.dateFrom = dateFrom
    this.dateTo = dateTo
  }
}

/**
 * The ONLY correct way to derive the report_date for a parsed
 * salesAndTrafficByAsin/SKU row set: the request's dateFrom, but ONLY when
 * dateFrom === dateTo. Any other input throws SkuGrainViolationError —
 * fail closed, never fall back to dateTo (the old, wrong behavior) or any
 * other guess.
 */
export function resolveSkuReportDate(dateFrom: string, dateTo: string): string {
  if (dateFrom !== dateTo) throw new SkuGrainViolationError(dateFrom, dateTo)
  return dateFrom
}

/** Non-throwing form for call sites that need to branch (e.g. the repair script's structured per-date report) instead of catching. */
export function isSingleDayGrain(dateFrom: string, dateTo: string): boolean {
  return dateFrom === dateTo
}
