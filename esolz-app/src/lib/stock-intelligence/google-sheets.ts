import 'server-only'

import { createSign } from 'node:crypto'
import {
  buildWorksheetUrl,
  columnIndexToA1,
  DEFAULT_STOCK_SPREADSHEET_ID,
  findLastUsedColumn,
  getWorksheetGroup,
  getWorksheetHeaderRow,
  getWorksheetMode,
  isHiddenWorksheet,
  normalizeSheetRow,
} from './config'
import { selectWorksheetRowNumbers, uniqueSourceValues } from './data-operations'
import type { StockWorkbookMetadata, WorksheetData, WorksheetSummary } from './types'

const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
const METADATA_CACHE_MS = 5 * 60 * 1000
const VALUES_CACHE_MS = 60 * 1000
const CACHE_TTL_SECONDS = VALUES_CACHE_MS / 1000
const MAX_WORKSHEET_INDEX_ROWS = 5000

type CacheEntry<T> = { expiresAt: number; value: T }
const responseCache = new Map<string, CacheEntry<unknown>>()
let tokenCache: CacheEntry<string> | null = null

type GoogleSheetProperties = {
  sheetId: number
  title: string
  index: number
  hidden?: boolean
  gridProperties?: {
    rowCount?: number
    columnCount?: number
    frozenRowCount?: number
    frozenColumnCount?: number
  }
}

type GoogleMetadataResponse = {
  spreadsheetId: string
  properties?: { title?: string; locale?: string; timeZone?: string }
  sheets?: Array<{ properties: GoogleSheetProperties }>
}

type GoogleValuesResponse = {
  range?: string
  values?: Array<Array<string | number | boolean | null>>
}

type GoogleBatchValuesResponse = {
  valueRanges?: GoogleValuesResponse[]
}

export class StockSheetsError extends Error {
  constructor(
    readonly code: 'configuration_required' | 'permission_denied' | 'not_found' | 'upstream_error',
    readonly safeMessage: string,
    readonly status: number,
  ) {
    super(safeMessage)
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function getGoogleConfiguration() {
  const clientEmail = process.env.GOOGLE_STOCK_SHEETS_CLIENT_EMAIL
    ?? process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKeyRaw = process.env.GOOGLE_STOCK_SHEETS_PRIVATE_KEY
    ?? process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  const privateKey = privateKeyRaw?.replace(/\\n/g, '\n')
  const spreadsheetId = process.env.GOOGLE_STOCK_SHEETS_ID ?? DEFAULT_STOCK_SPREADSHEET_ID

  if (!clientEmail || !privateKey) {
    throw new StockSheetsError(
      'configuration_required',
      'Google Sheets access is not configured for this environment.',
      503,
    )
  }

  return { clientEmail, privateKey, spreadsheetId }
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value
  const { clientEmail, privateKey } = getGoogleConfiguration()
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: SHEETS_READONLY_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))
  const unsignedJwt = `${header}.${claims}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsignedJwt)
  signer.end()
  const assertion = `${unsignedJwt}.${signer.sign(privateKey, 'base64url')}`

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new StockSheetsError(
      response.status === 401 || response.status === 403 ? 'permission_denied' : 'upstream_error',
      'Google Sheets authentication failed. Check the server-side service account configuration.',
      503,
    )
  }

  const body = await response.json() as { access_token?: string; expires_in?: number }
  if (!body.access_token) {
    throw new StockSheetsError('upstream_error', 'Google Sheets authentication returned no access token.', 503)
  }
  tokenCache = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000,
  }
  return body.access_token
}

async function googleGet<T>(url: string): Promise<T> {
  const token = await getAccessToken()
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  })

  if (!response.ok) {
    if (response.status === 403) {
      throw new StockSheetsError(
        'permission_denied',
        'The configured Google service account cannot read the stock workbook.',
        503,
      )
    }
    if (response.status === 404) {
      throw new StockSheetsError('not_found', 'The configured stock workbook was not found.', 404)
    }
    throw new StockSheetsError('upstream_error', 'Google Sheets data is temporarily unavailable.', 503)
  }
  return response.json() as Promise<T>
}

async function cached<T>(key: string, ttlMs: number, refresh: boolean, loader: () => Promise<T>): Promise<T> {
  const current = responseCache.get(key) as CacheEntry<T> | undefined
  if (!refresh && current && current.expiresAt > Date.now()) return current.value
  const value = await loader()
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs })
  return value
}

function quoteSheetTitle(title: string): string {
  return `'${title.replaceAll("'", "''")}'`
}

