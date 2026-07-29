import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveLatestCompleteDate, safePercentChange, buildTodayCards, buildAttentionSections,
  buildSkuPerformanceDeepLink, calendarYesterday, toDateString, addDaysToDateString,
  selectBiggestSalesDeclines, selectHighSpendZeroAttributedSales,
} from './today-query'
import type { SkuPerformanceRow, SkuPerformanceSummaryTotals } from '@/lib/sku-performance/types'

function totals(overrides: Partial<SkuPerformanceSummaryTotals> = {}): SkuPerformanceSummaryTotals {
  return {
    totalOrderedSales: 0,
    totalUnits: 0,
    totalAdSpend: 0,
    totalAttributedSales: 0,
    acos: { value: null, state: 'unknown' },
    tacos: { value: null, state: 'unknown' },
    skusGrowing: 0,
    skusDeclining: 0,
    mappingCoverage: {
      bySkuCount: { mapped: 0, unmapped: 0, identityConflict: 0, mappedPct: null },
      bySpend: { mappedSpend: 0, unmappedSpend: 0, identityConflictSpend: 0, mappedSpendPct: null },
    },
    salesLatestDataDate: null,
    adsLatestDataDate: null,
    salesLatestAcceptedCompleteDate: null,
    adsLatestAcceptedCompleteDate: null,
    catalogLastSyncedAt: null,
    salesLastRunStatus: null,
    salesLastRunAt: null,
    salesLastRunRowsRejected: null,
    adsLastRunStatus: null,
    adsLastRunAt: null,
    adsLastRunRowsRejected: null,
    ...overrides,
  }
}

function row(overrides: Partial<SkuPerformanceRow> = {}): SkuPerformanceRow {
  const window = {
    sales: 0, units: 0, spend: 0, attributedSales: 0,
    salesCoverageState: 'complete' as const, adsCoverageState: 'complete' as const,
    acos: { value: null, state: 'not_applicable' as const },
    tacos: { value: null, state: 'not_applicable' as const },
  }
  return {
    sku: 'SKU-1',
    asin: 'ASIN1',
    productTitle: 'Widget',
    imageUrl: null,
    brand: 'Acme',
    category: null,
    mappingState: 'mapped',
    identityConflictEvidence: null,
    salesTrend: 'flat',
    spendTrend: 'flat',
    tacosBand: 'normal',
    lastSalesActivityDate: null,
    lastAdSpendActivityDate: null,
    lastAttributedSaleActivityDate: null,
    flags: {
      salesDrop: false, spendSpike: false, noAttributedSales: false, tacosDeterioration: false,
      salesGrowingStableSpend: false, salesGrowingSpendFalls: false, mappingIncomplete: false,
    },
    selectedRange: { ...window },
    yesterday: { ...window },
    trailingSevenDay: { ...window },
    priorSevenDay: { sales: 0, spend: 0, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'not_applicable' }, tacos: { value: null, state: 'not_applicable' } },
    trailingThirtyDay: { ...window },
    ...overrides,
  }
}

// ---------------------------------------------------------- date logic ---

