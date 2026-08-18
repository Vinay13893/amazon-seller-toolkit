import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExactDayRun,
  latestExactDayRun,
  isSalesDayConfirmed,
  hasAnyCoveringRun,
  classifySalesDayCoverage,
  latestSalesAuthoritativeCompleteDate,
  type SalesRunRecord,
} from '../business-report-sales-coverage-authority'

const DAY = '2026-07-20'
const OTHER_DAY = '2026-07-21'

function run(overrides: Partial<SalesRunRecord>): SalesRunRecord {
  return {
    id: 'run-default',
    dateFrom: DAY,
    dateTo: DAY,
    status: 'success',
    rowsRejected: 0,
    startedAt: '2026-07-21T03:30:00.000Z',
    createdAt: '2026-07-21T03:30:00.000Z',
    ...overrides,
  }
}

describe('isExactDayRun', () => {
  test('true only when dateFrom === dateTo === targetDate', () => {
    assert.equal(isExactDayRun(run({ dateFrom: DAY, dateTo: DAY }), DAY), true)
  })
  test('false for a multi-day range even if it contains targetDate', () => {
    assert.equal(isExactDayRun(run({ dateFrom: '2026-07-15', dateTo: '2026-07-28' }), DAY), false)
  })
  test('false for an exact-day run scoped to a DIFFERENT date', () => {
    assert.equal(isExactDayRun(run({ dateFrom: OTHER_DAY, dateTo: OTHER_DAY }), DAY), false)
  })
})

describe('THE core defect this fix closes: multi-day success never certifies a day', () => {
  test('a 14-day pre-fix multi-day success run does not confirm any day within it', () => {
    const runs = [run({ id: 'old-multiday', dateFrom: '2026-07-15', dateTo: '2026-07-28', status: 'success', rowsRejected: 0 })]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })

  test('11 separate old multi-day success runs (the exact live-DB count found for 2026-07-20) still never confirm the day', () => {
    const runs = Array.from({ length: 11 }, (_, i) =>
      run({ id: `old-multiday-${i}`, dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'success', rowsRejected: 0, startedAt: `2026-07-${10 + i}T03:30:00.000Z` }))
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
    assert.equal(latestExactDayRun(runs, DAY), null)
  })
})

describe('exact-day success does certify a day', () => {
  test('a single exact-day success run confirms the day', () => {
    const runs = [run({ id: 'exact-1', status: 'success', rowsRejected: 0 })]
    assert.equal(isSalesDayConfirmed(runs, DAY), true)
  })

  test('an exact-day run with rows_rejected > 0 does NOT confirm, even with status success', () => {
    const runs = [run({ id: 'exact-1', status: 'success', rowsRejected: 3 })]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })
})

