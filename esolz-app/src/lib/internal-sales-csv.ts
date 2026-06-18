import 'server-only'

const REQUIRED_COLUMNS = ['sales_date', 'asin', 'ordered_units'] as const
const ALLOWED_COLUMNS = new Set([
  ...REQUIRED_COLUMNS,
  'sku',
  'marketplace_id',
  'ordered_revenue',
])

const PII_COLUMN_PATTERNS = [
  /customer/,
  /buyer/,
  /(^|_)name$/,
  /email/,
  /address/,
  /phone/,
  /mobile/,
  /order_?id/,
  /postal/,
  /pincode/,
]

export type ParsedSalesRow = {
  salesDate: string
  asin: string
  sku: string
  marketplaceId: string | null
  orderedUnits: number
  orderedRevenue: number | null
}

export type SalesCsvResult = {
  rows: ParsedSalesRow[]
  rejected: number
  errors: Array<{ row: number; message: string }>
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '"') {
      if (quoted && next === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      record.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      record.push(field)
      field = ''
      if (record.some(value => value.trim())) records.push(record)
      record = []
    } else {
      field += char
    }
  }

  if (quoted) throw new Error('CSV contains an unclosed quoted field.')
  record.push(field)
  if (record.some(value => value.trim())) records.push(record)
  return records
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function parseAggregatedSalesCsv(text: string): SalesCsvResult {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ''))
  if (records.length === 0) throw new Error('CSV is empty.')

  const headers = records[0].map(normalizeHeader)
  const piiHeader = headers.find(header => PII_COLUMN_PATTERNS.some(pattern => pattern.test(header)))
  if (piiHeader) {
    throw new Error('CSV contains a prohibited customer or order-level column.')
  }

  const missing = REQUIRED_COLUMNS.filter(column => !headers.includes(column))
  if (missing.length > 0) {
    throw new Error(`Missing required column: ${missing.join(', ')}.`)
  }

  const unsupported = headers.filter(header => header && !ALLOWED_COLUMNS.has(header))
  if (unsupported.length > 0) {
    throw new Error('CSV contains unsupported columns. Use the sample template.')
  }

  const columnIndex = new Map(headers.map((header, index) => [header, index]))
  const rows: ParsedSalesRow[] = []
  const errors: Array<{ row: number; message: string }> = []

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]
    const rowNumber = index + 1
    const value = (column: string) => (record[columnIndex.get(column) ?? -1] ?? '').trim()
    const salesDate = value('sales_date')
    const asin = value('asin').toUpperCase()
    const orderedUnitsRaw = value('ordered_units')
    const orderedRevenueRaw = value('ordered_revenue')
    const marketplaceId = value('marketplace_id') || null
    const sku = value('sku')

    if (!validIsoDate(salesDate)) {
      errors.push({ row: rowNumber, message: 'sales_date must use YYYY-MM-DD.' })
      continue
    }
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      errors.push({ row: rowNumber, message: 'asin must be a valid 10-character value.' })
      continue
    }
    if (!/^\d+$/.test(orderedUnitsRaw)) {
      errors.push({ row: rowNumber, message: 'ordered_units must be an integer of 0 or more.' })
      continue
    }

    const orderedUnits = Number(orderedUnitsRaw)
    const orderedRevenue = orderedRevenueRaw === '' ? null : Number(orderedRevenueRaw)
    if (
      orderedRevenue !== null
      && (!Number.isFinite(orderedRevenue) || orderedRevenue < 0)
    ) {
      errors.push({ row: rowNumber, message: 'ordered_revenue must be a number of 0 or more.' })
      continue
    }
    if (marketplaceId && !/^[A-Z0-9]{6,20}$/.test(marketplaceId)) {
      errors.push({ row: rowNumber, message: 'marketplace_id is invalid.' })
      continue
    }

    rows.push({
      salesDate,
      asin,
      sku: sku.slice(0, 200),
      marketplaceId,
      orderedUnits,
      orderedRevenue,
    })
  }

  return {
    rows,
    rejected: errors.length,
    errors: errors.slice(0, 20),
  }
}
