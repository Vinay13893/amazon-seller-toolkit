import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isValidUuid, isValidAsin, isValidPincode, isValidMarketplaceId, normalizeAsin, normalizePincodeList } from '../validation'

describe('isValidUuid', () => {
  test('accepts a well-formed UUID', () => {
    assert.equal(isValidUuid('a0000000-0000-0000-0000-000000000001'), true)
  })
  test('rejects a non-UUID string', () => {
    assert.equal(isValidUuid('not-a-uuid'), false)
  })
  test('rejects a UUID with SQL-injection-shaped suffix', () => {
    assert.equal(isValidUuid("a0000000-0000-0000-0000-000000000001'; DROP TABLE x;--"), false)
  })
})

describe('isValidAsin', () => {
  test('accepts a 10-char alphanumeric ASIN', () => {
    assert.equal(isValidAsin('B0D9QXVWLL'), true)
  })
  test('rejects a too-short ASIN', () => {
    assert.equal(isValidAsin('B0D9Q'), false)
  })
  test('rejects an ASIN with punctuation', () => {
    assert.equal(isValidAsin('B0D9QX;WLL'), false)
  })
})

describe('isValidPincode', () => {
  test('accepts a valid 6-digit Indian pincode', () => {
    assert.equal(isValidPincode('110001'), true)
  })
  test('rejects a pincode starting with 0', () => {
    assert.equal(isValidPincode('010001'), false)
  })
  test('rejects a pincode with whitespace', () => {
    assert.equal(isValidPincode('110 01'), false)
  })
  test('rejects a 5-digit pincode', () => {
    assert.equal(isValidPincode('11000'), false)
  })
})

describe('isValidMarketplaceId', () => {
  test('accepts a normal marketplace id', () => {
    assert.equal(isValidMarketplaceId('A21TJRUUN4KGV'), true)
  })
  test('rejects empty string', () => {
    assert.equal(isValidMarketplaceId(''), false)
  })
  test('rejects a value over the 40-char ceiling', () => {
    assert.equal(isValidMarketplaceId('A'.repeat(41)), false)
  })
  test('rejects a non-string', () => {
    assert.equal(isValidMarketplaceId(123), false)
  })
})

describe('normalizeAsin', () => {
  test('uppercases and trims a valid lowercase ASIN', () => {
    assert.equal(normalizeAsin(' b0d9qxvwll '), 'B0D9QXVWLL')
  })
  test('returns null for an invalid ASIN', () => {
    assert.equal(normalizeAsin('short'), null)
  })
  test('returns null for a non-string', () => {
    assert.equal(normalizeAsin(12345), null)
  })
})

describe('normalizePincodeList', () => {
  test('accepts and de-duplicates a valid list', () => {
    const result = normalizePincodeList(['110001', '110001', '110002'])
    assert.notEqual(result, null)
    assert.deepEqual([...(result ?? [])].sort(), ['110001', '110002'])
  })
  test('rejects an empty array', () => {
    assert.equal(normalizePincodeList([]), null)
  })
  test('rejects a non-array', () => {
    assert.equal(normalizePincodeList('110001'), null)
  })
  test('rejects if any entry is malformed (whole-batch rejection, not partial)', () => {
    assert.equal(normalizePincodeList(['110001', 'bad']), null)
  })
})
