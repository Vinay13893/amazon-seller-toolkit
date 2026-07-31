import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeDateScopeReplacement, skuScopeKey } from '../business-report-date-scope-replace'

type NewRow = { sku_norm: string | null; child_asin: string | null; parent_asin: string | null; ordered_product_sales: number }

describe('skuScopeKey', () => {
  test('mirrors the DB unique index coalesce() expression exactly', () => {
    assert.equal(skuScopeKey({ sku_norm: 'SKU-1', child_asin: 'B0CHILD', parent_asin: 'B0PARENT' }), 'SKU-1|B0CHILD|B0PARENT')
    assert.equal(skuScopeKey({ sku_norm: null, child_asin: null, parent_asin: null }), '||')
  })
})

describe('computeDateScopeReplacement', () => {
  test('brand-new day (no existing rows) -- everything is an insert, nothing to update or delete', () => {
    const newRows: NewRow[] = [{ sku_norm: 'SKU-1', child_asin: 'B0A', parent_asin: 'B0P', ordered_product_sales: 100 }]
    const plan = computeDateScopeReplacement([], newRows, r => skuScopeKey(r))
    assert.equal(plan.toInsert.length, 1)
    assert.equal(plan.toUpdate.length, 0)
    assert.deepEqual(plan.toDeleteIds, [])
  })

  test('a SKU present in both existing and new rows is an UPDATE by its existing id, not a duplicate insert', () => {
    const existing = [{ id: 'row-1', key: 'SKU-1|B0A|B0P' }]
    const newRows: NewRow[] = [{ sku_norm: 'SKU-1', child_asin: 'B0A', parent_asin: 'B0P', ordered_product_sales: 250 }]
    const plan = computeDateScopeReplacement(existing, newRows, r => skuScopeKey(r))
    assert.equal(plan.toInsert.length, 0)
    assert.equal(plan.toUpdate.length, 1)
    assert.equal(plan.toUpdate[0].id, 'row-1')
    assert.equal(plan.toUpdate[0].ordered_product_sales, 250)
    assert.deepEqual(plan.toDeleteIds, [])
  })

  test('THE core Phase 5 case: a SKU with an existing (stale, inflated) row that has zero activity on the corrected day is deleted, not silently left behind', () => {
    const existing = [
      { id: 'row-stale', key: 'SKU-ZERO-TODAY|B0A|B0P' }, // had a row from the old inflated multi-day sync; today it has no activity at all
      { id: 'row-keep', key: 'SKU-ACTIVE|B0B|B0Q' },
    ]
    const newRows: NewRow[] = [
      { sku_norm: 'SKU-ACTIVE', child_asin: 'B0B', parent_asin: 'B0Q', ordered_product_sales: 400 },
    ]
    const plan = computeDateScopeReplacement(existing, newRows, r => skuScopeKey(r))
    assert.equal(plan.toInsert.length, 0)
    assert.equal(plan.toUpdate.length, 1)
    assert.equal(plan.toUpdate[0].id, 'row-keep')
    assert.deepEqual(plan.toDeleteIds, ['row-stale'])
  })

  test('a full replacement: some inserted, some updated, some deleted, all in one plan', () => {
    const existing = [
      { id: 'row-a', key: 'SKU-A|B0A|B0P' }, // stays (update)
      { id: 'row-b', key: 'SKU-B|B0B|B0Q' }, // goes away (delete)
    ]
    const newRows: NewRow[] = [
      { sku_norm: 'SKU-A', child_asin: 'B0A', parent_asin: 'B0P', ordered_product_sales: 10 },
      { sku_norm: 'SKU-C', child_asin: 'B0C', parent_asin: 'B0R', ordered_product_sales: 20 }, // new
    ]
    const plan = computeDateScopeReplacement(existing, newRows, r => skuScopeKey(r))
    assert.equal(plan.toInsert.length, 1)
    assert.equal(plan.toInsert[0].sku_norm, 'SKU-C')
    assert.equal(plan.toUpdate.length, 1)
    assert.equal(plan.toUpdate[0].id, 'row-a')
    assert.deepEqual(plan.toDeleteIds, ['row-b'])
  })

  test('empty new-row set against existing rows deletes everything in scope -- a fully-zero corrected day clears stale rows, never leaves them', () => {
    const existing = [{ id: 'row-1', key: 'SKU-1|B0A|B0P' }, { id: 'row-2', key: 'SKU-2|B0B|B0Q' }]
    const plan = computeDateScopeReplacement(existing, [] as NewRow[], r => skuScopeKey(r))
    assert.equal(plan.toInsert.length, 0)
    assert.equal(plan.toUpdate.length, 0)
    assert.deepEqual(plan.toDeleteIds.sort(), ['row-1', 'row-2'])
  })

  test('idempotent rerun: running the same new-row set against its own resulting state produces zero inserts, zero deletes, only updates', () => {
    const newRows: NewRow[] = [{ sku_norm: 'SKU-1', child_asin: 'B0A', parent_asin: 'B0P', ordered_product_sales: 100 }]
    const firstPlan = computeDateScopeReplacement([], newRows, r => skuScopeKey(r))
    assert.equal(firstPlan.toInsert.length, 1)

    // Simulate the DB state after applying firstPlan.
    const afterFirst = [{ id: 'row-1', key: skuScopeKey(newRows[0]) }]
    const secondPlan = computeDateScopeReplacement(afterFirst, newRows, r => skuScopeKey(r))
    assert.equal(secondPlan.toInsert.length, 0)
    assert.equal(secondPlan.toUpdate.length, 1)
    assert.deepEqual(secondPlan.toDeleteIds, [])
  })
})
