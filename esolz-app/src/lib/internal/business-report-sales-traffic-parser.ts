import 'server-only'

// Phase R6: Seller Central Business Report — "Sales and Traffic by Date".
// Read-only CSV parsing only; never calls Amazon Ads or Seller Central APIs.
// This report has no buyer PII (no order IDs, names, emails, phones,
// addresses) — only daily aggregate sales/traffic counts and amounts, so no
// PII column blacklist is needed here (unlike SKU-level exports elsewhere).

export type ParsedBusinessReportRow = {
  reportDate: string
  orderedProductSales: number
  orderedProductSalesB2b: number | null
  unitsOrdered: number
  unitsOrderedB2b: number | null
  totalOrderItems: number
  totalOrderItemsB2b: number | null
  averageSalesPerOrderItem: number | null
  averageSalesPerOrderItemB2b: number | null
  averageUnitsPerOrderItem: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPercentage: number | null
  unitSessionPercentage: number | null
}

export type BusinessReportParseRejection = { row: number; reason: string }

export type BusinessReportParseResult = {
  rows: ParsedBusinessReportRow[]
  rejected: BusinessReportParseRejection[]
  minReportDate: string | null
  maxReportDate: string | null
}

const DATE_ALIASES = ['date', 'report_date', 'day']
const ORDERED_PRODUCT_SALES_ALIASES = ['ordered_product_sales']
const ORDERED_PRODUCT_SALES_B2B_ALIASES = ['ordered_product_sales_b2b']
const UNITS_ORDERED_ALIASES = ['units_ordered']
const UNITS_ORDERED_B2B_ALIASES = ['units_ordered_b2b']
const TOTAL_ORDER_ITEMS_ALIASES = ['total_order_items']
const TOTAL_ORDER_ITEMS_B2B_ALIASES = ['total_order_items_b2b']
const AVG_SALES_PER_ITEM_ALIASES = ['average_sales_per_order_item']
const AVG_SALES_PER_ITEM_B2B_ALIASES = ['average_sales_per_order_item_b2b']
const AVG_UNITS_PER_ITEM_ALIASES = ['average_units_per_order_item']
const SESSIONS_ALIASES = ['sessions', 'sessions_total']
const PAGE_VIEWS_ALIASES = ['page_views', 'page_views_total']
const BUY_BOX_ALIASES = ['buy_box_percentage', 'featured_offer_buy_box_percentage']
const UNIT_SESSION_ALIASES = ['unit_session_percentage']

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[%()]/g, '')
    .replace(/[\s\-/]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === ',') {
      result.push(current)
      current = ''
      continue
    }
    current += ch
  }
  result.push(current)
  return result
}

function findColumnIndex(header: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = header.indexOf(alias)
    if (idx >= 0) return idx
  }
  return -1
}

/**
 * Handles ISO (2026-06-08) and the Indian-export slash formats this report
 * commonly uses: single-digit day/month without leading zeros (e.g.
 * "8/6/2026" as well as "08/06/2026"), and — seen in real exports where the
 * same file switches format partway through — a 2-digit year ("13/06/26").
 * 2-digit years are assumed to be 20xx, which is correct for this account's
 * entire operating history and avoids the Y2K-style ambiguity a 19xx/20xx
 * split would otherwise introduce.
 */