describe('calendarYesterday / deriveLatestCompleteDate', () => {
  test('calendarYesterday never returns today', () => {
    const now = new Date(2026, 6, 29)
    assert.equal(calendarYesterday(now), '2026-07-28')
  })

  test('deriveLatestCompleteDate excludes incomplete "today" even if a source somehow claims it', () => {
    const now = new Date(2026, 6, 29) // today = 2026-07-29
    const summary = totals({ salesLatestAcceptedCompleteDate: '2026-07-29', adsLatestAcceptedCompleteDate: '2026-07-29' })
    // Never today -- clamps to calendar-yesterday instead.
    assert.equal(deriveLatestCompleteDate(summary, now), '2026-07-28')
  })

  test('deriveLatestCompleteDate uses the EARLIER of sales/ads accepted-complete dates', () => {
    const now = new Date(2026, 6, 29)
    const summary = totals({ salesLatestAcceptedCompleteDate: '2026-07-28', adsLatestAcceptedCompleteDate: '2026-07-25' })
    assert.equal(deriveLatestCompleteDate(summary, now), '2026-07-25')
  })

  test('deriveLatestCompleteDate returns null when either source has never had an accepted-complete run', () => {
    const now = new Date(2026, 6, 29)
    assert.equal(deriveLatestCompleteDate(totals({ salesLatestAcceptedCompleteDate: '2026-07-28', adsLatestAcceptedCompleteDate: null }), now), null)
    assert.equal(deriveLatestCompleteDate(totals({ salesLatestAcceptedCompleteDate: null, adsLatestAcceptedCompleteDate: '2026-07-28' }), now), null)
  })

  test('addDaysToDateString / toDateString round-trip across a month boundary', () => {
    assert.equal(addDaysToDateString('2026-07-01', -1), '2026-06-30')
    assert.equal(toDateString(new Date(2026, 6, 1)), '2026-07-01')
  })
})

// ------------------------------------------------------- safe percent ---

describe('safePercentChange', () => {
  test('normal case: positive and negative change', () => {
    assert.equal(safePercentChange(150, 100), 50)
    assert.equal(safePercentChange(50, 100), -50)
  })

  test('zero baseline, zero current -- no change, never NaN/Infinity', () => {
    assert.equal(safePercentChange(0, 0), 0)
  })

  test('zero baseline, nonzero current -- unmeasurable as a percentage, returns null (never Infinity)', () => {
    assert.equal(safePercentChange(500, 0), null)
  })

  test('never returns Infinity or NaN for any finite input', () => {
    for (const [current, baseline] of [[100, 0], [0, 0], [-50, 0], [0, 100]] as const) {
      const result = safePercentChange(current, baseline)
      if (result !== null) assert.ok(Number.isFinite(result))
    }
  })
})

// ------------------------------------------------------------- cards ---

describe('buildTodayCards', () => {
  test('unknown ACOS/TACOS state is never rendered as a fabricated zero or number', () => {
    const latest = totals({ acos: { value: null, state: 'unknown' } })
    const previous = totals()
    const prior7 = totals()
    const cards = buildTodayCards(latest, previous, prior7)
    const acos = cards.ratio.find(m => m.key === 'acos')!
    assert.equal(acos.latestDay.value, null)
    assert.equal(acos.latestDay.state, 'unknown')
  })

  test('raw metrics use the RPC-supplied totals directly, and prior-7-day average divides by 7', () => {
    const latest = totals({ totalOrderedSales: 1000 })
    const previous = totals({ totalOrderedSales: 800 })
    const prior7 = totals({ totalOrderedSales: 7000 })
    const cards = buildTodayCards(latest, previous, prior7)
    const sales = cards.raw.find(m => m.key === 'sales')!
    assert.equal(sales.latestDay, 1000)
    assert.equal(sales.previousDay, 800)
    assert.equal(sales.prior7DayAvg, 1000)
    assert.equal(sales.changeVsPreviousDayPct, 25)
    assert.equal(sales.changeVsPrior7AvgPct, 0)
  })

  test('a zero previous-day baseline never produces Infinity/NaN in the card', () => {
    const latest = totals({ totalAdSpend: 500 })
    const previous = totals({ totalAdSpend: 0 })
    const prior7 = totals({ totalAdSpend: 0 })
    const cards = buildTodayCards(latest, previous, prior7)
    const spend = cards.raw.find(m => m.key === 'spend')!
    assert.equal(spend.changeVsPreviousDayPct, null)
  })
})

// -------------------------------------------------------- attention rows ---

