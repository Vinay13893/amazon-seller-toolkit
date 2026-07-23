import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidMarketplaceId, isValidDateString, isValidSort, isValidFilterString, isValidSkuString,
  parseStrictInt, validateLimit, validateOffset, optionalFilter, validateBooleanFlag,
  inclusiveDayCount, isRangeWithinInclusiveDays,
  DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET, MAX_SUMMARY_RANGE_DAYS, MAX_DAILY_RANGE_DAYS,
} from '../validation'

describe('isValidMarketplaceId', () => {
  test('accepts a normal marketplace id', () => {
    assert.equal(isValidMarketplaceId('A21TJRUUN4KGV'), true)
  })
  test('rejects null', () => {
    assert.equal(isValidMarketplaceId(null), false)
  })
  test('rejects empty string', () => {
    assert.equal(isValidMarketplaceId(''), false)
  })
  test('rejects over the 40-char ceiling', () => {
    assert.equal(isValidMarketplaceId('A'.repeat(41)), false)
  })
})

describe('isValidDateString', () => {
  test('accepts a well-formed date', () => {
    assert.equal(isValidDateString('2026-07-20'), true)
  })
  test('rejects a malformed date shape', () => {
    assert.equal(isValidDateString('2026/07/20'), false)
  })
  test('rejects a calendar-invalid date (Feb 30)', () => {
    assert.equal(isValidDateString('2026-02-30'), false)
  })
  test('rejects null', () => {
    assert.equal(isValidDateString(null), false)
  })
  test('rejects a non-date string', () => {
    assert.equal(isValidDateString('not-a-date'), false)
  })
})

describe('isValidSort', () => {
  test('accepts every documented sort value', () => {
    for (const v of ['attention_desc', 'sales_desc', 'sales_asc', 'spend_desc', 'spend_asc', 'tacos_desc', 'tacos_asc', 'sku_asc']) {
      assert.equal(isValidSort(v), true, `expected ${v} to be valid`)
    }
  })
  test('rejects an unsupported sort string', () => {
    assert.equal(isValidSort('not_a_real_sort'), false)
  })
  test('rejects a non-string', () => {
    assert.equal(isValidSort(123), false)
  })
})

describe('isValidFilterString', () => {
  test('accepts a normal filter value', () => {
    assert.equal(isValidFilterString('Widgets'), true)
  })
  test('rejects an empty string', () => {
    assert.equal(isValidFilterString(''), false)
  })
  test('rejects an over-length filter (201 chars)', () => {
    assert.equal(isValidFilterString('x'.repeat(201)), false)
  })
})

describe('isValidSkuString', () => {
  test('accepts a normal SKU', () => {
    assert.equal(isValidSkuString('SKU-001'), true)
  })
  test('rejects whitespace-only', () => {
    assert.equal(isValidSkuString('   '), false)
  })
  test('rejects an over-length SKU (201 chars)', () => {
    assert.equal(isValidSkuString('x'.repeat(201)), false)
  })
})

describe('parseStrictInt', () => {
  test('parses a plain positive integer', () => {
    assert.equal(parseStrictInt('250'), 250)
  })
  test('parses a plain negative integer', () => {
    assert.equal(parseStrictInt('-5'), -5)
  })
  test('parses zero', () => {
    assert.equal(parseStrictInt('0'), 0)
  })
  test('rejects trailing garbage ("10abc")', () => {
    assert.equal(parseStrictInt('10abc'), null)
  })
  test('rejects leading garbage ("abc10")', () => {
    assert.equal(parseStrictInt('abc10'), null)
  })
  test('rejects a mixed-garbage value ("5xyz")', () => {
    assert.equal(parseStrictInt('5xyz'), null)
  })
  test('rejects a decimal value ("3.5")', () => {
    assert.equal(parseStrictInt('3.5'), null)
  })
  test('rejects scientific notation ("1e5")', () => {
    assert.equal(parseStrictInt('1e5'), null)
  })
  test('rejects whitespace padding (" 5")', () => {
    assert.equal(parseStrictInt(' 5'), null)
  })
  test('rejects an empty string', () => {
    assert.equal(parseStrictInt(''), null)
  })
})

describe('validateLimit', () => {
  test('applies the default when absent', () => {
    assert.deepEqual(validateLimit(null), { ok: true, value: DEFAULT_LIMIT })
  })
  test('rejects a value above the ceiling instead of clamping it', () => {
    assert.deepEqual(validateLimit('99999'), { ok: false })
  })
  test('rejects a negative value instead of clamping it up to 1', () => {
    assert.deepEqual(validateLimit('-5'), { ok: false })
  })
  test('rejects "0" instead of silently falling back to the default', () => {
    assert.deepEqual(validateLimit('0'), { ok: false })
  })
  test('passes through a valid in-range value', () => {
    assert.deepEqual(validateLimit('250'), { ok: true, value: 250 })
  })
  test('rejects garbage input ("10abc") instead of silently defaulting', () => {
    assert.deepEqual(validateLimit('10abc'), { ok: false })
  })
  test('rejects a decimal value ("100.5")', () => {
    assert.deepEqual(validateLimit('100.5'), { ok: false })
  })
  test('accepts exactly MAX_LIMIT', () => {
    assert.deepEqual(validateLimit(String(MAX_LIMIT)), { ok: true, value: MAX_LIMIT })
  })
})

