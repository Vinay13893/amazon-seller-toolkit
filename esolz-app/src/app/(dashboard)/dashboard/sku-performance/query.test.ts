import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  toDateString, defaultQueryState, buildSummaryQueryString, activeFilterCount,
  clampRangeToMaxDays, deriveViewState, paginationLabel,
  MARKETPLACE_ID, SORT_OPTIONS, BASIC_FILTERS,
} from './query'
import type { SkuPerformanceQueryState } from './query'
import type { SkuPerformanceSummaryResult } from '@/lib/sku-performance/types'
import { MAX_SUMMARY_RANGE_DAYS } from '@/lib/sku-performance/validation'

const fixturePath = fileURLToPath(new URL('../../../../lib/sku-performance/__fixtures__/p1c1-sample-responses.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  getSummaryResponse: SkuPerformanceSummaryResult
}

describe('toDateString', () => {
  test('formats a date as YYYY-MM-DD without a UTC shift', () => {
    assert.equal(toDateString(new Date(2026, 6, 23)), '2026-07-23')
  })
  test('pads single-digit month and day', () => {
    assert.equal(toDateString(new Date(2026, 0, 5)), '2026-01-05')
  })
})

describe('defaultQueryState', () => {
  test('defaults to a trailing-30-day range ending on the given date', () => {
    const state = defaultQueryState(new Date(2026, 6, 23))
    assert.equal(state.dateTo, '2026-07-23')
    assert.equal(state.dateFrom, '2026-06-24')
    assert.equal(state.asOf, '2026-07-23')
  })
  test('every basic filter defaults to false', () => {
    const state = defaultQueryState(new Date(2026, 6, 23))
    for (const { key } of BASIC_FILTERS) {
      assert.equal(state.filters[key], false, `expected ${key} to default false`)
    }
  })
  test('default sort is attention_desc', () => {
    assert.equal(defaultQueryState().sort, 'attention_desc')
  })
})

describe('buildSummaryQueryString', () => {
  const base: SkuPerformanceQueryState = defaultQueryState(new Date(2026, 6, 23))

  test('always includes marketplaceId, dateFrom, dateTo, asOf, sort, limit, offset', () => {
    const qs = new URLSearchParams(buildSummaryQueryString(base))
    assert.equal(qs.get('marketplaceId'), MARKETPLACE_ID)
    assert.equal(qs.get('dateFrom'), base.dateFrom)
    assert.equal(qs.get('dateTo'), base.dateTo)
    assert.equal(qs.get('asOf'), base.asOf)
    assert.equal(qs.get('sort'), 'attention_desc')
    assert.equal(qs.get('limit'), String(base.limit))
    assert.equal(qs.get('offset'), '0')
  })

  test('workspaceId is never a query param', () => {
    const qs = new URLSearchParams(buildSummaryQueryString(base))
    assert.equal(qs.has('workspaceId'), false)
  })

  test('an empty search adds neither skuFilter nor asinFilter', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({ ...base, search: '   ' }))
    assert.equal(qs.has('skuFilter'), false)
    assert.equal(qs.has('asinFilter'), false)
  })

  test('a non-empty search sets both skuFilter and asinFilter to the trimmed term', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({ ...base, search: '  SKU-1  ' }))
    assert.equal(qs.get('skuFilter'), 'SKU-1')
    assert.equal(qs.get('asinFilter'), 'SKU-1')
  })

  test('only active basic filters are sent, each as the literal string "true"', () => {
    const qs = new URLSearchParams(buildSummaryQueryString({
      ...base,
      filters: { ...base.filters, growingOnly: true, identityConflictOnly: true },
    }))
    assert.equal(qs.get('growingOnly'), 'true')
    assert.equal(qs.get('identityConflictOnly'), 'true')
    assert.equal(qs.has('decliningOnly'), false)
    assert.equal(qs.has('spendSpikeOnly'), false)
  })

  test('every documented sort value round-trips through the query string', () => {
    for (const { value } of SORT_OPTIONS) {
      const qs = new URLSearchParams(buildSummaryQueryString({ ...base, sort: value }))
      assert.equal(qs.get('sort'), value)
    }
  })
})

