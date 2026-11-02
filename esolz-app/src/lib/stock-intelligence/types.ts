export type WorksheetGroupName =
  | 'Overview'
  | 'Inventory'
  | 'Planning & Shipments'
  | 'Sales & Demand'
  | 'Returns'
  | 'Claims & Fees'
  | 'Other Worksheets'

export type WorksheetSummary = {
  sheetId: number
  title: string
  index: number
  rowCount: number
  columnCount: number
  frozenRowCount: number
  frozenColumnCount: number
  group: WorksheetGroupName
  lastRebuilt: string | null
}

export type StockWorkbookMetadata = {
  status: 'ready'
  spreadsheetId: string
  spreadsheetTitle: string
  spreadsheetUrl: string
  locale: string
  timeZone: string
  visibleSheetCount: number
  hiddenSheetCount: number
  worksheets: WorksheetSummary[]
  sourceRefreshLabel: string | null
  fetchedAt: string
  cacheTtlSeconds: number
}

export type WorksheetMode = 'table' | 'today' | 'run_health'

export type WorksheetData = {
  status: 'ready'
  mode: WorksheetMode
  sheet: WorksheetSummary
  spreadsheetUrl: string
  worksheetUrl: string
  preambleRows: Array<Array<string | null>>
  headers: Array<string | null>
  rows: Array<Array<string | null>>
  rowNumbers: number[]
  page: number
  pageSize: number
  totalRows: number
  filteredRows: number
  totalPages: number
  search: string
  brand: string
  category: string
  availableBrands: string[]
  availableCategories: string[]
  sourceRefreshLabel: string | null
  fetchedAt: string
  completeness: 'complete_worksheet' | 'current_page'
  warning: string | null
}

export type StockSheetsFailure = {
  status: 'configuration_required' | 'unavailable'
  message: string
}

export type StockWorkbookMetadataResponse = StockWorkbookMetadata | StockSheetsFailure
export type WorksheetDataResponse = WorksheetData | StockSheetsFailure
