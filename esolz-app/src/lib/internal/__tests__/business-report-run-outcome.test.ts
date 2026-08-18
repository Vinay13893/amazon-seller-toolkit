import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSkuRows,
  classifyStructuralCompleteness,
  shouldSkipAlreadyConfirmedDate,
} from '../business-report-run-outcome'

type Row = { parentAsin: string | null; childAsin: string | null; sku: string | null; orderedProductSales: number; unitsOrdered: number }

const okRow: Row = { parentAsin: 'B0PARENT', childAsin: 'B0CHILD', sku: 'SKU-1', orderedProductSales: 100, unitsOrdered: 2 }

describe('validateSkuRows', () => {
  test('a fully-valid row is accepted, nothing rejected', () => {
    const result = validateSkuRows([okRow])
    assert.equal(result.accepted.length, 1)
    assert.equal(result.rejected.length, 0)
  })

  test('a row with no sku/childAsin/parentAsin at all is rejected as no_identity', () => {
    const bad: Row = { parentAsin: null, childAsin: null, sku: null, orderedProductSales: 10, unitsOrdered: 1 }
    const result = validateSkuRows([bad])
    assert.equal(result.accepted.length, 0)
    assert.deepEqual(result.rejected, [{ index: 0, reason: 'no_identity' }])
  })

  test('NaN ordered_product_sales is rejected, never silently coerced to 0', () => {
    const bad: Row = { ...okRow, orderedProductSales: NaN }
    const result = validateSkuRows([bad])
    assert.deepEqual(result.rejected, [{ index: 0, reason: 'non_finite_ordered_product_sales' }])
  })

  test('negative ordered_product_sales is rejected', () => {
    const bad: Row = { ...okRow, orderedProductSales: -5 }
    const result = validateSkuRows([bad])
    assert.deepEqual(result.rejected, [{ index: 0, reason: 'negative_ordered_product_sales' }])
  })

  test('non-finite units_ordered is rejected', () => {
    const bad: Row = { ...okRow, unitsOrdered: Infinity }
    const result = validateSkuRows([bad])
    assert.deepEqual(result.rejected, [{ index: 0, reason: 'non_finite_units_ordered' }])
  })

  test('negative units_ordered is rejected', () => {
    const bad: Row = { ...okRow, unitsOrdered: -1 }
    const result = validateSkuRows([bad])
    assert.deepEqual(result.rejected, [{ index: 0, reason: 'negative_units_ordered' }])
  })

  test('a mix of good and bad rows: rejections carry the correct original index, acceptance is truthful', () => {
    const rows: Row[] = [okRow, { ...okRow, sku: null, childAsin: null, parentAsin: null }, okRow]
    const result = validateSkuRows(rows)
    assert.equal(result.accepted.length, 2)
    assert.deepEqual(result.rejected, [{ index: 1, reason: 'no_identity' }])
  })

  test('a SKU-only row (no ASINs) is accepted -- identity just needs ONE of the three', () => {
    const skuOnly: Row = { parentAsin: null, childAsin: null, sku: 'SKU-ONLY', orderedProductSales: 5, unitsOrdered: 1 }
    assert.equal(validateSkuRows([skuOnly]).accepted.length, 1)
  })
})

describe('classifyStructuralCompleteness', () => {
  test('a well-formed single day (1 by-date row, all SKU rows accepted) is success', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 1,
      byDateOrderedProductSales: 500,
      skuRowsFetched: 3,
      skuRowsRejected: 0,
    })
    assert.deepEqual(result, { status: 'success', reason: null })
  })

  test('zero by-date rows for the requested date is failed -- never accepted-complete, this is the exact 07-28 regression', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 0,
      byDateOrderedProductSales: null,
      skuRowsFetched: 0,
      skuRowsRejected: 0,
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'missing_by_date_row_for_requested_date')
  })

  test('more than one by-date row for a single-day request is failed, never picks one arbitrarily', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 2,
      byDateOrderedProductSales: 500,
      skuRowsFetched: 3,
      skuRowsRejected: 0,
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'multiple_by_date_rows_for_single_day_request')
  })

  test('any rejected SKU row makes the day partial_success, never success -- rows_rejected must never be silently zeroed', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 1,
      byDateOrderedProductSales: 500,
      skuRowsFetched: 3,
      skuRowsRejected: 1,
    })
    assert.equal(result.status, 'partial_success')
    assert.equal(result.reason, 'sku_rows_rejected')
  })

  test('positive account sales but zero SKU rows at all is partial_success, not a silently-accepted zero-SKU day', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 1,
      byDateOrderedProductSales: 250,
      skuRowsFetched: 0,
      skuRowsRejected: 0,
    })
    assert.equal(result.status, 'partial_success')
    assert.equal(result.reason, 'positive_sales_but_no_sku_breakdown')
  })

  test('a genuine zero-sales day with zero SKU rows is success (CONFIRMED_ZERO territory, not a defect)', () => {
    const result = classifyStructuralCompleteness({
      byDateMatchCount: 1,
      byDateOrderedProductSales: 0,
      skuRowsFetched: 0,
      skuRowsRejected: 0,
    })
    assert.deepEqual(result, { status: 'success', reason: null })
  })
})

describe('shouldSkipAlreadyConfirmedDate', () => {
  test('no prior run at all -- never skip', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate(null, false), false)
  })

  test('a prior confirmed-complete run (success, rows_rejected=0) is skipped', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate({ status: 'success', rowsRejected: 0 }, false), true)
  })

  test('a prior success WITH rejected rows is never treated as confirmed-complete -- must be retried', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate({ status: 'success', rowsRejected: 3 }, false), false)
  })

  test('a prior partial_success is never skipped', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate({ status: 'partial_success', rowsRejected: 0 }, false), false)
  })

  test('a prior failed run is never skipped', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate({ status: 'failed', rowsRejected: 0 }, false), false)
  })

  test('--force-refresh always re-requests, even an already-confirmed date', () => {
    assert.equal(shouldSkipAlreadyConfirmedDate({ status: 'success', rowsRejected: 0 }, true), false)
  })
})
