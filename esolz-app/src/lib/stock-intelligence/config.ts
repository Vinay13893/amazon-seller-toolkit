import type { WorksheetGroupName } from './types'

export const DEFAULT_STOCK_SPREADSHEET_ID = '1FDcw9w0EaJf4iUoSm53XV8J0VYjBR43v9u5jzRvtpg0'

export const WORKSHEET_GROUP_ORDER: WorksheetGroupName[] = [
  'Overview',
  'Inventory',
  'Planning & Shipments',
  'Sales & Demand',
  'Returns',
  'Claims & Fees',
  'Other Worksheets',
]

const GROUPED_TITLES: Record<Exclude<WorksheetGroupName, 'Other Worksheets'>, readonly string[]> = {
  Overview: ['Today', 'Run Health'],
  Inventory: [
    'Stock Summary',
    'Stock Reconciliation',
    'Stock by City',
    'FC by Location',
    'In-Transit Stock',
    'Stock by Date',
    'FC Stock Not Selling',
    'Stranded Stock',
  ],
  'Planning & Shipments': [
    'Hub Planner',
    'Packing List',
    'FBA Shipments',
    'FBA Shipment Items',
    'FBA Shipments by Date',
    'Shipments by Location',
    'Shipment Details',
    'Removal Orders',
    'Removals by Date',
    'EVA - Box Sales',
  ],
  'Sales & Demand': [
    'Sales by ASIN (Daily)',
    'Sales by Date (60 Days)',
    'Sales by Date (60 Days) (building)',
    'Sales by Category',
    'Sales Weekly & Trend',
    'Sales by State',
    'Sales by State %',
    'Sales by State Details',
  ],
  Returns: ['Returns by ASIN', 'Returns by Date'],
  'Claims & Fees': [
    'Claims to Check',
    'Claim Details',
    'Reimbursements',
    'Fee Check',
    'Fee Overcharges',
  ],
}

const TITLE_TO_GROUP = new Map<string, WorksheetGroupName>(
  Object.entries(GROUPED_TITLES).flatMap(([group, titles]) =>
    titles.map(title => [title, group as WorksheetGroupName] as const),
  ),
)

export function getWorksheetGroup(title: string): WorksheetGroupName {
  return TITLE_TO_GROUP.get(title) ?? 'Other Worksheets'
}

export function getWorksheetHeaderRow(title: string): number {
  if (title === 'Today') return 0
  if (title === 'Hub Planner') return 3
  if (title === 'Sales by State' || title === 'Sales by State %') return 3
  return 1
}

export function getWorksheetMode(title: string): 'table' | 'today' | 'run_health' {
  if (title === 'Today') return 'today'
  if (title === 'Run Health') return 'run_health'
  return 'table'
}

export function isHiddenWorksheet(title: string, hidden: boolean | undefined): boolean {
  return hidden === true || title.startsWith('_')
}

export function buildWorksheetUrl(spreadsheetId: string, sheetId: number): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${sheetId}`
}

export function columnIndexToA1(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

export function normalizeSheetRow(
  row: Array<string | number | boolean | null | undefined>,
  width: number,
): Array<string | null> {
  return Array.from({ length: width }, (_, index) => {
    const value = row[index]
    return value === null || value === undefined ? null : String(value)
  })
}

export function findLastUsedColumn(rows: Array<Array<unknown>>, fallback = 1): number {
  let last = Math.max(1, fallback)
  for (const row of rows) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      const value = row[index]
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        last = Math.max(last, index + 1)
        break
      }
    }
  }
  return last
}

export type TodaySection = {
  heading: string
  count: number | null
  headers: Array<string | null>
  rows: Array<Array<string | null>>
}

export function parseTodaySections(rows: Array<Array<string | null>>): TodaySection[] {
  const sections: TodaySection[] = []
  let index = 1

  while (index < rows.length) {
    const row = rows[index] ?? []
    const nonEmpty = row.filter((value): value is string => value !== null && value.trim() !== '')
    if (nonEmpty.length !== 1) {
      index += 1
      continue
    }

    const heading = nonEmpty[0]
    const countMatch = heading.match(/\((\d+)\)\s*$/)
    index += 1
    while (index < rows.length && (rows[index] ?? []).every(value => value === null || value.trim() === '')) {
      index += 1
    }

    const firstContent = rows[index] ?? []
    const firstContentValues = firstContent.filter((value): value is string => value !== null && value.trim() !== '')
    const hasHeader = firstContentValues.length > 1
    const headers = hasHeader ? firstContent : []
    if (hasHeader) index += 1

    const sectionRows: Array<Array<string | null>> = []
    while (index < rows.length) {
      const candidate = rows[index] ?? []
      const values = candidate.filter((value): value is string => value !== null && value.trim() !== '')
      if (values.length === 0) {
        index += 1
        break
      }
      if (values.length === 1 && /\(\d+\)\s*$/.test(values[0])) break
      sectionRows.push(candidate)
      index += 1
    }

    sections.push({
      heading,
      count: countMatch ? Number(countMatch[1]) : null,
      headers,
      rows: sectionRows,
    })
  }

  return sections
}
