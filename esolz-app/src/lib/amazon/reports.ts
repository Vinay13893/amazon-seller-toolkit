import { createDecipheriv } from 'crypto'
import { gunzipSync } from 'zlib'

const SPAPI_EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
const REPORTS_API_BASE = '/reports/2021-06-30'

export const BRAND_ANALYTICS_REPORT_TYPES = [
  'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
  'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
  'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT',
] as const

export type BrandAnalyticsReportType = (typeof BRAND_ANALYTICS_REPORT_TYPES)[number]

export interface CreateAmazonReportInput {
  reportType: string
  marketplaceIds: string[]
  dataStartTime?: string
  dataEndTime?: string
  reportOptions?: Record<string, unknown>
}

export interface CreateAmazonReportResult {
  reportId: string
}

export interface AmazonReportStatusResult {
  reportId: string
  reportType: string
  processingStatus: string
  reportDocumentId?: string
  dataStartTime?: string
  dataEndTime?: string
  createdTime?: string
  processingStartTime?: string
  processingEndTime?: string
}

export interface AmazonReportDocumentEncryptionDetails {
  standard: string
  initializationVector: string
  key: string
  digest?: string
}

export interface AmazonReportDocumentResult {
  reportDocumentId: string
  url: string
  compressionAlgorithm?: string
  encryptionDetails?: AmazonReportDocumentEncryptionDetails
}

export interface ParsedBrandAnalyticsReport {
  rows: Record<string, unknown>[]
  fieldNames: string[]
  format: 'json' | 'jsonl' | 'csv' | 'tsv' | 'unknown'
}

function safeHttpError(status: number, bodyText?: string): Error {
  if (process.env.NODE_ENV !== 'production' && bodyText) {
    return new Error(`SP-API reports request failed with HTTP ${status}: ${bodyText.slice(0, 600)}`)
  }
  return new Error(`SP-API reports request failed with HTTP ${status}`)
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeKey(key)] = value
    }
    return normalized
  })
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-\/]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .toLowerCase()
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>)
      }
    } catch {
      return []
    }
  }
  return rows
}

function parseDelimited(text: string, delimiter: ',' | '\t'): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []

  const headers = splitCsvLine(lines[0], delimiter).map((h) => normalizeKey(h.trim()))
  if (headers.length === 0) return []

  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i], delimiter)
    const row: Record<string, unknown> = {}
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? null
    })
    rows.push(row)
  }

  return rows
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (!inQuotes && ch === delimiter) {
      result.push(current)
      current = ''
      continue
    }

    current += ch
  }

  result.push(current)
  return result
}

function unwrapRows(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
  }

  if (!parsed || typeof parsed !== 'object') return []

  const obj = parsed as Record<string, unknown>
  const knownArrayKeys = ['rows', 'data', 'reportData', 'records', 'items', 'search_queries', 'search_terms']
  for (const key of knownArrayKeys) {
    const candidate = obj[key]
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    }
  }

  for (const candidate of Object.values(obj)) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    }
  }

  return [obj]
}

function decodeEncryptedContent(
  encryptedBytes: Uint8Array,
  encryptionDetails: AmazonReportDocumentEncryptionDetails,
): Buffer {
  const key = Buffer.from(encryptionDetails.key, 'base64')
  const iv = Buffer.from(encryptionDetails.initializationVector, 'base64')

  if (iv.length !== 16) {
    throw new Error('Unsupported report document encryption IV length')
  }

  const algorithm =
    key.length === 32 ? 'aes-256-cbc'
      : key.length === 24 ? 'aes-192-cbc'
      : key.length === 16 ? 'aes-128-cbc'
      : ''

  if (!algorithm) {
    throw new Error('Unsupported report document encryption key length')
  }

  const decipher = createDecipheriv(algorithm, key, iv)
  return Buffer.concat([decipher.update(encryptedBytes), decipher.final()])
}

export async function createAmazonReport(
  accessToken: string,
  input: CreateAmazonReportInput,
  endpoint = SPAPI_EU_ENDPOINT,
): Promise<CreateAmazonReportResult> {
  const payload: Record<string, unknown> = {
    reportType: input.reportType,
    marketplaceIds: input.marketplaceIds,
  }
  if (input.dataStartTime) payload.dataStartTime = input.dataStartTime
  if (input.dataEndTime) payload.dataEndTime = input.dataEndTime
  if (input.reportOptions) payload.reportOptions = input.reportOptions

  const res = await fetch(`${endpoint}${REPORTS_API_BASE}/reports`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw safeHttpError(res.status, body)
  }

  const data = await res.json() as Partial<CreateAmazonReportResult>
  if (!data.reportId) throw new Error('SP-API did not return reportId')
  return { reportId: data.reportId }
}