async function readRange(
  spreadsheetId: string,
  sheetTitle: string,
  range: string,
  refresh: boolean,
): Promise<Array<Array<string | number | boolean | null>>> {
  const a1 = `${quoteSheetTitle(sheetTitle)}!${range}`
  const key = `values:${spreadsheetId}:${a1}`
  return cached(key, VALUES_CACHE_MS, refresh, async () => {
    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    })
    const response = await googleGet<GoogleValuesResponse>(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}?${params}`,
    )
    return response.values ?? []
  })
}

async function readRanges(
  spreadsheetId: string,
  sheetTitle: string,
  ranges: string[],
  refresh: boolean,
): Promise<Array<Array<string | number | boolean | null>>> {
  if (ranges.length === 0) return []
  const key = `batch:${spreadsheetId}:${sheetTitle}:${ranges.join('|')}`
  return cached(key, VALUES_CACHE_MS, refresh, async () => {
    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    })
    for (const range of ranges) {
      params.append('ranges', `${quoteSheetTitle(sheetTitle)}!${range}`)
    }
    const response = await googleGet<GoogleBatchValuesResponse>(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`,
    )
    return (response.valueRanges ?? []).map(valueRange => valueRange.values?.[0] ?? [])
  })
}

async function loadRawMetadata(spreadsheetId: string, refresh: boolean): Promise<GoogleMetadataResponse> {
  const fields = [
    'spreadsheetId',
    'properties(title,locale,timeZone)',
    'sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))',
  ].join(',')
  return cached(`metadata:${spreadsheetId}`, METADATA_CACHE_MS, refresh, () =>
    googleGet<GoogleMetadataResponse>(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}?includeGridData=false&fields=${encodeURIComponent(fields)}`,
    ),
  )
}

function buildSheetSummary(properties: GoogleSheetProperties, lastRebuilt: string | null): WorksheetSummary {
  return {
    sheetId: properties.sheetId,
    title: properties.title,
    index: properties.index,
    rowCount: properties.gridProperties?.rowCount ?? 1,
    columnCount: properties.gridProperties?.columnCount ?? 1,
    frozenRowCount: properties.gridProperties?.frozenRowCount ?? 0,
    frozenColumnCount: properties.gridProperties?.frozenColumnCount ?? 0,
    group: getWorksheetGroup(properties.title),
    lastRebuilt,
  }
}

function parseRunHealthFreshness(rows: Array<Array<string | number | boolean | null>>): Map<string, string> {
  const values = rows.map(row => row.map(value => value === null ? '' : String(value)))
  const headerIndex = values.findIndex(row => row[0] === 'Tab' && row[1] === 'Last Rebuilt')
  if (headerIndex < 0) return new Map()
  return new Map(
    values.slice(headerIndex + 1)
      .filter(row => Boolean(row[0]) && Boolean(row[1]))
      .map(row => [row[0], row[1]]),
  )
}

export async function getStockWorkbookMetadata(refresh = false): Promise<StockWorkbookMetadata> {
  const { spreadsheetId } = getGoogleConfiguration()
  const raw = await loadRawMetadata(spreadsheetId, refresh)
  const properties = raw.sheets?.map(sheet => sheet.properties) ?? []
  const runHealthTitle = properties.find(sheet => sheet.title === 'Run Health' && !isHiddenWorksheet(sheet.title, sheet.hidden))?.title
  const todayTitle = properties.find(sheet => sheet.title === 'Today' && !isHiddenWorksheet(sheet.title, sheet.hidden))?.title
  const [runHealthRows, todayRows] = await Promise.all([
    runHealthTitle ? readRange(spreadsheetId, runHealthTitle, 'A1:G250', refresh) : Promise.resolve([]),
    todayTitle ? readRange(spreadsheetId, todayTitle, 'A1:A2', refresh) : Promise.resolve([]),
  ])
  const freshness = parseRunHealthFreshness(runHealthRows)
  const visibleProperties = properties.filter(sheet => !isHiddenWorksheet(sheet.title, sheet.hidden))
  const hiddenSheetCount = properties.length - visibleProperties.length

  return {
    status: 'ready',
    spreadsheetId,
    spreadsheetTitle: raw.properties?.title ?? 'Amazon Stock Tracker',
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
    locale: raw.properties?.locale ?? 'unknown',
    timeZone: raw.properties?.timeZone ?? 'unknown',
    visibleSheetCount: visibleProperties.length,
    hiddenSheetCount,
    worksheets: visibleProperties
      .map(sheet => buildSheetSummary(sheet, freshness.get(sheet.title) ?? null))
      .sort((left, right) => left.index - right.index),
    sourceRefreshLabel: todayRows[0]?.[0] ? String(todayRows[0][0]) : null,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
  }
}

type GetWorksheetInput = {
  title: string
  page: number
  pageSize: number
  search: string
  brand: string
  category: string
  sortColumn: number | null
  sortDirection: 'asc' | 'desc' | null
  refresh: boolean
}

function columnValues(
  rows: Array<Array<string | number | boolean | null>>,
): Array<string | null> {
  return rows.map(row => row[0] === null || row[0] === undefined ? null : String(row[0]))
}

function lastNonEmptyRow(rows: Array<Array<string | number | boolean | null>>, headerRow: number): number {
  for (let index = rows.length - 1; index >= headerRow; index -= 1) {
    if (rows[index]?.some(value => value !== null && value !== undefined && String(value).trim() !== '')) {
      return index + 1
    }
  }
  return headerRow
}

export async function getStockWorksheet(input: GetWorksheetInput): Promise<WorksheetData> {
  const metadata = await getStockWorkbookMetadata(input.refresh)
  const sheet = metadata.worksheets.find(candidate => candidate.title === input.title)
  if (!sheet) throw new StockSheetsError('not_found', 'Worksheet not found.', 404)

  const mode = getWorksheetMode(sheet.title)
  const maxGridColumn = columnIndexToA1(Math.max(0, sheet.columnCount - 1))
  if (mode === 'today' || mode === 'run_health') {
    const maxRows = Math.min(sheet.rowCount, mode === 'today' ? 400 : 300)
    const rawRows = await readRange(
      metadata.spreadsheetId,
      sheet.title,
      `A1:${maxGridColumn}${maxRows}`,
      input.refresh,
    )
    const width = findLastUsedColumn(rawRows, 1)
    const rows = rawRows.map(row => normalizeSheetRow(row, width))
    return {
      status: 'ready',
      mode,
      sheet,
      spreadsheetUrl: metadata.spreadsheetUrl,
      worksheetUrl: buildWorksheetUrl(metadata.spreadsheetId, sheet.sheetId),
      preambleRows: [],
      headers: [],
      rows,
      rowNumbers: rows.map((_, index) => index + 1),
      page: 1,
      pageSize: rows.length,
      totalRows: rows.length,
      filteredRows: rows.length,
      totalPages: 1,
      search: '',
      brand: '',
      category: '',
      availableBrands: [],
      availableCategories: [],
      sourceRefreshLabel: sheet.lastRebuilt ?? metadata.sourceRefreshLabel,
      fetchedAt: new Date().toISOString(),
      completeness: 'complete_worksheet',
      warning: rows.length === maxRows
        ? `Display is bounded to the first ${maxRows} source rows.`
        : null,
    }
  }

  const headerRow = getWorksheetHeaderRow(sheet.title)
  const headerRaw = await readRange(
    metadata.spreadsheetId,
    sheet.title,
    `A1:${maxGridColumn}${headerRow}`,
    input.refresh,
  )
  const usedColumnCount = findLastUsedColumn(headerRaw, 1)
  const lastColumn = columnIndexToA1(usedColumnCount - 1)
  const preambleRows = headerRaw.slice(0, Math.max(0, headerRow - 1))
    .map(row => normalizeSheetRow(row, usedColumnCount))
  const headers = normalizeSheetRow(headerRaw[headerRow - 1] ?? [], usedColumnCount)
  const firstDataRow = headerRow + 1

  const indexLastRow = Math.min(sheet.rowCount, headerRow + MAX_WORKSHEET_INDEX_ROWS)
  const firstColumns = await readRange(
    metadata.spreadsheetId,
    sheet.title,
    `A1:B${indexLastRow}`,
    input.refresh,
  )
  const lastDataRow = lastNonEmptyRow(firstColumns, headerRow)
  const indexBoundReached = lastDataRow === indexLastRow && indexLastRow < sheet.rowCount
  const totalRows = Math.max(0, lastDataRow - headerRow)
  const brandIndex = headers.findIndex(header => header?.trim().toLocaleLowerCase() === 'brand')
  const categoryIndex = headers.findIndex(header => {
    const normalized = header?.trim().toLocaleLowerCase()
    return normalized === 'custom category' || normalized === 'category'
  })

  const readDataColumn = async (columnIndex: number): Promise<Array<string | null>> => {
    if (columnIndex < 0 || totalRows === 0) return []
    const column = columnIndexToA1(columnIndex)
    return columnValues(await readRange(
      metadata.spreadsheetId,
      sheet.title,
      `${column}${firstDataRow}:${column}${lastDataRow}`,
      input.refresh,
    ))
  }

  const [brandValues, categoryValues] = await Promise.all([
    readDataColumn(brandIndex),
    readDataColumn(categoryIndex),
  ])
  const searchWidth = Math.min(12, usedColumnCount)
  const searchRows = input.search && totalRows > 0
    ? await readRange(
        metadata.spreadsheetId,
        sheet.title,
        `A${firstDataRow}:${columnIndexToA1(searchWidth - 1)}${lastDataRow}`,
        input.refresh,
      ).then(rows => rows.map(row => normalizeSheetRow(row, searchWidth)))
    : undefined
  const sortValues = input.sortColumn !== null && input.sortColumn >= 0 && input.sortColumn < usedColumnCount
    ? await readDataColumn(input.sortColumn)
    : undefined

  const rowNumbers = selectWorksheetRowNumbers({
    firstDataRow,
    lastDataRow,
    searchRows,
    query: input.search,
    filters: [
      { values: brandValues, expected: input.brand },
      { values: categoryValues, expected: input.category },
    ],
    sortValues,
    sortDirection: input.sortDirection ?? undefined,
  })
  const filteredRows = rowNumbers.length
  const totalPages = Math.max(1, Math.ceil(filteredRows / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const selectedRowNumbers = rowNumbers.slice((page - 1) * input.pageSize, page * input.pageSize)
  let selectedRows: Array<Array<string | number | boolean | null>> = []

  const contiguous = selectedRowNumbers.every((rowNumber, index) =>
    index === 0 || rowNumber === selectedRowNumbers[index - 1] + 1,
  )
  if (selectedRowNumbers.length > 0 && contiguous) {
    selectedRows = await readRange(
      metadata.spreadsheetId,
      sheet.title,
      `A${selectedRowNumbers[0]}:${lastColumn}${selectedRowNumbers.at(-1)}`,
      input.refresh,
    )
  } else if (selectedRowNumbers.length > 0) {
    selectedRows = await readRanges(
      metadata.spreadsheetId,
      sheet.title,
      selectedRowNumbers.map(rowNumber => `A${rowNumber}:${lastColumn}${rowNumber}`),
      input.refresh,
    )
  }

  return {
    status: 'ready',
    mode,
    sheet,
    spreadsheetUrl: metadata.spreadsheetUrl,
    worksheetUrl: buildWorksheetUrl(metadata.spreadsheetId, sheet.sheetId),
    preambleRows,
    headers,
    rows: selectedRows.map(row => normalizeSheetRow(row, usedColumnCount)),
    rowNumbers: selectedRowNumbers,
    page,
    pageSize: input.pageSize,
    totalRows,
    filteredRows,
    totalPages,
    search: input.search,
    brand: input.brand,
    category: input.category,
    availableBrands: uniqueSourceValues(brandValues),
    availableCategories: uniqueSourceValues(categoryValues),
    sourceRefreshLabel: sheet.lastRebuilt ?? metadata.sourceRefreshLabel,
    fetchedAt: new Date().toISOString(),
    completeness: 'current_page',
    warning: indexBoundReached
      ? `This worksheet exceeds the ${MAX_WORKSHEET_INDEX_ROWS.toLocaleString()}-row read limit. Results are partial.`
      : null,
  }
}