function parseReportDate(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`

  const slash4 = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash4) {
    const day = slash4[1].padStart(2, '0')
    const month = slash4[2].padStart(2, '0')
    return `${slash4[3]}-${month}-${day}`
  }

  const slash2 = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (slash2) {
    const day = slash2[1].padStart(2, '0')
    const month = slash2[2].padStart(2, '0')
    return `20${slash2[3]}-${month}-${day}`
  }

  const parsed = new Date(trimmed)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null
}

/**
 * Strips currency symbols/commas/% before parsing. Whitelists digits, dot,
 * and minus rather than blacklisting ₹/%/whitespace — some exports (encoding
 * artifacts, copy-paste from a viewer that can't render ₹) substitute a
 * stray "?" or other placeholder character for the currency symbol, and a
 * blacklist-only strip would silently leave that character in front of the
 * digits, making Number() return NaN and the value get zeroed out.
 */
function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const cleaned = value.replace(/[^0-9.\-]/g, '').trim()
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function toIntOrNull(value: string | undefined): number | null {
  const num = toNumberOrNull(value)
  return num === null ? null : Math.round(num)
}

export function parseBusinessReportSalesTrafficCsv(csvText: string): BusinessReportParseResult {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) {
    return { rows: [], rejected: [{ row: 0, reason: 'Empty file.' }], minReportDate: null, maxReportDate: null }
  }

  const header = splitCsvLine(lines[0]).map(normalizeHeader)
  const dateIdx = findColumnIndex(header, DATE_ALIASES)
  if (dateIdx < 0) {
    return {
      rows: [],
      rejected: [{ row: 1, reason: 'No Date column found — expected the "Sales and Traffic by Date" report, not a period-aggregate export.' }],
      minReportDate: null,
      maxReportDate: null,
    }
  }

  const idx = {
    date: dateIdx,
    orderedProductSales: findColumnIndex(header, ORDERED_PRODUCT_SALES_ALIASES),
    orderedProductSalesB2b: findColumnIndex(header, ORDERED_PRODUCT_SALES_B2B_ALIASES),
    unitsOrdered: findColumnIndex(header, UNITS_ORDERED_ALIASES),
    unitsOrderedB2b: findColumnIndex(header, UNITS_ORDERED_B2B_ALIASES),
    totalOrderItems: findColumnIndex(header, TOTAL_ORDER_ITEMS_ALIASES),
    totalOrderItemsB2b: findColumnIndex(header, TOTAL_ORDER_ITEMS_B2B_ALIASES),
    avgSalesPerItem: findColumnIndex(header, AVG_SALES_PER_ITEM_ALIASES),
    avgSalesPerItemB2b: findColumnIndex(header, AVG_SALES_PER_ITEM_B2B_ALIASES),
    avgUnitsPerItem: findColumnIndex(header, AVG_UNITS_PER_ITEM_ALIASES),
    sessions: findColumnIndex(header, SESSIONS_ALIASES),
    pageViews: findColumnIndex(header, PAGE_VIEWS_ALIASES),
    buyBox: findColumnIndex(header, BUY_BOX_ALIASES),
    unitSession: findColumnIndex(header, UNIT_SESSION_ALIASES),
  }

  const rows: ParsedBusinessReportRow[] = []
  const rejected: BusinessReportParseRejection[] = []
  const seenDates = new Set<string>()

  for (let lineNumber = 1; lineNumber < lines.length; lineNumber += 1) {
    const sourceRowNumber = lineNumber + 1
    const cells = splitCsvLine(lines[lineNumber])
    const reportDate = parseReportDate(cells[idx.date])

    if (!reportDate) {
      rejected.push({ row: sourceRowNumber, reason: 'Missing or unparseable Date.' })
      continue
    }
    if (seenDates.has(reportDate)) {
      rejected.push({ row: sourceRowNumber, reason: `Duplicate date ${reportDate} within this file — only the first occurrence was kept.` })
      continue
    }
    seenDates.add(reportDate)

    rows.push({
      reportDate,
      orderedProductSales: toNumberOrNull(cells[idx.orderedProductSales]) ?? 0,
      orderedProductSalesB2b: idx.orderedProductSalesB2b >= 0 ? toNumberOrNull(cells[idx.orderedProductSalesB2b]) : null,
      unitsOrdered: toIntOrNull(cells[idx.unitsOrdered]) ?? 0,
      unitsOrderedB2b: idx.unitsOrderedB2b >= 0 ? toIntOrNull(cells[idx.unitsOrderedB2b]) : null,
      totalOrderItems: toIntOrNull(cells[idx.totalOrderItems]) ?? 0,
      totalOrderItemsB2b: idx.totalOrderItemsB2b >= 0 ? toIntOrNull(cells[idx.totalOrderItemsB2b]) : null,
      averageSalesPerOrderItem: idx.avgSalesPerItem >= 0 ? toNumberOrNull(cells[idx.avgSalesPerItem]) : null,
      averageSalesPerOrderItemB2b: idx.avgSalesPerItemB2b >= 0 ? toNumberOrNull(cells[idx.avgSalesPerItemB2b]) : null,
      averageUnitsPerOrderItem: idx.avgUnitsPerItem >= 0 ? toNumberOrNull(cells[idx.avgUnitsPerItem]) : null,
      sessions: idx.sessions >= 0 ? toIntOrNull(cells[idx.sessions]) : null,
      pageViews: idx.pageViews >= 0 ? toIntOrNull(cells[idx.pageViews]) : null,
      buyBoxPercentage: idx.buyBox >= 0 ? toNumberOrNull(cells[idx.buyBox]) : null,
      unitSessionPercentage: idx.unitSession >= 0 ? toNumberOrNull(cells[idx.unitSession]) : null,
    })
  }

  const dates = rows.map(r => r.reportDate).sort()
  return {
    rows,
    rejected,
    minReportDate: dates[0] ?? null,
    maxReportDate: dates.at(-1) ?? null,
  }
}
