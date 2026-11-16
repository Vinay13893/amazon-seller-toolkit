import test from 'node:test'
import assert from 'node:assert/strict'
import { recentAnalysisRange, buildPreset, autoBaselineFor, daysInRange } from './date-range'

test('recent default follows India midnight, including UTC previous day', () => {
  const range = recentAnalysisRange(new Date('2026-11-11T19:00:00Z'))
  assert.deepEqual(range, { startDate: '2026-10-29', endDate: '2026-11-11' })
  assert.equal(daysInRange(range), 14)
  assert.deepEqual(autoBaselineFor(range), { startDate: '2026-10-15', endDate: '2026-10-28' })
})

test('current preset is single period; historical investigation stays explicitly available', () => {
  const preset = buildPreset('last14_single', new Date('2026-11-12T08:00:00Z'))!
  assert.equal(preset.mode, 'single')
  assert.equal(preset.rangeA.endDate, '2026-11-11')
  assert.equal(buildPreset('june15_single_default')!.rangeA.startDate, '2026-06-15')
})