export async function getAmazonReport(
  accessToken: string,
  reportId: string,
  endpoint = SPAPI_EU_ENDPOINT,
): Promise<AmazonReportStatusResult> {
  const res = await fetch(`${endpoint}${REPORTS_API_BASE}/reports/${encodeURIComponent(reportId)}`, {
    method: 'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw safeHttpError(res.status, body)
  }

  const data = await res.json() as Partial<AmazonReportStatusResult>
  if (!data.reportId || !data.processingStatus || !data.reportType) {
    throw new Error('Unexpected SP-API report status response')
  }

  return {
    reportId: data.reportId,
    reportType: data.reportType,
    processingStatus: data.processingStatus,
    reportDocumentId: data.reportDocumentId,
    dataStartTime: data.dataStartTime,
    dataEndTime: data.dataEndTime,
    createdTime: data.createdTime,
    processingStartTime: data.processingStartTime,
    processingEndTime: data.processingEndTime,
  }
}

export async function getAmazonReportDocument(
  accessToken: string,
  reportDocumentId: string,
  endpoint = SPAPI_EU_ENDPOINT,
): Promise<AmazonReportDocumentResult> {
  const res = await fetch(`${endpoint}${REPORTS_API_BASE}/documents/${encodeURIComponent(reportDocumentId)}`, {
    method: 'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw safeHttpError(res.status, body)
  }

  const data = await res.json() as Partial<AmazonReportDocumentResult>
  if (!data.reportDocumentId || !data.url) {
    throw new Error('Unexpected SP-API report document response')
  }

  return {
    reportDocumentId: data.reportDocumentId,
    url: data.url,
    compressionAlgorithm: data.compressionAlgorithm,
    encryptionDetails: data.encryptionDetails,
  }
}

export async function downloadAmazonReportDocument(
  document: AmazonReportDocumentResult,
): Promise<string> {
  const res = await fetch(document.url, {
    method: 'GET',
    headers: {
      'content-type': 'application/octet-stream',
    },
  })

  if (!res.ok) {
    throw new Error(`Report document download failed with HTTP ${res.status}`)
  }

  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer())

  if (document.encryptionDetails) {
    bytes = decodeEncryptedContent(bytes, document.encryptionDetails)
  }

  if (document.compressionAlgorithm?.toUpperCase() === 'GZIP') {
    bytes = gunzipSync(bytes)
  }

  return Buffer.from(bytes).toString('utf8')
}

export function parseAmazonReportDocument(
  rawDocumentContent: string,
): ParsedBrandAnalyticsReport {
  const trimmed = rawDocumentContent.trim()
  if (!trimmed) return { rows: [], fieldNames: [], format: 'unknown' }

  try {
    const parsed = JSON.parse(trimmed)
    const rows = normalizeRows(unwrapRows(parsed))
    const fieldNames = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
    return { rows, fieldNames, format: 'json' }
  } catch {
    // Fall through to jsonl/delimited parsing.
  }

  const jsonlRows = normalizeRows(parseJsonLines(trimmed))
  if (jsonlRows.length > 0) {
    const fieldNames = Array.from(new Set(jsonlRows.flatMap((row) => Object.keys(row))))
    return { rows: jsonlRows, fieldNames, format: 'jsonl' }
  }

  const tsvRows = normalizeRows(parseDelimited(trimmed, '\t'))
  if (tsvRows.length > 0) {
    const fieldNames = Array.from(new Set(tsvRows.flatMap((row) => Object.keys(row))))
    return { rows: tsvRows, fieldNames, format: 'tsv' }
  }

  const csvRows = normalizeRows(parseDelimited(trimmed, ','))
  if (csvRows.length > 0) {
    const fieldNames = Array.from(new Set(csvRows.flatMap((row) => Object.keys(row))))
    return { rows: csvRows, fieldNames, format: 'csv' }
  }

  return { rows: [], fieldNames: [], format: 'unknown' }
}

export function parseBrandAnalyticsReport(
  _reportType: BrandAnalyticsReportType,
  rawDocumentContent: string,
): ParsedBrandAnalyticsReport {
  return parseAmazonReportDocument(rawDocumentContent)
}
