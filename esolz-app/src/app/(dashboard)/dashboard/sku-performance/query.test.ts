import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  defaultDateRange, buildSummaryQueryString, derivePageViewState, deriveChartViewState,
  filterRowsByTitle, MARKETPLACE_ID, V0_DAY_RANGE,
} from './query'
import type { SkuPerformanceSummaryResult, SkuPerformanceDailyResult } from '@/lib/sku-performance/types'

const fixturePath = fileURLToPath(new URL('../../../../lib/sku-performance/__fixtures__/p1c1-sample-responses.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  getSummaryResponse: SkuPerformanceSummaryResult
  getDailyResponseSuccess: SkuPerformanceDailyResult
  getDailyResponseIdentityConflictAsinMismatch: SkuPerformanceDailyResult
}

// ---- date-range behavior ----

describe('defaultDateRange', () => {
  test('ends YESTERDAY, never today -- today can never honestly be "complete"', () => {
    const range = defaultDateRange(new Date(2026, 6, 23))
    assert.equal(range.dateTo, '2026-07-22')
  })
  test('spans exactly V0_DAY_RANGE (30) inclusive days', () => {
    const range = defaultDateRange(new Date(2026, 6, 23))
    const days = Math.round((new Date(`${range.dateTo}T00:00:00Z`).getTime() - new Date(`${range.dateFrom}T00:00:00Z`).getTime()) / 86400000) + 1
    assert.equal(days, V0_DAY_RANGE)
  })
  test('crosses a month boundary correctly', () => {
    const range = defaultDateRange(new Date(2026, 0, 3))
    assert.equal(range.dateTo, '2026-01-02')
    assert.equal(range.dateFrom, '2025-12-04')
  })
})

describe('buildSummaryQueryString', () => {
  test('marketplaceId/dateFrom/dateTo/asOf are always present, asOf mirrors dateTo', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({ dateFrom: '2026-06-24', dateTo: '2026-07-23' }))
    assert.equal(qs.get('marketplaceId'), MARKETPLACE_ID)
    assert.equal(qs.get('dateFrom'), '2026-06-24')
    assert.equal(qs.get('dateTo'), '2026-07-23')
    assert.equal(qs.get('asOf'), '2026-07-23')
  })
  test('workspaceId is never a query param', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({ dateFrom: '2026-06-24', dateTo: '2026-07-23' }))
    assert.equal(qs.has('workspaceId'), false)
  })
  // The RPC ANDs skuFilter and asinFilter together, so search is NEVER sent
  // as a server-side filter param here (it would incorrectly narrow, not
  // widen, results) -- it is applied entirely client-side by
  // filterRowsByTitle instead. See that describe block below.
  test('never sends a skuFilter or asinFilter param -- search stays client-side only', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({ dateFrom: '2026-06-24', dateTo: '2026-07-23' }))
    assert.equal(qs.has('skuFilter'), false)
    assert.equal(qs.has('asinFilter'), false)
  })
})

describe('filterRowsByTitle', () => {
  const rows = [
    { sku: 'SKU-A', asin: 'ASINA', productTitle: 'Blue Widget' },
    { sku: 'SKU-B', asin: 'ASINB', productTitle: 'Red Gadget' },
    { sku: 'SKU-C', asin: null, productTitle: null },
  ]
  test('matches on product title, case-insensitively', () => {
    assert.deepEqual(filterRowsByTitle(rows, 'blue').map(r => r.sku), ['SKU-A'])
  })
  test('matches on SKU', () => {
    assert.deepEqual(filterRowsByTitle(rows, 'SKU-B').map(r => r.sku), ['SKU-B'])
  })
  test('matches on ASIN', () => {
    assert.deepEqual(filterRowsByTitle(rows, 'asinb').map(r => r.sku), ['SKU-B'])
  })
  test('a null title/ASIN never throws and is simply not matched', () => {
    assert.deepEqual(filterRowsByTitle(rows, 'zzz').map(r => r.sku), [])
  })
  test('empty search returns every row unchanged', () => {
    assert.equal(filterRowsByTitle(rows, '').length, 3)
  })
})

// ---- page view-state derivation ----

