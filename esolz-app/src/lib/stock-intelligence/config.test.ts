import assert from 'node:assert/strict'
import test from 'node:test'
import {
  columnIndexToA1,
  findLastUsedColumn,
  getWorksheetGroup,
  getWorksheetHeaderRow,
  isHiddenWorksheet,
  normalizeSheetRow,
  parseTodaySections,
} from './config'

test('known worksheets retain their operational groups and new visible tabs fall back safely', () => {
  assert.equal(getWorksheetGroup('Today'), 'Overview')
  assert.equal(getWorksheetGroup('Stock Reconciliation'), 'Inventory')
  assert.equal(getWorksheetGroup('Hub Planner'), 'Planning & Shipments')
  assert.equal(getWorksheetGroup('Claims to Check'), 'Claims & Fees')
  assert.equal(getWorksheetGroup('Support Cases'), 'Other Worksheets')
})

test('hidden and underscore-prefixed store tabs remain outside normal navigation', () => {
  assert.equal(isHiddenWorksheet('_Fee Store', false), true)
  assert.equal(isHiddenWorksheet('Visible but hidden by Google', true), true)
  assert.equal(isHiddenWorksheet('Stock Summary', false), false)
})

test('tab-specific header rows preserve Hub Planner and multirow state headers', () => {
  assert.equal(getWorksheetHeaderRow('Stock Reconciliation'), 1)
  assert.equal(getWorksheetHeaderRow('Hub Planner'), 3)
  assert.equal(getWorksheetHeaderRow('Sales by State'), 3)
})

test('wide column conversion and row normalization preserve empty cell positions', () => {
  assert.equal(columnIndexToA1(0), 'A')
  assert.equal(columnIndexToA1(25), 'Z')
  assert.equal(columnIndexToA1(371), 'NH')
  assert.deepEqual(normalizeSheetRow(['SKU-1', null, 'B0ASIN0001'], 5), [
    'SKU-1', null, 'B0ASIN0001', null, null,
  ])
  assert.equal(findLastUsedColumn([['A', null, 'C'], ['D']], 1), 3)
})

test('Hub Planner control rows retain their source column association', () => {
  const controls = normalizeSheetRow([
    'Hub switches',
    'Status | Backup hub',
    null,
    'Open',
    null,
    'Delhi',
  ], 8)

  assert.deepEqual(controls, [
    'Hub switches',
    'Status | Backup hub',
    null,
    'Open',
    null,
    'Delhi',
    null,
    null,
  ])
})

test('Today parser preserves source section order, counts, headings and values', () => {
  const sections = parseTodaySections([
    ['Today - source timestamp'],
    [],
    ['Running out in under 7 days  (2)'],
    ['ASIN', 'Product'],
    ['B0FIRST001', 'First'],
    ['B0SECOND02', 'Second'],
    [],
    ['Claims to check  (1)'],
    ['ASIN', 'Est. Value'],
    ['B0CLAIM001', '₹500'],
  ])

  assert.deepEqual(sections.map(section => section.heading), [
    'Running out in under 7 days  (2)',
    'Claims to check  (1)',
  ])
  assert.equal(sections[0].count, 2)
  assert.equal(sections[0].rows[1][0], 'B0SECOND02')
  assert.equal(sections[1].rows[0][1], '₹500')
})
