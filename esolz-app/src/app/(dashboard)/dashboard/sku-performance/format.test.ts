import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  formatMoney, formatCount, formatDate, formatDateTime,
  formatRatio, windowCoverageLabel, windowCoverageTone, selectedRangeCoverageWarning,
  sourceHealthLabel, sourceHealthTone,
  salesTrendLabel, spendTrendLabel, trendTone,
  mappingStateLabel, mappingStateTone, identityConflictReasonLabel,
  attentionChips,
} from './format'
import type { Ratio, SkuPerformanceSummaryResult, SkuPerformanceDailyResult } from '@/lib/sku-performance/types'

const fixturePath = fileURLToPath(new URL('../../../../lib/sku-performance/__fixtures__/p1c1-sample-responses.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  getSummaryResponse: SkuPerformanceSummaryResult
  getDailyResponseSuccess: SkuPerformanceDailyResult
  getDailyResponseIdentityConflictAsinMismatch: SkuPerformanceDailyResult
  getDailyResponseIdentityConflictRawSkuCollision: SkuPerformanceDailyResult
}

// Intl.NumberFormat's currencyDisplay:'code' inserts a non-breaking space
// (U+00A0) between the code and the number, not a plain space -- normalize
// before comparing so the test isn't coupled to that ICU whitespace detail.
const normalizeSpaces = (s: string) => s.replace(/ /g, ' ')

describe('formatMoney', () => {
  test('formats a value with a known currency code', () => {
    assert.equal(normalizeSpaces(formatMoney(1234.5, 'INR')), 'INR 1,234.50')
  })
  test('never invents a currency when currencyCode is null', () => {
    const result = formatMoney(1234.5, null)
    assert.match(result, /1,234\.50/)
    assert.match(result, /currency not confirmed/)
    assert.doesNotMatch(result, /₹|\$|INR|USD/)
  })
  test('falls back to a bare code+number for an unrecognized ISO code rather than dropping it silently', () => {
    const result = formatMoney(100, 'NOTREAL')
    assert.match(result, /NOTREAL/)
    assert.match(result, /100\.00/)
  })
  test('formats zero as an explicit zero, not blank', () => {
    assert.equal(normalizeSpaces(formatMoney(0, 'INR')), 'INR 0.00')
  })
})

describe('formatCount', () => {
  test('formats with thousands separators', () => {
    assert.equal(formatCount(12345), '12,345')
  })
  test('formats zero', () => {
    assert.equal(formatCount(0), '0')
  })
})

describe('formatDate', () => {
  test('formats a well-formed date string', () => {
    assert.equal(formatDate('2026-07-20'), new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date('2026-07-20T00:00:00Z')))
  })
  test('renders null as "Unknown", never blank or ₹0', () => {
    assert.equal(formatDate(null), 'Unknown')
  })
})

describe('formatDateTime', () => {
  test('formats a well-formed datetime string', () => {
    const result = formatDateTime('2026-07-21T00:00:00+00:00')
    assert.notEqual(result, 'Unknown')
  })
  test('renders null as "Unknown"', () => {
    assert.equal(formatDateTime(null), 'Unknown')
  })
})

describe('formatRatio', () => {
  test('normal state with a value renders a percentage', () => {
    const ratio: Ratio = { state: 'normal', value: 0.3145038167938931 }
    assert.deepEqual(formatRatio(ratio), { text: '31.5%', tone: 'neutral' })
  })
  test('normal state with a null value still renders Unknown, never 0%', () => {
    const ratio: Ratio = { state: 'normal', value: null }
    assert.deepEqual(formatRatio(ratio), { text: 'Unknown', tone: 'muted' })
  })
  test('not_applicable renders "No ad activity", not a ratio number', () => {
    const ratio: Ratio = { state: 'not_applicable', value: null }
    assert.deepEqual(formatRatio(ratio), { text: 'No ad activity', tone: 'muted' })
  })
  test('undefined renders an explicit word, never 0%', () => {
    const ratio: Ratio = { state: 'undefined', value: null }
    assert.deepEqual(formatRatio(ratio), { text: 'Undefined', tone: 'warning' })
  })
  test('undefined_high_risk renders a distinct danger-toned label', () => {
    const ratio: Ratio = { state: 'undefined_high_risk', value: null }
    assert.deepEqual(formatRatio(ratio), { text: 'Undefined — high risk', tone: 'danger' })
  })
  test('unknown renders "Unknown"', () => {
    const ratio: Ratio = { state: 'unknown', value: null }
    assert.deepEqual(formatRatio(ratio), { text: 'Unknown', tone: 'muted' })
  })
  test('zero is a real, displayable ratio value (not confused with null)', () => {
    const ratio: Ratio = { state: 'normal', value: 0 }
    assert.deepEqual(formatRatio(ratio), { text: '0.0%', tone: 'neutral' })
  })
})

