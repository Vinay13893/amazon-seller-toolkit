import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeReconciliationDiff,
  reconciliationVerdict,
  PROPOSED_SALES_TOLERANCE_PCT,
} from '../business-report-reconciliation'

describe('computeReconciliationDiff', () => {
  test('exact match -> zero diffs', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 1000, skuOrderedSalesSum: 1000, accountUnits: 10, skuUnitsSum: 10 })
    assert.equal(diff.salesAbsDiff, 0)
    assert.equal(diff.salesPctDiff, 0)
    assert.equal(diff.unitsAbsDiff, 0)
    assert.equal(diff.unitsPctDiff, 0)
  })

  test('the observed 14.3x inflation case: SKU sum vastly exceeds the account total', () => {
    // Prior-audit numbers: account total ~5,105,479.56, SKU sum ~72,902,971.71
    const diff = computeReconciliationDiff({ accountOrderedSales: 5105479.56, skuOrderedSalesSum: 72902971.71, accountUnits: 0, skuUnitsSum: 0 })
    assert.ok(diff.salesAbsDiff > 0)
    assert.ok(diff.salesPctDiff !== null && diff.salesPctDiff > 1000, 'expected >1000% overstatement')
  })

  test('account total of zero produces a null percent diff (undefined, never 0% or Infinity)', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 0, skuOrderedSalesSum: 50, accountUnits: 0, skuUnitsSum: 1 })
    assert.equal(diff.salesPctDiff, null)
    assert.equal(diff.unitsPctDiff, null)
    assert.equal(diff.salesAbsDiff, 50)
  })

  test('both zero -> zero abs diff, null pct diff (not 0%, since 0/0 is undefined)', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 0, skuOrderedSalesSum: 0, accountUnits: 0, skuUnitsSum: 0 })
    assert.equal(diff.salesAbsDiff, 0)
    assert.equal(diff.salesPctDiff, null)
  })
})

describe('reconciliationVerdict', () => {
  test('within the proposed tolerance -> within_tolerance', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 10000, skuOrderedSalesSum: 10050, accountUnits: 0, skuUnitsSum: 0 }) // 0.5% over
    const verdict = reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT })
    assert.equal(verdict, 'within_tolerance')
  })

  test('beyond the proposed tolerance -> exceeds_tolerance', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 10000, skuOrderedSalesSum: 10500, accountUnits: 0, skuUnitsSum: 0 }) // 5% over
    const verdict = reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT })
    assert.equal(verdict, 'exceeds_tolerance')
  })

  test('the observed inflation case is always exceeds_tolerance regardless of tolerance chosen', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 5105479.56, skuOrderedSalesSum: 72902971.71, accountUnits: 0, skuUnitsSum: 0 })
    const verdict = reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT })
    assert.equal(verdict, 'exceeds_tolerance')
  })

  test('strict_exact_match mode requires literal equality -- a 0.1% diff still fails', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 10000, skuOrderedSalesSum: 10010, accountUnits: 0, skuUnitsSum: 0 })
    assert.equal(reconciliationVerdict(diff, { kind: 'strict_exact_match' }), 'exceeds_tolerance')
  })

  test('strict_exact_match mode accepts a literal exact match', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 10000, skuOrderedSalesSum: 10000, accountUnits: 0, skuUnitsSum: 0 })
    assert.equal(reconciliationVerdict(diff, { kind: 'strict_exact_match' }), 'within_tolerance')
  })

  test('zero account total with a nonzero SKU sum is exceeds_tolerance (never silently within_tolerance because pct is null)', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 0, skuOrderedSalesSum: 10, accountUnits: 0, skuUnitsSum: 0 })
    assert.equal(reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT }), 'exceeds_tolerance')
  })

  test('zero account total with a zero SKU sum is within_tolerance (a genuine confirmed-zero day)', () => {
    const diff = computeReconciliationDiff({ accountOrderedSales: 0, skuOrderedSalesSum: 0, accountUnits: 0, skuUnitsSum: 0 })
    assert.equal(reconciliationVerdict(diff, { kind: 'tolerance', salesTolerancePct: PROPOSED_SALES_TOLERANCE_PCT }), 'within_tolerance')
  })
})
