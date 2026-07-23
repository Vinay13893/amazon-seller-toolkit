import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidMarketplaceId, isValidDateString, isValidSort, isValidFilterString, isValidSkuString,
  clampLimit, clampOffset, optionalFilter, parseBooleanFlag,
  DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET,
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

describe('clampLimit', () => {
  test('applies the default when absent', () => {
    assert.equal(clampLimit(null), DEFAULT_LIMIT)
  })
  test('clamps a value above the ceiling', () => {
    assert.equal(clampLimit('99999'), MAX_LIMIT)
  })
  test('clamps a negative value up to 1', () => {
    assert.equal(clampLimit('-5'), 1)
  })
  test('"0" is treated as absent and falls back to the default (matches the pincode-monitoring tracker route convention: Math.max(1, requestedLimit || DEFAULT))', () => {
    assert.equal(clampLimit('0'), DEFAULT_LIMIT)
  })
  test('passes through a valid in-range value', () => {
    assert.equal(clampLimit('250'), 250)
  })
  test('applies the default for garbage input', () => {
    assert.equal(clampLimit('not-a-number'), DEFAULT_LIMIT)
  })
})

describe('clampOffset', () => {
  test('defaults to 0 when absent', () => {
    assert.equal(clampOffset(null), 0)
  })
  test('clamps a negative value up to 0', () => {
    assert.equal(clampOffset('-1'), 0)
  })
  test('clamps a value above the ceiling', () => {
    assert.equal(clampOffset(String(MAX_OFFSET + 1000)), MAX_OFFSET)
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

describe('parseBooleanFlag', () => {
  test('true string is true', () => {
    assert.equal(parseBooleanFlag('true'), true)
  })
  test('1 string is true', () => {
    assert.equal(parseBooleanFlag('1'), true)
  })
  test('absent is false', () => {
    assert.equal(parseBooleanFlag(null), false)
  })
  test('false string is false', () => {
    assert.equal(parseBooleanFlag('false'), false)
  })
})