describe('attention sections -- identity conflicts excluded', () => {
  test('an identity_conflict row never appears in any attention section', () => {
    const conflictRow = row({
      mappingState: 'identity_conflict',
      salesTrend: null, spendTrend: null, tacosBand: null,
      selectedRange: null, yesterday: null, trailingSevenDay: null, priorSevenDay: null, trailingThirtyDay: null,
      flags: { salesDrop: false, spendSpike: false, noAttributedSales: false, tacosDeterioration: false, salesGrowingStableSpend: false, salesGrowingSpendFalls: false, mappingIncomplete: true },
    })
    const sections = buildAttentionSections([conflictRow])
    assert.equal(sections.salesDeclines.length, 0)
    assert.equal(sections.salesGrowth.length, 0)
    assert.equal(sections.spendUpSalesFlat.length, 0)
    assert.equal(sections.highSpendZeroSales.length, 0)
  })

  test('a mapped declining-sales row DOES appear, with no combined-conclusion caveat needed', () => {
    const decliningRow = row({
      salesTrend: 'declining',
      selectedRange: { sales: 500, units: 5, spend: 0, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'not_applicable' }, tacos: { value: null, state: 'not_applicable' } },
      priorSevenDay: { sales: 1400, spend: 0, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'not_applicable' }, tacos: { value: null, state: 'not_applicable' } },
    })
    const sections = buildAttentionSections([decliningRow])
    assert.equal(sections.salesDeclines.length, 1)
    assert.equal(sections.salesDeclines[0].sku, 'SKU-1')
  })
})

describe('selectBiggestSalesDeclines -- factual explanation text matches the underlying numbers', () => {
  test('reason text cites the exact computed percentage', () => {
    // prior7 daily avg = 1400/7 = 200; latest day = 116 -> decline of 42%
    const decliningRow = row({
      salesTrend: 'declining',
      selectedRange: { sales: 116, units: 1, spend: 0, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'not_applicable' }, tacos: { value: null, state: 'not_applicable' } },
      priorSevenDay: { sales: 1400, spend: 0, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'not_applicable' }, tacos: { value: null, state: 'not_applicable' } },
    })
    const [result] = selectBiggestSalesDeclines([decliningRow])
    assert.equal(result.latestDayValue, 116)
    assert.equal(result.comparisonBaseline, 200)
    assert.equal(Math.round(result.changePercent!), -42)
    assert.equal(result.reason, 'Sales declined 42% versus the previous 7-day daily average.')
  })
})

describe('selectHighSpendZeroAttributedSales -- factual explanation text matches the underlying numbers', () => {
  test('reason text cites the exact spend amount', () => {
    const zeroSalesRow = row({
      flags: { salesDrop: false, spendSpike: false, noAttributedSales: true, tacosDeterioration: false, salesGrowingStableSpend: false, salesGrowingSpendFalls: false, mappingIncomplete: false },
      selectedRange: { sales: 0, units: 0, spend: 1240, attributedSales: 0, salesCoverageState: 'complete', adsCoverageState: 'complete', acos: { value: null, state: 'undefined' }, tacos: { value: null, state: 'undefined_high_risk' } },
    })
    const [result] = selectHighSpendZeroAttributedSales([zeroSalesRow])
    assert.equal(result.adSpend, 1240)
    assert.equal(result.reason, '1,240 spend with 0 attributed sales on the latest complete day.')
  })
})

// -------------------------------------------------------------- deep link ---

describe('buildSkuPerformanceDeepLink', () => {
  test('contains the exact SKU and a 30-day range ending at latestCompleteDate', () => {
    const url = buildSkuPerformanceDeepLink({ sku: 'SKU-42', latestCompleteDate: '2026-07-28' })
    const [path, query] = url.split('?')
    const params = new URLSearchParams(query)
    assert.equal(path, '/dashboard/sku-performance')
    assert.equal(params.get('sku'), 'SKU-42')
    assert.equal(params.get('dateTo'), '2026-07-28')
    assert.equal(params.get('dateFrom'), '2026-06-29')
  })

  test('URL-encodes a SKU with special characters', () => {
    const url = buildSkuPerformanceDeepLink({ sku: 'SKU/WITH SPACE', latestCompleteDate: '2026-07-28' })
    const params = new URLSearchParams(url.split('?')[1])
    assert.equal(params.get('sku'), 'SKU/WITH SPACE')
  })
})
