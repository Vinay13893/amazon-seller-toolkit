import { createDecipheriv } from 'crypto'
import { gunzipSync } from 'zlib'

const SPAPI_EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
const REPORTS_API_BASE = '/reports/2021-06-30'
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

export const BRAND_ANALYTICS_REPORT_TYPES = [
  'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
  'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
  'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT',
] as const

export type BrandAnalyticsReportType = (typeof BRAND_ANALYTICS_REPORT_TYPES)[number]

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

export type AmazonReportDocumentStageErrorCode =
  | 'report_document_url_missing'
  | 'download_report_document_failed'
  | 'decompress_report_failed'

export class AmazonReportDocumentStageError extends Error {
  code: AmazonReportDocumentStageErrorCode

  constructor(code: AmazonReportDocumentStageErrorCode) {
    super(code)
    this.code = code
  }
}

function safeHttpError(status: number): Error {
  return new Error(`SP-API request failed with HTTP ${status}`)
}

function getCryptoKey(): Buffer {
  const raw = process.env.SPAPI_ENCRYPTION_KEY
  if (!raw || raw.length !== 64) {
    throw new Error('SPAPI_ENCRYPTION_KEY is missing or invalid')
  }
  return Buffer.from(raw, 'hex')
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format')
  }

  const [ivHex, ctHex, tagHex] = parts
  const key = getCryptoKey()
  const iv = Buffer.from(ivHex, 'hex')
  const ct = Buffer.from(ctHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.SPAPI_LWA_CLIENT_ID
  const clientSecret = process.env.SPAPI_LWA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('LWA credentials are not configured')
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!res.ok) {
    throw safeHttpError(res.status)
  }

  const data = await res.json() as { access_token?: string; expires_in?: number }
  if (!data.access_token || !data.expires_in) {
    throw new Error('Unexpected LWA response')
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in }
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
    throw safeHttpError(res.status)
  }

  const data = await res.json() as Partial<AmazonReportDocumentResult>
  if (!data.reportDocumentId || !data.url) {
    throw new AmazonReportDocumentStageError('report_document_url_missing')
  }

  return {
    reportDocumentId: data.reportDocumentId,
    url: data.url,
    compressionAlgorithm: data.compressionAlgorithm,
    encryptionDetails: data.encryptionDetails,
  }
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

export async function downloadAmazonReportDocument(
  document: AmazonReportDocumentResult,
): Promise<string> {
  let res: Response
  try {
    res = await fetch(document.url, {
      method: 'GET',
      headers: {
        'content-type': 'application/octet-stream',
      },
    })
  } catch {
    throw new AmazonReportDocumentStageError('download_report_document_failed')
  }

  if (!res.ok) {
    throw new AmazonReportDocumentStageError('download_report_document_failed')
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch {
    throw new AmazonReportDocumentStageError('download_report_document_failed')
  }

  if (document.encryptionDetails) {
    try {
      bytes = decodeEncryptedContent(bytes, document.encryptionDetails)
    } catch {
      throw new AmazonReportDocumentStageError('download_report_document_failed')
    }
  }

  if (document.compressionAlgorithm?.toUpperCase() === 'GZIP') {
    try {
      bytes = gunzipSync(bytes)
    } catch {
      throw new AmazonReportDocumentStageError('decompress_report_failed')
    }
  }

  return Buffer.from(bytes).toString('utf8')
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

export function parseBrandAnalyticsReport(
  _reportType: BrandAnalyticsReportType,
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
