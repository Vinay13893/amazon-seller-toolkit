import 'server-only'

const ALLOWED_COLUMNS = new Set([
  'sku',
  'component_sku',
  'location_code',
  'available_quantity',
  'reserved_quantity',
  'inbound_quantity',
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
  /shipment_?id/,
  /postal/,
  /pincode/,
]

export type ParsedXhzuStockRow = {
  skuNorm: string
  locationCode: string
  availableQuantity: number
  reservedQuantity: number
  inboundQuantity: number
}

export type XhzuStockCsvResult = {
  rows: ParsedXhzuStockRow[]
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

const DEFAULT_LOCATION_CODE = 'XHZU'

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

export function parseXhzuStockCsv(text: string): XhzuStockCsvResult {
  const withoutBom = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
  const records = parseCsvRecords(withoutBom)
  if (records.length === 0) throw new Error('CSV is empty.')

  const headers = records[0].map(normalizeHeader)
  const piiHeader = headers.find(header => PII_COLUMN_PATTERNS.some(pattern => pattern.test(header)))
  if (piiHeader) {
    throw new Error('CSV contains a prohibited customer or order-level column.')
  }

  if (!headers.includes('sku') && !headers.includes('component_sku')) {
    throw new Error('Missing required column: sku or component_sku.')
  }
  if (!headers.includes('available_quantity')) {
    throw new Error('Missing required column: available_quantity.')
  }

  const unsupported = headers.filter(header => header && !ALLOWED_COLUMNS.has(header))
  if (unsupported.length > 0) {
    throw new Error(
      'CSV contains unsupported columns. Use sku/component_sku, location_code, available_quantity, reserved_quantity, inbound_quantity.',
    )
  }

  const columnIndex = new Map(headers.map((header, index) => [header, index]))
  const rows: ParsedXhzuStockRow[] = []
  const errors: Array<{ row: number; message: string }> = []

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]
    const rowNumber = index + 1
    const value = (column: string) => (record[columnIndex.get(column) ?? -1] ?? '').trim()

    const skuRaw = value('sku') || value('component_sku')
    const locationRaw = value('location_code') || DEFAULT_LOCATION_CODE
    const availableRaw = value('available_quantity')
    const reservedRaw = value('reserved_quantity')
    const inboundRaw = value('inbound_quantity')

    if (!skuRaw) {
      errors.push({ row: rowNumber, message: 'sku or component_sku is required.' })
      continue
    }
    if (!/^\d+$/.test(availableRaw)) {
      errors.push({ row: rowNumber, message: 'available_quantity must be an integer of 0 or more.' })
      continue
    }
    if (reservedRaw !== '' && !/^\d+$/.test(reservedRaw)) {
      errors.push({ row: rowNumber, message: 'reserved_quantity must be an integer of 0 or more.' })
      continue
    }
    if (inboundRaw !== '' && !/^\d+$/.test(inboundRaw)) {
      errors.push({ row: rowNumber, message: 'inbound_quantity must be an integer of 0 or more.' })
      continue
    }

    rows.push({
      skuNorm: skuRaw.toUpperCase().slice(0, 200),
      locationCode: locationRaw.toUpperCase().slice(0, 50),
      availableQuantity: Number(availableRaw),
      reservedQuantity: reservedRaw === '' ? 0 : Number(reservedRaw),
      inboundQuantity: inboundRaw === '' ? 0 : Number(inboundRaw),
    })
  }

  return {
    rows,
    rejected: errors.length,
    errors: errors.slice(0, 20),
  }
}
