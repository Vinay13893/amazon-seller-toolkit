import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSkuReportDate, isSingleDayGrain, SkuGrainViolationError } from '../business-report-grain-guard'

describe('resolveSkuReportDate', () => {
  test('single-day request (dateFrom === dateTo) returns that exact date', () => {
    assert.equal(resolveSkuReportDate('2026-07-28', '2026-07-28'), '2026-07-28')
  })

  test('multi-day request throws SkuGrainViolationError -- fails closed, never falls back to dateTo', () => {
    assert.throws(() => resolveSkuReportDate('2026-07-15', '2026-07-28'), SkuGrainViolationError)
  })

  test('the exact regression case: a 14-day rolling window must never silently resolve to the last day', () => {
    // This is the literal shape of the old bug: dateStart=2026-07-01,
    // dateEnd=2026-07-28 (the certification audit's window) used to
    // resolve via `dateStart === dateEnd ? dateStart : dateEnd` to
    // '2026-07-28' and store the WHOLE range's SKU total under that one
    // date. It must now throw instead.
    let threw = false
    try {
      resolveSkuReportDate('2026-07-01', '2026-07-28')
    } catch (err) {
      threw = true
      assert.ok(err instanceof SkuGrainViolationError)
      assert.equal((err as SkuGrainViolationError).dateFrom, '2026-07-01')
      assert.equal((err as SkuGrainViolationError).dateTo, '2026-07-28')
    }
    assert.ok(threw, 'expected resolveSkuReportDate to throw for a multi-day range')
  })

  test('a 2-day range (the smallest possible multi-day case) also throws', () => {
    assert.throws(() => resolveSkuReportDate('2026-07-27', '2026-07-28'), SkuGrainViolationError)
  })
})

describe('isSingleDayGrain', () => {
  test('true only when dateFrom === dateTo', () => {
    assert.equal(isSingleDayGrain('2026-07-28', '2026-07-28'), true)
    assert.equal(isSingleDayGrain('2026-07-27', '2026-07-28'), false)
    assert.equal(isSingleDayGrain('2026-07-01', '2026-07-28'), false)
  })
})
