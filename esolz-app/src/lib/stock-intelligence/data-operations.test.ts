import assert from 'node:assert/strict'
import test from 'node:test'
import { selectWorksheetRowNumbers, uniqueSourceValues } from './data-operations'

const searchRows = [
  ['SKU-SHARED-1', 'Product A', 'B0SHARED01'],
  ['SKU-SHARED-2', 'Product A', 'B0SHARED01'],
  ['SKU-OTHER', 'Product B', 'B0OTHER001'],
]

test('search keeps SKU-level rows separate when multiple SKUs share an ASIN', () => {
  const rows = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: 4,
    searchRows,
    query: 'B0SHARED01',
  })
  assert.deepEqual(rows, [2, 3])
})

test('brand and category filters operate on source values without inventing defaults', () => {
  const rows = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: 4,
    filters: [
      { values: ['EASY HOME', 'Liltoes', null], expected: 'Liltoes' },
      { values: ['EVA', 'Baby Play Mat', 'Unknown'], expected: 'Baby Play Mat' },
    ],
  })
  assert.deepEqual(rows, [3])
})

test('sorting uses numeric source values and keeps stable source row order for ties', () => {
  const rows = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: 5,
    sortValues: ['+10', '-2', '0', '+10'],
    sortDirection: 'desc',
  })
  assert.deepEqual(rows, [2, 5, 4, 3])
})

test('source filter options exclude unavailable cells without converting them to zero', () => {
  assert.deepEqual(uniqueSourceValues(['Liltoes', null, '', 'EASY HOME', 'Liltoes']), ['EASY HOME', 'Liltoes'])
})
