import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExactDayRun,
  latestExactDayRun,
  isSalesDayConfirmed,
  hasAnyCoveringRun,
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
