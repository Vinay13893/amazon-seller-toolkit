import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeRunId, resumeStartDate, recordDateCompleted, type RepairCheckpoint } from '../business-report-repair-checkpoint'

describe('computeRunId', () => {
  test('is a deterministic function of every scoping parameter', () => {
    const a = computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect')
    const b = computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect')
    assert.equal(a, b)
  })
  test('differs when any single parameter differs', () => {
    const base = computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect')
    assert.notEqual(computeRunId('ws-2', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect'), base)
    assert.notEqual(computeRunId('ws-1', 'ATVPDKIKX0DER', '2026-07-01', '2026-07-28', 'inspect'), base)
    assert.notEqual(computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-02', '2026-07-28', 'inspect'), base)
    assert.notEqual(computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-27', 'inspect'), base)
    assert.notEqual(computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'live'), base)
  })
})

describe('resumeStartDate', () => {
  const runId = computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect')

  test('no checkpoint at all -> start from the requested date', () => {
    assert.equal(resumeStartDate(null, runId, '2026-07-01'), '2026-07-01')
  })

  test('a checkpoint for a DIFFERENT run (different scope) is ignored -- starts from the requested date, never cross-contaminates', () => {
    const foreignCheckpoint: RepairCheckpoint = { runId: 'ws-2|A21TJRUUN4KGV|2026-07-01|2026-07-28|inspect', lastCompletedDate: '2026-07-10', completedDates: [] }
    assert.equal(resumeStartDate(foreignCheckpoint, runId, '2026-07-01'), '2026-07-01')
  })

  test('a matching checkpoint resumes the day AFTER the last completed date -- never re-processes it', () => {
    const checkpoint: RepairCheckpoint = { runId, lastCompletedDate: '2026-07-10', completedDates: ['2026-07-01', '2026-07-10'] }
    assert.equal(resumeStartDate(checkpoint, runId, '2026-07-01'), '2026-07-11')
  })
})

describe('recordDateCompleted', () => {
  const runId = computeRunId('ws-1', 'A21TJRUUN4KGV', '2026-07-01', '2026-07-28', 'inspect')

  test('first date recorded from no prior checkpoint', () => {
    const result = recordDateCompleted(null, runId, '2026-07-01')
    assert.deepEqual(result, { runId, lastCompletedDate: '2026-07-01', completedDates: ['2026-07-01'] })
  })

  test('appends to an existing matching checkpoint', () => {
    const existing: RepairCheckpoint = { runId, lastCompletedDate: '2026-07-01', completedDates: ['2026-07-01'] }
    const result = recordDateCompleted(existing, runId, '2026-07-02')
    assert.deepEqual(result, { runId, lastCompletedDate: '2026-07-02', completedDates: ['2026-07-01', '2026-07-02'] })
  })

  test('a checkpoint from a different run is discarded, not appended to', () => {
    const foreign: RepairCheckpoint = { runId: 'other-run', lastCompletedDate: '2026-06-01', completedDates: ['2026-06-01'] }
    const result = recordDateCompleted(foreign, runId, '2026-07-01')
    assert.deepEqual(result, { runId, lastCompletedDate: '2026-07-01', completedDates: ['2026-07-01'] })
  })

  test('re-recording the same date is idempotent -- never duplicates', () => {
    const existing: RepairCheckpoint = { runId, lastCompletedDate: '2026-07-02', completedDates: ['2026-07-01', '2026-07-02'] }
    const result = recordDateCompleted(existing, runId, '2026-07-02')
    assert.deepEqual(result.completedDates, ['2026-07-01', '2026-07-02'])
  })
})
