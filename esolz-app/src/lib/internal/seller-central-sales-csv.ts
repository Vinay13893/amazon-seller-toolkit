import 'server-only'

// Accepts common column name variants from Seller Central Manage Inventory exports.
const SKU_ALIASES = ['sku', 'merchant_sku', 'seller_sku', 'amazon_sku']
const UNITS_ALIASES = [
  'units_sold',
  'units_sold_last_30_days',
  '30d_units_sold',
  'units_ordered',
  'sales_units',
  'ordered_units',
]
const ASIN_ALIASES = ['asin', 'asin1']
const TITLE_ALIASES = ['product_name', 'title', 'item_name', 'description']

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

export type ParsedSellerCentralSalesRow = {
  amazonSku: string
  amazonSkuNorm: string
  asin: string | null
  title: string | null
  unitsSold: number
}

export type SellerCentralSalesCsvResult = {
  rows: ParsedSellerCentralSalesRow[]
  rejected: number
  errors: Array<{ row: number; message: string }>
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-/]+/g, '_')
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"') {
      if (quoted && next === '"') {
        field += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (ch === '\t' && !quoted) {
      // Also accept tab-delimited (Seller Central sometimes exports .txt as TSV)
      record.push(field)
      field = ''
    } else if (ch === ',' && !quoted) {
      record.push(field)
      field = ''
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1
      record.push(field)
      field = ''
      if (record.some(v => v.trim())) records.push(record)
      record = []
    } else {
      field += ch
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.')
  record.push(field)
  if (record.some(v => v.trim())) records.push(record)
  return records
}

export function parseSellerCentralSalesCsv(text: string): SellerCentralSalesCsvResult {
  const withoutBom = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
  const records = parseCsvRecords(withoutBom)
  if (records.length === 0) throw new Error('CSV is empty.')

  const headers = records[0].map(normalizeHeader)

  // PII guard
  const piiHeader = headers.find(h => PII_COLUMN_PATTERNS.some(p => p.test(h)))
  if (piiHeader) throw new Error('CSV contains a prohibited customer or order-level column.')

  // Resolve required columns
  const skuColIdx = SKU_ALIASES.map(a => headers.indexOf(a)).find(i => i >= 0)
  if (skuColIdx === undefined) {
    throw new Error(`Missing SKU column. Expected one of: ${SKU_ALIASES.join(', ')}.`)
  }
  const unitsColIdx = UNITS_ALIASES.map(a => headers.indexOf(a)).find(i => i >= 0)
  if (unitsColIdx === undefined) {
    throw new Error(`Missing units sold column. Expected one of: ${UNITS_ALIASES.join(', ')}.`)
  }
  const asinColIdx = ASIN_ALIASES.map(a => headers.indexOf(a)).find(i => i >= 0)
  const titleColIdx = TITLE_ALIASES.map(a => headers.indexOf(a)).find(i => i >= 0)

  const rows: ParsedSellerCentralSalesRow[] = []
  const errors: Array<{ row: number; message: string }> = []

  for (let i = 1; i < records.length; i += 1) {
    const record = records[i]
    const rowNumber = i + 1
    const val = (idx: number | undefined) => idx !== undefined ? (record[idx] ?? '').trim() : ''

    const skuRaw = val(skuColIdx)
    const unitsRaw = val(unitsColIdx)

    if (!skuRaw) {
      errors.push({ row: rowNumber, message: 'SKU is required.' })
      continue
    }

    const unitsNum = Number(unitsRaw.replace(/,/g, ''))
    if (!Number.isFinite(unitsNum) || unitsNum < 0) {
      errors.push({ row: rowNumber, message: `units_sold must be a non-negative number (got "${unitsRaw}").` })
      continue
    }

    const asinRaw = val(asinColIdx) || null
    const titleRaw = val(titleColIdx) || null

    rows.push({
      amazonSku: skuRaw.slice(0, 200),
      amazonSkuNorm: skuRaw.toUpperCase().slice(0, 200),
      asin: asinRaw ? asinRaw.slice(0, 20) : null,
      title: titleRaw ? titleRaw.slice(0, 500) : null,
      unitsSold: Math.trunc(unitsNum),
    })
  }

  return { rows, rejected: errors.length, errors: errors.slice(0, 30) }
}
