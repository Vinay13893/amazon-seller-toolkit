import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARKETPLACE_TIMEZONES,
  resolveMarketplaceTimezone,
  marketplaceDateStringFromInstant,
  timeZoneOffsetMs,
  marketplaceTodayIso,
  marketplaceYesterdayIso,
  addCalendarDays,
  enumerateCalendarDays,
  marketplaceCalendarDayWindow,
} from '../business-report-marketplace-time'

describe('resolveMarketplaceTimezone', () => {
  test('known India marketplace resolves to Asia/Kolkata', () => {
    assert.equal(resolveMarketplaceTimezone('A21TJRUUN4KGV'), 'Asia/Kolkata')
    assert.equal(MARKETPLACE_TIMEZONES.A21TJRUUN4KGV, 'Asia/Kolkata')
  })
  test('unknown marketplace never silently defaults to UTC -- returns null', () => {
    assert.equal(resolveMarketplaceTimezone('ATVPDKIKX0DER'), null)
  })
  test('null/undefined marketplace id returns null, never throws', () => {
    assert.equal(resolveMarketplaceTimezone(null), null)
    assert.equal(resolveMarketplaceTimezone(undefined), null)
  })
})

describe('the exact near-UTC-midnight boundary case', () => {
  // 2026-07-28T19:00:00Z is 2026-07-29T00:30:00 IST -- past midnight IST
  // even though it's still 2026-07-28 in UTC. A UTC-naive implementation
  // (the old bug) would call this "yesterday" being 07-27; the correct
  // marketplace-local answer is that 07-28T19:00Z is already IST 07-29.
  test('19:00 UTC is already the next calendar day in Asia/Kolkata (+5:30)', () => {
    const instant = new Date('2026-07-28T19:00:00.000Z')
    assert.equal(marketplaceDateStringFromInstant(instant, 'Asia/Kolkata'), '2026-07-29')
  })
  // 2026-07-28T18:29:59Z is still 2026-07-28T23:59:59 IST -- one second
  // before the boundary.
  test('18:29:59 UTC is still the same calendar day in Asia/Kolkata', () => {
    const instant = new Date('2026-07-28T18:29:59.000Z')
    assert.equal(marketplaceDateStringFromInstant(instant, 'Asia/Kolkata'), '2026-07-28')
  })
  // Exactly the boundary instant: 18:30:00 UTC == 00:00:00 IST next day.
  test('18:30:00 UTC is exactly midnight IST -- already the next day', () => {
    const instant = new Date('2026-07-28T18:30:00.000Z')
    assert.equal(marketplaceDateStringFromInstant(instant, 'Asia/Kolkata'), '2026-07-29')
  })
})

describe('timeZoneOffsetMs', () => {
  test('Asia/Kolkata is always +5:30 (19800000ms), no DST', () => {
    assert.equal(timeZoneOffsetMs(new Date('2026-01-01T00:00:00Z'), 'Asia/Kolkata'), 19_800_000)
    assert.equal(timeZoneOffsetMs(new Date('2026-07-28T12:00:00Z'), 'Asia/Kolkata'), 19_800_000)
  })
})

describe('marketplaceTodayIso / marketplaceYesterdayIso', () => {
  test('are computed from the given `now`, never the real wall clock, and never UTC-naive', () => {
    // 2026-07-28T19:00:00Z -> already IST 07-29 -- "today" must be 07-29,
    // NOT 07-28 (which is what `new Date().toISOString().slice(0,10)` --
    // the old bug -- would have produced).
    const now = new Date('2026-07-28T19:00:00.000Z')
    assert.equal(marketplaceTodayIso('Asia/Kolkata', now), '2026-07-29')
    assert.equal(marketplaceYesterdayIso('Asia/Kolkata', now), '2026-07-28')
  })

  test('browser-timezone-independence: the same instant produces the same marketplace date regardless of what "local" timezone means to whoever reads it', () => {
    const now = new Date('2026-07-15T10:00:00.000Z')
    // Same instant, same marketplace timeZone argument -> same answer,
    // completely independent of process.env.TZ or any other ambient
    // local-timezone state.
    const a = marketplaceTodayIso('Asia/Kolkata', now)
    const b = marketplaceTodayIso('Asia/Kolkata', new Date(now.getTime()))
    assert.equal(a, b)
    assert.equal(a, '2026-07-15')
  })
})

describe('addCalendarDays', () => {
  test('adds/subtracts whole calendar days without timezone drift', () => {
    assert.equal(addCalendarDays('2026-07-28', 1), '2026-07-29')
    assert.equal(addCalendarDays('2026-07-28', -1), '2026-07-27')
    assert.equal(addCalendarDays('2026-03-01', -1), '2026-02-28')
    assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31')
  })
})

describe('enumerateCalendarDays', () => {
  test('lists every date inclusive, ascending, never skipping or inventing a date', () => {
    assert.deepEqual(enumerateCalendarDays('2026-07-26', '2026-07-28'), ['2026-07-26', '2026-07-27', '2026-07-28'])
  })
  test('single-day range returns exactly one date', () => {
    assert.deepEqual(enumerateCalendarDays('2026-07-28', '2026-07-28'), ['2026-07-28'])
  })
  test('inverted range (start after end) returns empty, never throws, never wraps', () => {
    assert.deepEqual(enumerateCalendarDays('2026-07-28', '2026-07-26'), [])
  })
  test('14-day rolling window produces exactly 14 dates', () => {
    assert.equal(enumerateCalendarDays('2026-07-01', '2026-07-14').length, 14)
  })
})

describe('marketplaceCalendarDayWindow', () => {
  test('IST calendar day 2026-07-28 maps to 2026-07-27T18:30:00Z .. 2026-07-28T18:29:59.999Z', () => {
    const window = marketplaceCalendarDayWindow('2026-07-28', 'Asia/Kolkata')
    assert.equal(window.dataStartTime, '2026-07-27T18:30:00.000Z')
    assert.equal(window.dataEndTime, '2026-07-28T18:29:59.999Z')
  })
  test('the window is always exactly 24 hours (minus 1ms)', () => {
    const window = marketplaceCalendarDayWindow('2026-01-01', 'Asia/Kolkata')
    const spanMs = new Date(window.dataEndTime).getTime() - new Date(window.dataStartTime).getTime()
    assert.equal(spanMs, 24 * 60 * 60 * 1000 - 1)
  })
})