describe('activeFilterCount', () => {
  test('zero when nothing is active', () => {
    assert.equal(activeFilterCount(defaultQueryState().filters), 0)
  })
  test('counts exactly the active filters', () => {
    const filters = { ...defaultQueryState().filters, growingOnly: true, unmappedOnly: true }
    assert.equal(activeFilterCount(filters), 2)
  })
})

describe('clampRangeToMaxDays', () => {
  test('a range within the ceiling is returned unchanged', () => {
    assert.equal(clampRangeToMaxDays('2026-06-24', '2026-07-23'), '2026-06-24')
  })
  test('exactly 400 inclusive days is left unchanged (the accepted boundary)', () => {
    assert.equal(clampRangeToMaxDays('2025-06-16', '2026-07-20'), '2025-06-16')
  })
  test('a range over the ceiling is pulled forward to land on exactly MAX_SUMMARY_RANGE_DAYS', () => {
    const clampedFrom = clampRangeToMaxDays('2020-01-01', '2026-07-20')
    const inclusiveDays = Math.round((new Date('2026-07-20T00:00:00Z').getTime() - new Date(`${clampedFrom}T00:00:00Z`).getTime()) / 86400000) + 1
    assert.equal(inclusiveDays, MAX_SUMMARY_RANGE_DAYS)
  })
})

describe('deriveViewState', () => {
  test('loading takes precedence over everything else', () => {
    assert.deepEqual(deriveViewState({ loading: true, error: 'boom', result: null }), { kind: 'loading' })
  })
  test('an error message (not loading) yields the error state', () => {
    assert.deepEqual(deriveViewState({ loading: false, error: 'network down', result: null }), { kind: 'error', message: 'network down' })
  })
  test('no result and no error yields unknown, never a silent empty table', () => {
    assert.deepEqual(deriveViewState({ loading: false, error: null, result: null }), { kind: 'unknown' })
  })
  test('invalid_parameters result surfaces its reason as the error message', () => {
    const result: SkuPerformanceSummaryResult = { result: 'invalid_parameters', reason: 'dateFrom must not be after dateTo.' }
    assert.deepEqual(deriveViewState({ loading: false, error: null, result }), { kind: 'error', message: 'dateFrom must not be after dateTo.' })
  })
  test('currency_mismatch result surfaces an explanatory error, not a silent sum', () => {
    const result: SkuPerformanceSummaryResult = { result: 'currency_mismatch' }
    const state = deriveViewState({ loading: false, error: null, result })
    assert.equal(state.kind, 'error')
  })
  test('a success result with zero rows yields empty', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const result: SkuPerformanceSummaryResult = { ...fixture.getSummaryResponse, rows: [] }
    assert.deepEqual(deriveViewState({ loading: false, error: null, result }), { kind: 'empty' })
  })
  test('a success result with rows yields ready, carrying the result through unchanged', () => {
    const state = deriveViewState({ loading: false, error: null, result: fixture.getSummaryResponse })
    assert.equal(state.kind, 'ready')
    if (state.kind === 'ready') {
      assert.equal(state.result.rows.length, fixture.getSummaryResponse.result === 'success' ? fixture.getSummaryResponse.rows.length : -1)
    }
  })
})

describe('paginationLabel', () => {
  test('zero matching SKUs', () => {
    assert.equal(paginationLabel({ offset: 0, returnedSkuCount: 0, totalMatchingSkuCountAfterFilters: 0 }), '0 SKUs')
  })
  test('first page of a larger set', () => {
    assert.equal(paginationLabel({ offset: 0, returnedSkuCount: 10, totalMatchingSkuCountAfterFilters: 16 }), '1–10 of 16 SKUs')
  })
  test('a later page reflects the offset in the start index', () => {
    assert.equal(paginationLabel({ offset: 10, returnedSkuCount: 6, totalMatchingSkuCountAfterFilters: 16 }), '11–16 of 16 SKUs')
  })
  test('matches the real fixture pagination block', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    assert.equal(paginationLabel(fixture.getSummaryResponse.pagination), '1–10 of 16 SKUs')
  })
})
