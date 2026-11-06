import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findLastPopulatedSheetRow,
  selectWorksheetRowNumbers,
  uniqueSourceValues,
} from './data-operations'

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

test('row indexing retains continuation rows with blank identifying columns', () => {
  const rows = [
    ['Case ID', 'Subject', 'Message number', 'Message'],
    ['case-1', 'Subject', '1', 'Opening message'],
    [null, null, '2', 'Continuation message'],
  ]

  assert.equal(findLastPopulatedSheetRow(rows, 1), 3)
})

test('Case Messages can retain the live 363-row boundary and exact source positions', () => {
  const rows: Array<Array<string | null>> = Array.from({ length: 363 }, (_, index) => (
    index === 0
      ? ['Case ID', 'Subject', 'Message number', 'Message']
      : index >= 352
        ? [null, null, String(index), `Continuation ${index}`]
        : [`case-${index}`, 'Subject', '1', 'Message']
  ))

  const lastRow = findLastPopulatedSheetRow(rows, 1)
  const allRowNumbers = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: lastRow,
  })
  const matchingRowNumbers = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: lastRow,
    searchRows: rows.slice(1),
    query: 'continuation',
  })
  const sortedRowNumbers = selectWorksheetRowNumbers({
    firstDataRow: 2,
    lastDataRow: lastRow,
    sortValues: rows.slice(1).map(row => row[2]),
    sortDirection: 'desc',
  })

  assert.equal(lastRow, 363)
  assert.equal(allRowNumbers.length, 362)
  assert.deepEqual(allRowNumbers.slice(-11), [353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363])
  assert.deepEqual(matchingRowNumbers, [353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363])
  assert.equal(sortedRowNumbers.length, 362)
  assert.equal(sortedRowNumbers[0], 363)
})
