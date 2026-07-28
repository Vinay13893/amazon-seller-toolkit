import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  formatMoney, formatRatio, formatRatioIfNormal, dataStatus, isTrustworthyDayValue,
} from './format'
import type { Ratio, SkuPerformanceSummaryResult, SkuPerformanceDailyResult } from '@/lib/sku-performance/types'

const fixturePath = fileURLToPath(new URL('../../../../lib/sku-performance/__fixtures__/p1c1-sample-responses.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  getSummaryResponse: SkuPerformanceSummaryResult
  getDailyResponseSuccess: SkuPerformanceDailyResult
  getDailyResponseIdentityConflictAsinMismatch: SkuPerformanceDailyResult
}

// ---- unknown values are never rendered as zero ----

describe('unknown values are never rendered as a silent zero', () => {
  test('formatMoney never invents a currency and still shows the real number when currencyCode is null', () => {
    const result = formatMoney(1234.5, null)
    assert.match(result, /1,234\.50/)
    assert.match(result, /currency not confirmed/)
    assert.doesNotMatch(result, /₹|\$|INR|USD/)
  })
  test('a normal-state ratio with a null value renders "Unknown", never 0%', () => {
    const ratio: Ratio = { state: 'normal', value: null }
    assert.equal(formatRatio(ratio).text, 'Unknown')
  })
  test('an unknown-state ratio renders "Unknown", never 0%', () => {
    const ratio: Ratio = { state: 'unknown', value: null }
    assert.equal(formatRatio(ratio).text, 'Unknown')
  })
  test('zero is a real, displayable value and is NOT treated as unknown', () => {
    assert.equal(formatMoney(0, 'INR').includes('0.00'), true)
    const ratio: Ratio = { state: 'normal', value: 0 }
    assert.equal(formatRatio(ratio).text, '0.0%')
  })
})

// ---- identity-conflict suppression ----

describe('identity-conflict suppression', () => {
  test('an identity-conflict row never shows combined metrics -- dataStatus reports the conflict, not a coverage detail', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const row = fixture.getSummaryResponse.rows.find(r => r.mappingState === 'identity_conflict')
    assert.ok(row)
    assert.equal(row!.selectedRange, null)
    const status = dataStatus(row!)
    assert.equal(status.label, 'Identity conflict')
    assert.equal(status.tone, 'danger')
    assert.equal(status.detail, null)
  })
  test('a mapped row with complete coverage has no incomplete-data detail', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const row = fixture.getSummaryResponse.rows.find(r => r.mappingState === 'mapped')
    assert.ok(row)
    const status = dataStatus(row!)
    assert.equal(status.detail, null)
  })
  test('the daily RPC identity_conflict result carries evidence and no days array', () => {
    const r = fixture.getDailyResponseIdentityConflictAsinMismatch
    assert.equal(r.result, 'identity_conflict')
    assert.ok(!('days' in r))
  })
})

// ---- ratio-state rendering ----

describe('ratio-state rendering', () => {
  test('every RatioState renders a distinct, non-numeric label except normal', () => {
    const states: Ratio['state'][] = ['not_applicable', 'undefined', 'undefined_high_risk', 'unknown']
    for (const state of states) {
      const display = formatRatio({ state, value: null })
      assert.doesNotMatch(display.text, /%/)
    }
  })
  test('only state === normal ever renders a percentage', () => {
    const display = formatRatio({ state: 'normal', value: 0.155 })
    assert.equal(display.text, '15.5%')
  })
  test('formatRatioIfNormal blanks out every non-normal state (D\'s narrower per-day rule)', () => {
    assert.equal(formatRatioIfNormal({ state: 'not_applicable', value: null }), '')
    assert.equal(formatRatioIfNormal({ state: 'undefined', value: null }), '')
    assert.equal(formatRatioIfNormal({ state: 'undefined_high_risk', value: null }), '')
    assert.equal(formatRatioIfNormal({ state: 'unknown', value: null }), '')
    assert.equal(formatRatioIfNormal({ state: 'normal', value: 0.2 }), '20.0%')
  })
})

// ---- daily coverage / chart-gap helper ----

describe('isTrustworthyDayValue (chart must preserve gaps for the rest)', () => {
  test('REPORTED_VALUE and CONFIRMED_ZERO are trustworthy', () => {
    assert.equal(isTrustworthyDayValue('REPORTED_VALUE'), true)
    assert.equal(isTrustworthyDayValue('CONFIRMED_ZERO'), true)
  })
  test('BEFORE_HISTORY, SOURCE_NOT_COMPLETE, UNKNOWN are never trustworthy -- must never be plotted as zero', () => {
    assert.equal(isTrustworthyDayValue('BEFORE_HISTORY'), false)
    assert.equal(isTrustworthyDayValue('SOURCE_NOT_COMPLETE'), false)
    assert.equal(isTrustworthyDayValue('UNKNOWN'), false)
  })
  test('the real fixture daily series has at least one trustworthy and one non-trustworthy-shaped day to exercise both branches', () => {
    assert.ok(fixture.getDailyResponseSuccess.result === 'success')
    if (fixture.getDailyResponseSuccess.result !== 'success') return
    const states = fixture.getDailyResponseSuccess.days.map(d => d.sales.coverageState)
    assert.ok(states.includes('REPORTED_VALUE') || states.includes('CONFIRMED_ZERO'))
  })
})
