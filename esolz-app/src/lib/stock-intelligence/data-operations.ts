export type FilterColumn = {
  values: Array<string | null>
  expected: string
}

type SelectRowsInput = {
  firstDataRow: number
  lastDataRow: number
  searchRows?: Array<Array<string | null>>
  query?: string
  filters?: FilterColumn[]
  sortValues?: Array<string | null>
  sortDirection?: 'asc' | 'desc'
}

export function findLastPopulatedSheetRow(
  rows: Array<Array<string | number | boolean | null>>,
  fallbackRow: number,
): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.some(value => value !== null && value !== undefined && String(value).trim() !== '')) {
      return index + 1
    }
  }
  return fallbackRow
}

function compareSourceValues(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null || left.trim() === '') return 1
  if (right === null || right.trim() === '') return -1

  const leftNumber = Number(left.replace(/[₹,%+]/g, '').replace(/,/g, ''))
  const rightNumber = Number(right.replace(/[₹,%+]/g, '').replace(/,/g, ''))
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

export function selectWorksheetRowNumbers(input: SelectRowsInput): number[] {
  const rowNumbers = Array.from(
    { length: Math.max(0, input.lastDataRow - input.firstDataRow + 1) },
    (_, index) => input.firstDataRow + index,
  )
  const query = input.query?.trim().toLocaleLowerCase() ?? ''

  const filtered = rowNumbers.filter((rowNumber, index) => {
    if (query) {
      const row = input.searchRows?.[index] ?? []
      if (!row.some(value => value?.toLocaleLowerCase().includes(query))) return false
    }

    return (input.filters ?? []).every(filter => {
      if (!filter.expected) return true
      return (filter.values[index] ?? '') === filter.expected
    })
  })

  if (!input.sortValues || !input.sortDirection) return filtered
  const multiplier = input.sortDirection === 'asc' ? 1 : -1
  return filtered.sort((leftRow, rightRow) => {
    const leftIndex = leftRow - input.firstDataRow
    const rightIndex = rightRow - input.firstDataRow
    const comparison = compareSourceValues(
      input.sortValues?.[leftIndex] ?? null,
      input.sortValues?.[rightIndex] ?? null,
    )
    return comparison === 0 ? leftRow - rightRow : comparison * multiplier
  })
}

export function uniqueSourceValues(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
}