describe('no exact-day attempt at all', () => {
  test('never confirms the day, regardless of any multi-day activity', () => {
    const runs = [
      run({ id: 'old-multiday', dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'success', rowsRejected: 0 }),
      run({ id: 'unrelated-day', dateFrom: OTHER_DAY, dateTo: OTHER_DAY, status: 'success', rowsRejected: 0 }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })
  test('empty run list never confirms', () => {
    assert.equal(isSalesDayConfirmed([], DAY), false)
  })
})

describe('the crux of the fix: never fall back to an older success once a newer exact-day attempt exists', () => {
  test('old exact-day success + newer exact-day RUNNING = not confirmed (no fallback)', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T03:30:00.000Z' }),
      run({ id: 'attempt-2', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T03:30:00.000Z' }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
    assert.equal(latestExactDayRun(runs, DAY)?.id, 'attempt-2')
  })

  test('old exact-day success + newer exact-day FAILED = not confirmed (attempt-1 does not become authoritative again)', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T03:30:00.000Z' }),
      run({ id: 'attempt-2', status: 'failed', rowsRejected: 0, startedAt: '2026-07-22T03:30:00.000Z' }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })

  test('old exact-day success + newer exact-day PARTIAL_SUCCESS = not confirmed', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T03:30:00.000Z' }),
      run({ id: 'attempt-2', status: 'partial_success', rowsRejected: 2, startedAt: '2026-07-22T03:30:00.000Z' }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })

  test('old exact-day success + newer exact-day SUCCESS = confirmed again', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T03:30:00.000Z' }),
      run({ id: 'attempt-2', status: 'success', rowsRejected: 0, startedAt: '2026-07-22T03:30:00.000Z' }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), true)
  })

  test('old MULTI-day success + newer exact-day RUNNING = not confirmed (both reasons independently block it)', () => {
    const runs = [
      run({ id: 'old-multiday', dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'success', rowsRejected: 0, startedAt: '2026-07-05T03:30:00.000Z' }),
      run({ id: 'attempt-1', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T03:30:00.000Z' }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })

  test('the full attempt-1(success)->attempt-2(running)->attempt-2 fails->attempt-3(success) scenario', () => {
    // Stage 1: only attempt-1 exists, succeeded.
    const stage1 = [run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T00:00:00.000Z' })]
    assert.equal(isSalesDayConfirmed(stage1, DAY), true, 'stage 1: attempt-1 success -> confirmed')

    // Stage 2: attempt-2 begins (running) -- must go incomplete immediately.
    const stage2 = [...stage1, run({ id: 'attempt-2', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    assert.equal(isSalesDayConfirmed(stage2, DAY), false, 'stage 2: attempt-2 running -> NOT confirmed, no fallback to attempt-1')

    // Stage 3: attempt-2 fails -- must stay incomplete, attempt-1 must not become authoritative again.
    const stage3 = [stage1[0], run({ id: 'attempt-2', status: 'failed', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    assert.equal(isSalesDayConfirmed(stage3, DAY), false, 'stage 3: attempt-2 failed -> still NOT confirmed')

    // Stage 4: attempt-3 succeeds -- confirmed again.
    const stage4 = [...stage3, run({ id: 'attempt-3', status: 'success', rowsRejected: 0, startedAt: '2026-07-23T00:00:00.000Z' })]
    assert.equal(isSalesDayConfirmed(stage4, DAY), true, 'stage 4: attempt-3 success -> confirmed again')
  })
})

describe('deterministic tie-break', () => {
  test('two exact-day runs with the identical startedAt instant resolve deterministically by id DESC', () => {
    const sameInstant = '2026-07-22T03:30:00.000Z'
    const runsA = [
      run({ id: 'aaa', status: 'failed', startedAt: sameInstant }),
      run({ id: 'zzz', status: 'success', rowsRejected: 0, startedAt: sameInstant }),
    ]
    // id DESC -> 'zzz' > 'aaa' lexicographically -> 'zzz' wins -> confirmed
    assert.equal(latestExactDayRun(runsA, DAY)?.id, 'zzz')
    assert.equal(isSalesDayConfirmed(runsA, DAY), true)

    // Same inputs in reverse array order must produce the identical result -- order of insertion never matters, only the sort.
    const runsB = [runsA[1], runsA[0]]
    assert.equal(latestExactDayRun(runsB, DAY)?.id, 'zzz')
    assert.equal(isSalesDayConfirmed(runsB, DAY), isSalesDayConfirmed(runsA, DAY))
  })

  test('finished_at is never consulted -- a still-running latest attempt (no finished_at in this model at all) is still correctly picked by startedAt', () => {
    const runs = [
      run({ id: 'old', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T00:00:00.000Z' }),
      run({ id: 'new-running', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' }),
    ]
    assert.equal(latestExactDayRun(runs, DAY)?.id, 'new-running')
  })

  test('createdAt breaks a startedAt tie BEFORE falling through to the id tie-break', () => {
    const sameStartedAt = '2026-07-22T03:30:00.000Z'
    const runs = [
      run({ id: 'zzz-inserted-first', status: 'failed', startedAt: sameStartedAt, createdAt: '2026-07-22T03:29:00.000Z' }),
      run({ id: 'aaa-inserted-second', status: 'success', rowsRejected: 0, startedAt: sameStartedAt, createdAt: '2026-07-22T03:31:00.000Z' }),
    ]
    // Even though 'zzz' > 'aaa' lexicographically (which would win an id-only tie-break),
    // createdAt DESC correctly picks the genuinely-later-inserted row instead.
    assert.equal(latestExactDayRun(runs, DAY)?.id, 'aaa-inserted-second')
    assert.equal(isSalesDayConfirmed(runs, DAY), true)
  })

  test('id is the tie-break of last resort: only reached when BOTH startedAt and createdAt are exactly equal', () => {
    const sameInstant = '2026-07-22T03:30:00.000Z'
    const runs = [
      run({ id: 'aaa', status: 'failed', startedAt: sameInstant, createdAt: sameInstant }),
      run({ id: 'zzz', status: 'success', rowsRejected: 0, startedAt: sameInstant, createdAt: sameInstant }),
    ]
    assert.equal(latestExactDayRun(runs, DAY)?.id, 'zzz')
  })

  test('in this codebase\'s actual write paths startedAt and createdAt are always equal (both default to the same now()) -- the createdAt tie-break is a documented no-op today, not a source of disagreement', () => {
    const runs = [run({ id: 'typical-row', status: 'success', rowsRejected: 0, startedAt: '2026-07-22T03:30:00.000Z', createdAt: '2026-07-22T03:30:00.000Z' })]
    assert.equal(isSalesDayConfirmed(runs, DAY), true)
  })
})

describe('latestSalesAuthoritativeCompleteDate (the narrow freshness-badge fix)', () => {
  test('null when no exact-day run exists at all', () => {
    assert.equal(latestSalesAuthoritativeCompleteDate([]), null)
  })

  test('null when only old multi-day success runs exist -- this is the exact bug being closed: a multi-day success must never produce a "fresh" freshness date', () => {
    const runs = [run({ id: 'old-multiday', dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'success', rowsRejected: 0 })]
    assert.equal(latestSalesAuthoritativeCompleteDate(runs), null)
  })

  test('the MAX date among confirmed exact-day dates, ignoring unconfirmed ones', () => {
    const runs = [
      run({ id: 'day-1', dateFrom: '2026-07-18', dateTo: '2026-07-18', status: 'success', rowsRejected: 0 }),
      run({ id: 'day-2', dateFrom: '2026-07-19', dateTo: '2026-07-19', status: 'failed' }), // not confirmed, must not count
      run({ id: 'day-3', dateFrom: '2026-07-20', dateTo: '2026-07-20', status: 'success', rowsRejected: 0 }),
    ]
    assert.equal(latestSalesAuthoritativeCompleteDate(runs), '2026-07-20')
  })

  test('a newer exact-day attempt that is running/failed does not advance the freshness date past the last CONFIRMED one, and does not fall back either if that newer attempt itself never succeeds', () => {
    const runs = [
      run({ id: 'day-1-success', dateFrom: '2026-07-18', dateTo: '2026-07-18', status: 'success', rowsRejected: 0 }),
      run({ id: 'day-2-attempt-1-success', dateFrom: '2026-07-19', dateTo: '2026-07-19', status: 'success', rowsRejected: 0, startedAt: '2026-07-20T00:00:00.000Z' }),
      run({ id: 'day-2-attempt-2-running', dateFrom: '2026-07-19', dateTo: '2026-07-19', status: 'running', startedAt: '2026-07-21T00:00:00.000Z' }),
    ]
    // 2026-07-19's LATEST attempt is now 'running' -- that date is no longer confirmed at all (no fallback to attempt-1) -- so the freshness date is 2026-07-18, not 2026-07-19.
    assert.equal(latestSalesAuthoritativeCompleteDate(runs), '2026-07-18')
  })
})

describe('date isolation: runs scoped to a different date never influence this date\'s determination', () => {
  test('an exact-day success for a DIFFERENT date does not confirm targetDate', () => {
    const runs = [run({ id: 'other-day-success', dateFrom: OTHER_DAY, dateTo: OTHER_DAY, status: 'success', rowsRejected: 0 })]
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })
  test('mixed dates: only the target date\'s own exact-day runs matter', () => {
    const runs = [
      run({ id: 'target-day', dateFrom: DAY, dateTo: DAY, status: 'success', rowsRejected: 0 }),
      run({ id: 'other-day', dateFrom: OTHER_DAY, dateTo: OTHER_DAY, status: 'failed', rowsRejected: 0 }),
    ]
    assert.equal(isSalesDayConfirmed(runs, DAY), true)
    assert.equal(isSalesDayConfirmed(runs, OTHER_DAY), false)
  })
})

describe('hasAnyCoveringRun (deliberately unchanged semantics)', () => {
  test('a multi-day run DOES count as "some attempt happened" even though it cannot confirm', () => {
    const runs = [run({ id: 'old-multiday', dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'failed' })]
    assert.equal(hasAnyCoveringRun(runs, DAY), true)
    assert.equal(isSalesDayConfirmed(runs, DAY), false)
  })
  test('no run at all covering the date -> false', () => {
    assert.equal(hasAnyCoveringRun([], DAY), false)
  })
})

// ============================================================
// Daily raw-value-leak fix: classifySalesDayCoverage
// ============================================================
// The pre-merge review found the FIRST version of this migration's
// `get_sku_performance_daily` checked "raw row exists -> REPORTED_VALUE"
// BEFORE checking authority at all -- so a physically-present row
// (corrupted, or a crash-mixed correct+stale state) still leaked as a
// trustworthy REPORTED_VALUE regardless of the exact-day authority. Every
// scenario A-H below proves the CORRECTED ordering: authority (and
// before-history) is always checked first; a raw value is NEVER read or
// exposed unless the exact-day authoritative run for that date actually
// succeeded.

describe('classifySalesDayCoverage — the daily raw-value-leak fix, all required scenarios', () => {
  test('A. old corrupted raw row, literally no run of any kind covering the date -> UNKNOWN, sales/units NULL (raw value never leaks)', () => {
    const result = classifySalesDayCoverage({ runs: [], targetDate: DAY, isBeforeHistory: false, rawValue: 999999 })
    assert.deepEqual(result, { state: 'UNKNOWN', value: null })
  })

  test('the known historical case: old corrupted raw row + ONLY old multi-day successes covering it -> SOURCE_NOT_COMPLETE, sales/units NULL', () => {
    const runs = [run({ id: 'old-multiday', dateFrom: '2026-07-01', dateTo: '2026-07-28', status: 'success', rowsRejected: 0 })]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 72902971.71 })
    assert.deepEqual(result, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('B. old exact-day success, newer exact-day RUNNING, raw row physically present -> SOURCE_NOT_COMPLETE, NULL (no leak, no fallback to the old success)', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T00:00:00.000Z' }),
      run({ id: 'attempt-2', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' }),
    ]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 176305 })
    assert.deepEqual(result, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('C. old exact-day success, newer exact-day FAILED, raw row physically present -> SOURCE_NOT_COMPLETE, NULL', () => {
    const runs = [
      run({ id: 'attempt-1', status: 'success', rowsRejected: 0, startedAt: '2026-07-21T00:00:00.000Z' }),
      run({ id: 'attempt-2', status: 'failed', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' }),
    ]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 176305 })
    assert.deepEqual(result, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('D. crash mid-upsert (latest exact-day attempt still running, partially-applied raw row present) -> SOURCE_NOT_COMPLETE, NULL', () => {
    const runs = [run({ id: 'crashed-attempt', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 42000 })
    assert.deepEqual(result, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('E. crash after upsert, before stale-delete (correct+stale rows coexist; latest attempt still running) -> SOURCE_NOT_COMPLETE, NULL regardless of which value the row holds', () => {
    const runs = [run({ id: 'crashed-attempt', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    // Whichever value happens to be physically stored for this SKU right now (correct-new or stale-old), it must not leak.
    const resultWithStaleValue = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 999999 })
    const resultWithCorrectValue = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 4200 })
    assert.deepEqual(resultWithStaleValue, { state: 'SOURCE_NOT_COMPLETE', value: null })
    assert.deepEqual(resultWithCorrectValue, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('F. crash mid stale-delete (latest attempt still running/failed either way) -> SOURCE_NOT_COMPLETE, NULL', () => {
    const runsStillRunning = [run({ id: 'crashed-attempt', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    const runsCleanedUpFailed = [run({ id: 'crashed-attempt', status: 'failed', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    assert.deepEqual(classifySalesDayCoverage({ runs: runsStillRunning, targetDate: DAY, isBeforeHistory: false, rawValue: 42000 }), { state: 'SOURCE_NOT_COMPLETE', value: null })
    assert.deepEqual(classifySalesDayCoverage({ runs: runsCleanedUpFailed, targetDate: DAY, isBeforeHistory: false, rawValue: 42000 }), { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('G. writes complete but crash before run marked success -> latest exact-day run stays running/failed -> SOURCE_NOT_COMPLETE, NULL even though the underlying data is actually already correct', () => {
    const runs = [run({ id: 'crashed-before-success-write', status: 'running', rowsRejected: 0, startedAt: '2026-07-22T00:00:00.000Z' })]
    // The DB row is now genuinely correct (writes completed) -- but the run was never marked success, so it must still be hidden.
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 4200 })
    assert.deepEqual(result, { state: 'SOURCE_NOT_COMPLETE', value: null })
  })

  test('H (a). clean exact-day success, raw row present -> REPORTED_VALUE, the real value', () => {
    const runs = [run({ id: 'clean-success', status: 'success', rowsRejected: 0 })]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: 4200 })
    assert.deepEqual(result, { state: 'REPORTED_VALUE', value: 4200 })
  })

  test('H (b). clean exact-day success, raw row ABSENT -> CONFIRMED_ZERO, value 0', () => {
    const runs = [run({ id: 'clean-success', status: 'success', rowsRejected: 0 })]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: false, rawValue: null })
    assert.deepEqual(result, { state: 'CONFIRMED_ZERO', value: 0 })
  })

  test('before_history takes priority over everything else, including a raw row and/or an authoritative success', () => {
    const runs = [run({ id: 'clean-success', status: 'success', rowsRejected: 0 })]
    const result = classifySalesDayCoverage({ runs, targetDate: DAY, isBeforeHistory: true, rawValue: 4200 })
    assert.deepEqual(result, { state: 'BEFORE_HISTORY', value: null })
  })

  test('zero is a real, distinguishable value: CONFIRMED_ZERO (0) is never confused with UNKNOWN/SOURCE_NOT_COMPLETE (null)', () => {
    const confirmedZero = classifySalesDayCoverage({ runs: [run({ status: 'success', rowsRejected: 0 })], targetDate: DAY, isBeforeHistory: false, rawValue: null })
    const unknown = classifySalesDayCoverage({ runs: [], targetDate: DAY, isBeforeHistory: false, rawValue: null })
    assert.equal(confirmedZero.value, 0)
    assert.equal(unknown.value, null)
    assert.notEqual(confirmedZero.state, unknown.state)
  })
})