describe('windowCoverageLabel / windowCoverageTone', () => {
  test('every WindowCoverageState maps to a distinct, non-empty label', () => {
    const states = ['complete', 'partial', 'before_history', 'source_not_complete', 'unknown'] as const
    const labels = states.map(windowCoverageLabel)
    assert.equal(new Set(labels).size, states.length)
    for (const l of labels) assert.ok(l.length > 0)
  })
  test('unknown coverage is never a positive tone', () => {
    assert.equal(windowCoverageTone('unknown'), 'danger')
  })
  test('complete coverage is positive', () => {
    assert.equal(windowCoverageTone('complete'), 'positive')
  })
})

describe('selectedRangeCoverageWarning', () => {
  test('null window -> no warning', () => {
    assert.equal(selectedRangeCoverageWarning(null), null)
  })
  test('both sources complete -> no warning', () => {
    const window = fixture.getSummaryResponse.result === 'success' ? fixture.getSummaryResponse.rows[0].selectedRange : null
    assert.ok(window)
    assert.equal(selectedRangeCoverageWarning(window), null)
  })
  test('a non-complete, non-before_history coverage state produces a warning naming the affected source', () => {
    const window = {
      sales: 0, units: 0, spend: 0, attributedSales: 0,
      salesCoverageState: 'partial' as const,
      adsCoverageState: 'complete' as const,
      acos: { state: 'unknown' as const, value: null },
      tacos: { state: 'unknown' as const, value: null },
    }
    const warning = selectedRangeCoverageWarning(window)
    assert.match(warning ?? '', /Sales/)
    assert.match(warning ?? '', /Partial/)
  })
})

describe('sourceHealthLabel / sourceHealthTone', () => {
  test('undefined status renders "Unknown"', () => {
    assert.equal(sourceHealthLabel(undefined), 'Unknown')
  })
  test('healthy is positive', () => {
    assert.equal(sourceHealthTone('healthy'), 'positive')
  })
  test('failed and auth_required are danger', () => {
    assert.equal(sourceHealthTone('failed'), 'danger')
    assert.equal(sourceHealthTone('auth_required'), 'danger')
  })
})

describe('trend labels and tone', () => {
  test('null sales trend renders an em dash placeholder, not a fabricated label', () => {
    assert.equal(salesTrendLabel(null), '—')
  })
  test('null spend trend renders an em dash placeholder', () => {
    assert.equal(spendTrendLabel(null), '—')
  })
  test('growing sales trend is positive-toned', () => {
    assert.equal(trendTone('growing'), 'positive')
  })
  test('declining trend is danger-toned', () => {
    assert.equal(trendTone('declining'), 'danger')
  })
  test('no_comparable_baseline is warning-toned, not silently neutral', () => {
    assert.equal(trendTone('no_comparable_baseline'), 'warning')
  })
  test('null trend is muted-toned', () => {
    assert.equal(trendTone(null), 'muted')
  })
})

describe('mappingStateLabel / mappingStateTone', () => {
  test('identity_conflict is danger-toned', () => {
    assert.equal(mappingStateTone('identity_conflict'), 'danger')
  })
  test('mapped is positive-toned', () => {
    assert.equal(mappingStateTone('mapped'), 'positive')
  })
  test('every MappingState has a distinct label', () => {
    const states = ['mapped', 'unmapped', 'identity_conflict', 'not_applicable'] as const
    const labels = states.map(mappingStateLabel)
    assert.equal(new Set(labels).size, states.length)
  })
})

describe('identityConflictReasonLabel', () => {
  test('raw_sku_collision has a human label', () => {
    assert.equal(identityConflictReasonLabel('raw_sku_collision'), 'Raw SKU collision')
  })
  test('advertised_asin_catalog_asin_mismatch has a human label', () => {
    assert.equal(identityConflictReasonLabel('advertised_asin_catalog_asin_mismatch'), 'Catalog ASIN vs. advertised ASIN mismatch')
  })
})

describe('attentionChips', () => {
  test('no flags set -> no chips', () => {
    const row = { flags: { salesDrop: false, spendSpike: false, noAttributedSales: false, tacosDeterioration: false, salesGrowingStableSpend: false, salesGrowingSpendFalls: false, mappingIncomplete: false, dataDelayed: false } }
    assert.deepEqual(attentionChips(row), [])
  })
  test('every flag set produces one chip per flag, in a stable order', () => {
    const row = { flags: { salesDrop: true, spendSpike: true, noAttributedSales: true, tacosDeterioration: true, salesGrowingStableSpend: true, salesGrowingSpendFalls: true, mappingIncomplete: true, dataDelayed: true } }
    const chips = attentionChips(row)
    assert.equal(chips.length, 8)
    assert.deepEqual(chips.map(c => c.key), [
      'salesDrop', 'spendSpike', 'noAttributedSales', 'tacosDeterioration',
      'salesGrowingStableSpend', 'salesGrowingSpendFalls', 'mappingIncomplete', 'dataDelayed',
    ])
  })
  test('an identity-conflict row only ever carries mappingIncomplete, never a sales/spend chip alongside it', () => {
    const conflictRow = fixture.getSummaryResponse.result === 'success'
      ? fixture.getSummaryResponse.rows.find(r => r.mappingState === 'identity_conflict')
      : undefined
    assert.ok(conflictRow)
    const chips = attentionChips(conflictRow!)
    assert.deepEqual(chips.map(c => c.key), ['mappingIncomplete'])
  })
})