describe('validateOffset', () => {
  test('defaults to 0 when absent', () => {
    assert.deepEqual(validateOffset(null), { ok: true, value: 0 })
  })
  test('rejects a negative value instead of clamping it up to 0', () => {
    assert.deepEqual(validateOffset('-1'), { ok: false })
  })
  test('rejects a value above the ceiling instead of clamping it', () => {
    assert.deepEqual(validateOffset(String(MAX_OFFSET + 1000)), { ok: false })
  })
  test('rejects garbage input ("5xyz") instead of silently defaulting to 0', () => {
    assert.deepEqual(validateOffset('5xyz'), { ok: false })
  })
  test('accepts exactly 0', () => {
    assert.deepEqual(validateOffset('0'), { ok: true, value: 0 })
  })
})

describe('optionalFilter', () => {
  test('trims and passes through a non-empty value', () => {
    assert.equal(optionalFilter('  Widgets  '), 'Widgets')
  })
  test('returns null for null', () => {
    assert.equal(optionalFilter(null), null)
  })
  test('returns null for whitespace-only', () => {
    assert.equal(optionalFilter('   '), null)
  })
})

describe('validateBooleanFlag', () => {
  test('"true" is true', () => {
    assert.deepEqual(validateBooleanFlag('true'), { ok: true, value: true })
  })
  test('"1" is true', () => {
    assert.deepEqual(validateBooleanFlag('1'), { ok: true, value: true })
  })
  test('absent is false', () => {
    assert.deepEqual(validateBooleanFlag(null), { ok: true, value: false })
  })
  test('"false" is false', () => {
    assert.deepEqual(validateBooleanFlag('false'), { ok: true, value: false })
  })
  test('"0" is false', () => {
    assert.deepEqual(validateBooleanFlag('0'), { ok: true, value: false })
  })
  test('rejects an arbitrary truthy-looking value ("yes") instead of treating it as false', () => {
    assert.deepEqual(validateBooleanFlag('yes'), { ok: false })
  })
  test('rejects a typo ("tru") instead of treating it as false', () => {
    assert.deepEqual(validateBooleanFlag('tru'), { ok: false })
  })
  test('rejects an empty string instead of treating it as false', () => {
    assert.deepEqual(validateBooleanFlag(''), { ok: false })
  })
})

// Follow-up correction: dateTo - dateFrom is a day DIFFERENCE, not an
// inclusive calendar-date count -- both endpoints are inclusive, so the
// actual number of dates in range is one more than the difference. These
// tests exercise the exact 400/401 boundary that this API-level validation
// is responsible for (the SQL RPCs enforce the same ceiling independently).
describe('inclusiveDayCount', () => {
  test('same day counts as exactly 1 inclusive day', () => {
    assert.equal(inclusiveDayCount('2026-07-20', '2026-07-20'), 1)
  })
  test('adjacent days count as exactly 2 inclusive days', () => {
    assert.equal(inclusiveDayCount('2026-07-19', '2026-07-20'), 2)
  })
  test('exactly 400 inclusive calendar dates', () => {
    // 2026-07-20 minus 399 days = the date 400 inclusive days ending on 2026-07-20 starts on.
    assert.equal(inclusiveDayCount('2025-06-16', '2026-07-20'), 400)
  })
})

describe('isRangeWithinInclusiveDays (API-level range ceiling)', () => {
  test('exactly MAX_SUMMARY_RANGE_DAYS (400) inclusive dates is accepted', () => {
    assert.equal(isRangeWithinInclusiveDays('2025-06-16', '2026-07-20', MAX_SUMMARY_RANGE_DAYS), true)
  })
  test('401 inclusive dates (one more than the 400 ceiling) is rejected', () => {
    assert.equal(isRangeWithinInclusiveDays('2025-06-15', '2026-07-20', MAX_SUMMARY_RANGE_DAYS), false)
  })
  test('summary and daily ceilings behave identically at the same boundary (both are 400)', () => {
    assert.equal(MAX_SUMMARY_RANGE_DAYS, MAX_DAILY_RANGE_DAYS)
    assert.equal(isRangeWithinInclusiveDays('2025-06-16', '2026-07-20', MAX_DAILY_RANGE_DAYS), true)
    assert.equal(isRangeWithinInclusiveDays('2025-06-15', '2026-07-20', MAX_DAILY_RANGE_DAYS), false)
  })
})
