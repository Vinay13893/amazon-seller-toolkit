/**
 * Business Report sales-grain fix — marketplace-local (never server-UTC,
 * never browser-timezone) calendar-day arithmetic.
 *
 * Root-cause context: scripts/sync-business-reports.ts used to compute
 * "yesterday"/"today" with `new Date().toISOString().slice(0, 10)` — the
 * *server's* UTC calendar date. For a marketplace whose local day doesn't
 * line up with UTC midnight (India is UTC+5:30, with no DST), that
 * misclassifies which calendar day is "today" for roughly 5.5 hours around
 * UTC midnight, and is deterministic on the SERVER'S clock, not the
 * marketplace's — two different Render dyno regions/times, or a browser in
 * a different timezone reading the same `report_date`, must never disagree
 * about which calendar day a row represents. Every function here is a pure
 * function of an explicit `timeZone` + an explicit instant, so it is
 * testable and reproducible independent of both server-UTC and the
 * runner's local timezone.
 *
 * Scope: this fix targets the one marketplace this workspace actually runs
 * (A21TJRUUN4KGV / India, Asia/Kolkata, no DST). The resolver below is a
 * map so a second marketplace can be added later without another rewrite,
 * but only Asia/Kolkata is populated/verified here.
 */

export const MARKETPLACE_TIMEZONES: Record<string, string> = {
  A21TJRUUN4KGV: 'Asia/Kolkata', // Amazon.in
}

/** Never silently default to UTC for an unrecognized marketplace — callers must handle `null`. */
export function resolveMarketplaceTimezone(marketplaceId: string | null | undefined): string | null {
  if (!marketplaceId) return null
  return MARKETPLACE_TIMEZONES[marketplaceId] ?? null
}

const DATE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()

function dateFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = DATE_FORMATTER_CACHE.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    DATE_FORMATTER_CACHE.set(timeZone, formatter)
  }
  return formatter
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()

function partsFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PARTS_FORMATTER_CACHE.set(timeZone, formatter)
  }
  return formatter
}

/** YYYY-MM-DD calendar date of `instant` AS OBSERVED IN `timeZone` — the one deterministic fact this whole fix hinges on. */
export function marketplaceDateStringFromInstant(instant: Date, timeZone: string): string {
  // en-CA locale formats as YYYY-MM-DD directly; using formatToParts instead
  // to be robust to locale/ICU-data differences instead of trusting a
  // particular locale's separator/order.
  const parts = dateFormatterFor(timeZone).formatToParts(instant)
  const byType: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') byType[part.type] = part.value
  return `${byType.year}-${byType.month}-${byType.day}`
}

/**
 * Standard "wall clock in `timeZone` minus actual UTC instant" offset, in
 * milliseconds, at the given instant. Positive east of UTC (e.g. +19800000
 * for Asia/Kolkata's fixed UTC+5:30). Recomputed per instant (not cached as
 * a constant) so a DST-observing timezone added to MARKETPLACE_TIMEZONES
 * later is handled correctly too, even though Asia/Kolkata itself never
 * changes.
 */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = partsFormatterFor(timeZone).formatToParts(instant)
  const byType: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') byType[part.type] = part.value
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  )
  return asUtc - instant.getTime()
}

/** Marketplace-local "today" (YYYY-MM-DD) as of `now` — never `new Date().toISOString()`. */
export function marketplaceTodayIso(timeZone: string, now: Date = new Date()): string {
  return marketplaceDateStringFromInstant(now, timeZone)
}

/** Marketplace-local "yesterday" (YYYY-MM-DD) as of `now`. */
export function marketplaceYesterdayIso(timeZone: string, now: Date = new Date()): string {
  return addCalendarDays(marketplaceTodayIso(timeZone, now), -1)
}

/** Pure calendar-date arithmetic on a YYYY-MM-DD string — never a timezone-sensitive `Date` mutation. */
export function addCalendarDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** Every individual calendar date in [dateStart, dateEnd] inclusive, ascending. Never empty for a valid, non-inverted range; never skips or invents a date. */
export function enumerateCalendarDays(dateStart: string, dateEnd: string): string[] {
  if (dateStart > dateEnd) return []
  const days: string[] = []
  let cursor = dateStart
  // Bounded by construction (dateStart <= dateEnd, both plain calendar
  // strings) — no risk of an unbounded loop from malformed input reaching
  // here, since callers validate date-string shape before this is called.
  while (cursor <= dateEnd) {
    days.push(cursor)
    cursor = addCalendarDays(cursor, 1)
  }
  return days
}

export type MarketplaceDayWindow = { dataStartTime: string; dataEndTime: string }

/**
 * The exact UTC instant range Amazon's dataStartTime/dataEndTime must span
 * to request exactly one MARKETPLACE-LOCAL calendar day — i.e.
 * [local 00:00:00.000, local 23:59:59.999] on `dayIso`, expressed as UTC
 * ISO instants. This replaces the previous code's literal
 * `${date}T00:00:00Z` / `${date}T23:59:59Z`, which requested a *UTC*
 * calendar day, not a marketplace-local one — wrong for any marketplace
 * whose offset isn't zero (India is +5:30).
 *
 * Amazon's own public documentation does not spell out, in terms available
 * to this session, whether GET_SALES_AND_TRAFFIC_REPORT buckets internally
 * by marketplace timezone regardless of the exact instants sent, or takes
 * the sent instants literally. Sending marketplace-local boundaries is
 * correct either way: if Amazon re-buckets by marketplace timezone
 * internally, these boundaries land exactly on its own bucket edges; if it
 * takes the instants literally, this is the only way to get the intended
 * calendar day at all. Verifying the exact SP-API behavior against a live
 * report is flagged as a follow-up requiring real Amazon credentials (see
 * final report) — not fabricated here.
 */
export function marketplaceCalendarDayWindow(dayIso: string, timeZone: string): MarketplaceDayWindow {
  const utcMidnightGuess = new Date(`${dayIso}T00:00:00Z`)
  const offsetMs = timeZoneOffsetMs(utcMidnightGuess, timeZone)
  const startUtc = new Date(utcMidnightGuess.getTime() - offsetMs)
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { dataStartTime: startUtc.toISOString(), dataEndTime: endUtc.toISOString() }
}