describe('derivePageViewState', () => {
  test('loading takes precedence over everything else', () => {
    assert.deepEqual(derivePageViewState({ loading: true, status: 500, error: 'x', result: null }), { kind: 'loading' })
  })
  test('a 401 status yields unauthorized', () => {
    assert.deepEqual(derivePageViewState({ loading: false, status: 401, error: null, result: null }), { kind: 'unauthorized' })
  })
  test('a 5xx status yields unavailable (most plausibly: migration not applied yet)', () => {
    assert.deepEqual(derivePageViewState({ loading: false, status: 500, error: null, result: null }), { kind: 'unavailable' })
  })
  test('a network/fetch error (no status) yields error with the message', () => {
    assert.deepEqual(derivePageViewState({ loading: false, status: null, error: 'Network error', result: null }), { kind: 'error', message: 'Network error' })
  })
  test('invalid_parameters surfaces its reason', () => {
    const result: SkuPerformanceSummaryResult = { result: 'invalid_parameters', reason: 'date_from_after_date_to' }
    assert.deepEqual(derivePageViewState({ loading: false, status: 400, error: null, result }), { kind: 'error', message: 'date_from_after_date_to' })
  })
  test('currency_mismatch yields an explanatory error', () => {
    const result: SkuPerformanceSummaryResult = { result: 'currency_mismatch' }
    const state = derivePageViewState({ loading: false, status: 409, error: null, result })
    assert.equal(state.kind, 'error')
  })
  test('zero rows yields empty', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const result: SkuPerformanceSummaryResult = { ...fixture.getSummaryResponse, rows: [] }
    assert.deepEqual(derivePageViewState({ loading: false, status: 200, error: null, result }), { kind: 'empty' })
  })
  test('a null commonEffectiveDateFrom (no comparable history overlap) yields no_comparable_data, not a normal-looking table', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const result: SkuPerformanceSummaryResult = {
      ...fixture.getSummaryResponse,
      dateRange: { ...fixture.getSummaryResponse.dateRange, commonEffectiveDateFrom: null, commonEffectiveDateTo: null },
    }
    const state = derivePageViewState({ loading: false, status: 200, error: null, result })
    assert.equal(state.kind, 'no_comparable_data')
  })
  test('the real fixture (rows present, common range present) yields ready', () => {
    const state = derivePageViewState({ loading: false, status: 200, error: null, result: fixture.getSummaryResponse })
    assert.equal(state.kind, 'ready')
  })
})

// ---- chart view-state derivation ----

describe('deriveChartViewState', () => {
  test('loading takes precedence', () => {
    assert.deepEqual(deriveChartViewState({ loading: true, status: null, error: null, result: null }), { kind: 'loading' })
  })
  test('401 yields unauthorized', () => {
    assert.deepEqual(deriveChartViewState({ loading: false, status: 401, error: null, result: null }), { kind: 'unauthorized' })
  })
  test('5xx yields unavailable', () => {
    assert.deepEqual(deriveChartViewState({ loading: false, status: 500, error: null, result: null }), { kind: 'unavailable' })
  })
  test('an identity_conflict daily result never renders a chart -- surfaces the evidence instead', () => {
    const state = deriveChartViewState({ loading: false, status: 200, error: null, result: fixture.getDailyResponseIdentityConflictAsinMismatch })
    assert.equal(state.kind, 'identity_conflict')
  })
  test('a real success series with at least one trustworthy day yields ready', () => {
    const state = deriveChartViewState({ loading: false, status: 200, error: null, result: fixture.getDailyResponseSuccess })
    assert.equal(state.kind, 'ready')
  })
  test('a success series where every day is untrustworthy yields no_comparable_data, never an empty-looking chart', () => {
    const result: SkuPerformanceDailyResult = {
      result: 'success',
      sku: { canonicalSku: 'X', catalogSku: null, catalogAsin: null, productTitle: null, foundInCatalog: false, advertisedSkuEvidence: [] },
      days: [
        { date: '2026-07-01', sales: { value: null, coverageState: 'UNKNOWN' }, units: { value: null, coverageState: 'UNKNOWN' }, spend: { value: null, coverageState: 'BEFORE_HISTORY' }, attributedSales: { value: null, coverageState: 'BEFORE_HISTORY' }, acos: { state: 'unknown', value: null }, tacos: { state: 'unknown', value: null } },
      ],
    }
    const state = deriveChartViewState({ loading: false, status: 200, error: null, result })
    assert.equal(state.kind, 'no_comparable_data')
  })
})