// Fixture-driven tests: run every row and summary field from the real,
// committed RPC-response fixture through the formatting functions to prove
// they handle actual API output (not just hand-picked unit inputs).
describe('fixture: getSummaryResponse', () => {
  test('result is success', () => {
    assert.equal(fixture.getSummaryResponse.result, 'success')
  })

  test('every row formats without throwing, and every ratio/trend/mapping label is non-empty', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    for (const row of fixture.getSummaryResponse.rows) {
      assert.ok(mappingStateLabel(row.mappingState).length > 0)
      assert.ok(salesTrendLabel(row.salesTrend).length > 0)
      assert.ok(spendTrendLabel(row.spendTrend).length > 0)
      for (const chip of attentionChips(row)) {
        assert.ok(chip.label.length > 0)
      }
      if (row.selectedRange) {
        formatRatio(row.selectedRange.acos)
        formatRatio(row.selectedRange.tacos)
        selectedRangeCoverageWarning(row.selectedRange)
      }
      if (row.identityConflictEvidence) {
        for (const reason of row.identityConflictEvidence.reasons) {
          assert.ok(identityConflictReasonLabel(reason).length > 0)
        }
      }
    }
  })

  test('identity-conflict rows never carry a selectedRange window (Fix 4: no combined metrics from an ambiguous identity)', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const conflictRows = fixture.getSummaryResponse.rows.filter(r => r.mappingState === 'identity_conflict')
    assert.ok(conflictRows.length > 0)
    for (const row of conflictRows) {
      assert.equal(row.selectedRange, null)
      assert.equal(row.salesTrend, null)
      assert.ok(row.identityConflictEvidence)
      assert.ok(row.identityConflictEvidence!.reasons.length > 0)
    }
  })

  test('the ASIN-mismatch conflict row carries distinct catalogAsin and advertisedAsins evidence', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const row = fixture.getSummaryResponse.rows.find(r => r.sku === 'SKU-CONFLICT-ASIN')
    assert.ok(row?.identityConflictEvidence)
    assert.deepEqual(row!.identityConflictEvidence!.reasons, ['advertised_asin_catalog_asin_mismatch'])
    assert.equal(row!.identityConflictEvidence!.catalogAsin, 'ASINCONF-CATALOG')
    assert.deepEqual(row!.identityConflictEvidence!.advertisedAsins, ['ASINCONF-ADS'])
  })

  test('the raw-SKU-collision conflict row (DUP-1) carries multiple catalogRawSkus', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const row = fixture.getSummaryResponse.rows.find(r => r.sku === 'DUP-1')
    assert.ok(row?.identityConflictEvidence)
    assert.deepEqual(row!.identityConflictEvidence!.reasons, ['raw_sku_collision'])
    assert.ok(row!.identityConflictEvidence!.catalogRawSkus.length >= 2)
  })

  test('summary totals format without throwing and dates render honestly', () => {
    assert.ok(fixture.getSummaryResponse.result === 'success')
    if (fixture.getSummaryResponse.result !== 'success') return
    const { summary, currencyCode } = fixture.getSummaryResponse
    assert.equal(normalizeSpaces(formatMoney(summary.totalOrderedSales, currencyCode)), 'INR 10,800.00')
    assert.notEqual(formatDate(summary.salesLatestAcceptedCompleteDate), 'Unknown')
    formatRatio(summary.acos)
    formatRatio(summary.tacos)
  })
})

describe('fixture: getDailyResponseSuccess', () => {
  test('every day formats without throwing', () => {
    assert.ok(fixture.getDailyResponseSuccess.result === 'success')
    if (fixture.getDailyResponseSuccess.result !== 'success') return
    for (const day of fixture.getDailyResponseSuccess.days) {
      formatDate(day.date)
      formatRatio(day.acos)
      formatRatio(day.tacos)
    }
  })
})

describe('fixture: identity-conflict daily responses (either reason short-circuits identically)', () => {
  test('ASIN-mismatch daily conflict has no days array and full evidence', () => {
    const r = fixture.getDailyResponseIdentityConflictAsinMismatch
    assert.equal(r.result, 'identity_conflict')
    assert.ok(!('days' in r))
    if (r.result === 'identity_conflict') {
      assert.deepEqual(r.evidence.reasons, ['advertised_asin_catalog_asin_mismatch'])
      assert.ok(identityConflictReasonLabel(r.evidence.reasons[0]).length > 0)
    }
  })
  test('raw-SKU-collision daily conflict has no days array and full evidence', () => {
    const r = fixture.getDailyResponseIdentityConflictRawSkuCollision
    assert.equal(r.result, 'identity_conflict')
    assert.ok(!('days' in r))
    if (r.result === 'identity_conflict') {
      assert.deepEqual(r.evidence.reasons, ['raw_sku_collision'])
      assert.ok(identityConflictReasonLabel(r.evidence.reasons[0]).length > 0)
    }
  })
})
