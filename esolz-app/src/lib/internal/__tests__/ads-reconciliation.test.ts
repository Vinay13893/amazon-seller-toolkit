import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareTotals, emptyTotals, reconciliationGate, validEvidence, shiftDate, profileDay, DATASETS, type EvidenceRun } from '../ads-reconciliation'

const today = '2026-11-08'
const now = Date.parse(`${today}T12:00:00Z`)
function run(day: string): EvidenceRun {
  const dates = [-12, -8, -3].map(offset => shiftDate(day, offset))
  return { status: 'success', finished_at: `${day}T10:00:00Z`, report_options: {
    version: 1, day, dates, passed: true,
    comparisons: DATASETS.flatMap(dataset => dates.map(date => ({ dataset, date, passed: true, maxDiscrepancy: 0.01 }))),
  } }
}
test('exactly 2% passes, above 2% and non-finite values fail', () => {
  const amazon = { ...emptyTotals(), spend: 100 }
  assert.equal(compareTotals('campaign', today, { ...amazon, spend: 102 }, amazon).passed, true)
  assert.equal(compareTotals('campaign', today, { ...amazon, spend: 102.01 }, amazon).passed, false)
  assert.equal(compareTotals('campaign', today, { ...amazon, clicks: NaN }, amazon).passed, false)
})
test('zero baseline cannot hide warehouse spend, and discrepancies cannot cancel across metrics', () => {
  assert.equal(compareTotals('campaign', today, { ...emptyTotals(), spend: 1 }, emptyTotals()).passed, false)
  assert.equal(compareTotals('campaign', today, { ...emptyTotals(), spend: 90, sales: 110 }, { ...emptyTotals(), spend: 100, sales: 100 }).passed, false)
})
test('seven distinct consecutive days are required and duplicate runs do not advance the streak', () => {
  const runs = Array.from({ length: 7 }, (_, i) => run(shiftDate(today, -i)))
  assert.equal(reconciliationGate(runs, today, now).ready, true)
  assert.equal(reconciliationGate(runs.slice(0, 6), today, now).ready, false)
  assert.equal(reconciliationGate(Array(7).fill(run(today)), today, now).consecutiveDays, 1)
})
test('latest failed, running or stale attempt blocks prior green results', () => {
  const runs = Array.from({ length: 7 }, (_, i) => run(shiftDate(today, -i)))
  for (const status of ['failed', 'running']) {
    assert.equal(reconciliationGate([{ ...run(today), status }, ...runs], today, now).ready, false)
  }
  assert.equal(reconciliationGate(runs, shiftDate(today, 2), now + 48 * 3600000).ready, false)
  assert.equal(reconciliationGate([runs[0], ...runs.slice(2)], today, now).consecutiveDays, 1)
})
test('incomplete, duplicate, recent-day and tampered evidence cannot pass', () => {
  const original = run(today).report_options!
  assert.equal(validEvidence(original), true)
  assert.equal(validEvidence({ ...original, comparisons: original.comparisons.slice(1) }), false)
  assert.equal(validEvidence({ ...original, dates: [today, today, today] }), false)
  assert.equal(validEvidence({ ...original, passed: false }), false)
  assert.equal(validEvidence({ ...original, version: 0 }), false)
})
test('profile day respects the marketplace timezone at a UTC boundary', () => {
  assert.equal(profileDay(new Date('2026-11-07T20:00:00Z'), 'Asia/Kolkata'), '2026-11-08')
})
