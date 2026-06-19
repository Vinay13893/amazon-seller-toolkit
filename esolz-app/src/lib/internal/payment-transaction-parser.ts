export type PaymentTransactionCategory =
  | 'Order'
  | 'Refund'
  | 'EasyShipFee'
  | 'FulfilmentFeeRefund'
  | 'StorageFee'
  | 'FBAInventoryFee'
  | 'SAFE-T'
  | 'Reimbursement'
  | 'Transfer'
  | 'Adjustment'
  | 'Ad'
  | 'Subscription'
  | 'ServiceFee'
  | 'OtherIncome'
  | 'Other'

export type PaymentTransactionRecord = {
  sourceRowNumber: number
  transactionDate: string
  settlementId: string | null
  transactionType: string
  category: PaymentTransactionCategory
  orderId: string | null
  sku: string | null
  description: string | null
  quantity: number | null
  marketplace: string | null
  accountType: string | null
  fulfillment: string | null
  orderCity: string | null
  orderState: string | null
  orderPostal: string | null
  productSales: number
  shippingCredits: number
  giftWrapCredits: number
  promotionalRebates: number
  totalSalesTaxLiable: number
  tcsCgst: number
  tcsSgst: number
  tcsIgst: number
  tds194o: number
  sellingFees: number
  fbaFees: number
  otherTransactionFees: number
  otherAmount: number
  totalAmount: number
  transactionStatus: string | null
  transactionReleaseDate: string | null
}

export type PaymentTransactionRejection = {
  sourceRowNumber: number
  reason: 'missing_date' | 'missing_type'
}

export type PaymentTransactionStats = {
  totalRowCount: number
  acceptedCount: number
  rejectedCount: number
  categoryCounts: Record<string, number>
  distinctOrderCount: number
  distinctSkuCount: number
  dateRangeStart: string | null
  dateRangeEnd: string | null
  totalAmountSum: number
}

export type PaymentTransactionParseResult = {
  accepted: PaymentTransactionRecord[]
  rejected: PaymentTransactionRejection[]
  stats: PaymentTransactionStats
}

const HEADER_SIGNAL_KEYS = [
  'date/time', 'type', 'order id', 'sku', 'selling fees', 'fba fees', 'total',
]
const MIN_HEADER_SIGNAL_SCORE = 5

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

const AD_RE = /\b(advertis|sponsored|cost of advertising)\b/i
const STORAGE_RE = /\b(storage fee|long term storage|aged|removal)\b/i
const FBA_INV_RE = /\bfba inventory\b|\binventory placement\b|\bplacement service\b|\binbound\b/i
const REIMB_RE = /\breimburs/i
const SAFET_RE = /\bsafe-?t\b/i
const SUBS_RE = /\bsubscription\b|\bprofessional selling\b/i
const EASYSHIP_RE = /\beasy ship\b|\bweight handling\b/i
const FF_REFUND_RE = /\bfulfillment fee refund\b|\bfulfilment fee refund\b|\bweight handling fee reversal\b/i
const REWARDS_RE = /\bseller rewards\b|\brewards\b/i

function splitCsvLine(line: string, delimiter = ','): string[] {
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

function findHeaderRowIndex(lines: string[]): number {
  const searchLimit = Math.min(lines.length, 60)
  for (let i = 0; i < searchLimit; i += 1) {
    const lowered = lines[i].toLowerCase()
    const score = HEADER_SIGNAL_KEYS.reduce(
      (count, key) => (lowered.includes(key) ? count + 1 : count),
      0,
    )
    if (score >= MIN_HEADER_SIGNAL_SCORE) return i
  }
  return 0
}

function toNumber(value: string | undefined): number {
  if (!value) return 0
  const cleaned = value.replace(/,/g, '').replace(/ /g, '').trim()
  if (!cleaned) return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

function toTextOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

const AMAZON_DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)\s+UTC$/i

function parseAmazonDate(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const match = trimmed.match(AMAZON_DATE_RE)
  if (!match) return null
  const [, dayStr, monthName, yearStr, hourStr, minuteStr, secondStr, meridiem] = match
  const monthIndex = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()]
  if (monthIndex === undefined) return null

  let hour = Number(hourStr) % 12
  if (meridiem.toLowerCase() === 'pm') hour += 12

  const date = new Date(Date.UTC(
    Number(yearStr),
    monthIndex,
    Number(dayStr),
    hour,
    Number(minuteStr),
    Number(secondStr),
  ))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function categorize(transactionType: string, description: string): PaymentTransactionCategory {
  const tl = transactionType.trim().toLowerCase()
  const desc = description ?? ''

  if (tl === 'order' || tl === 'shipment' || tl === 'shipmentitem') return 'Order'
  if (tl === 'refund' || tl === 'return') return 'Refund'
  if (tl === 'shipping services') return 'EasyShipFee'
  if (tl === 'fulfilment fee refund' || FF_REFUND_RE.test(desc)) return 'FulfilmentFeeRefund'
  if (tl === 'fba inventory fee') return STORAGE_RE.test(desc) ? 'StorageFee' : 'FBAInventoryFee'
  if (tl === 'safe-t reimbursement') return 'SAFE-T'
  if (tl === 'reimbursements' || REIMB_RE.test(desc)) return 'Reimbursement'
  if (tl === 'transfer' || tl === 'transfers' || tl === 'disbursement') return 'Transfer'
  if (tl === 'debt') return 'Adjustment'
  if (tl === 'adjustment') {
    if (REIMB_RE.test(desc)) return 'Reimbursement'
    if (SAFET_RE.test(desc)) return 'SAFE-T'
    return 'Adjustment'
  }
  if (tl === 'service fee' || tl === 'service fees' || tl === 'servicefee') {
    if (AD_RE.test(desc)) return 'Ad'
    if (STORAGE_RE.test(desc)) return 'StorageFee'
    if (FBA_INV_RE.test(desc)) return 'FBAInventoryFee'
    if (SUBS_RE.test(desc)) return 'Subscription'
    if (EASYSHIP_RE.test(desc)) return 'EasyShipFee'
    return 'ServiceFee'
  }
  if (tl === 'others') return REWARDS_RE.test(desc) ? 'OtherIncome' : 'Other'

  if (REWARDS_RE.test(desc)) return 'OtherIncome'
  if (AD_RE.test(desc)) return 'Ad'
  if (STORAGE_RE.test(desc)) return 'StorageFee'
  if (EASYSHIP_RE.test(desc)) return 'EasyShipFee'
  if (SAFET_RE.test(desc)) return 'SAFE-T'
  return 'Other'
}

export function parsePaymentTransactionReport(csvText: string): PaymentTransactionParseResult {
  const lines = csvText.split(/\r?\n/)
  const headerIndex = findHeaderRowIndex(lines)
  const header = splitCsvLine(lines[headerIndex]).map(column => column.trim().toLowerCase())

  const columnIndex = (name: string) => header.indexOf(name)
  const idx = {
    dateTime: columnIndex('date/time'),
    settlementId: columnIndex('settlement id'),
    type: columnIndex('type'),
    orderId: columnIndex('order id'),
    sku: columnIndex('sku'),
    description: columnIndex('description'),
    quantity: columnIndex('quantity'),
    marketplace: columnIndex('marketplace'),
    accountType: columnIndex('account type'),
    fulfillment: columnIndex('fulfillment'),
    orderCity: columnIndex('order city'),
    orderState: columnIndex('order state'),
    orderPostal: columnIndex('order postal'),
    productSales: columnIndex('product sales'),
    shippingCredits: columnIndex('shipping credits'),
    giftWrapCredits: columnIndex('gift wrap credits'),
    promotionalRebates: columnIndex('promotional rebates'),
    totalSalesTaxLiable: columnIndex('total sales tax liable(gst before adjusting tcs)'),
    tcsCgst: columnIndex('tcs-cgst'),
    tcsSgst: columnIndex('tcs-sgst'),
    tcsIgst: columnIndex('tcs-igst'),
    tds194o: columnIndex('tds (section 194-o)'),
    sellingFees: columnIndex('selling fees'),
    fbaFees: columnIndex('fba fees'),
    otherTransactionFees: columnIndex('other transaction fees'),
    other: columnIndex('other'),
    total: columnIndex('total'),
    transactionStatus: columnIndex('transaction status'),
    transactionReleaseDate: columnIndex('transaction release date'),
  }

  const accepted: PaymentTransactionRecord[] = []
  const rejected: PaymentTransactionRejection[] = []
  const categoryCounts: Record<string, number> = {}
  const distinctOrders = new Set<string>()
  const distinctSkus = new Set<string>()
  let dateRangeStart: string | null = null
  let dateRangeEnd: string | null = null
  let totalAmountSum = 0
  let totalRowCount = 0

  for (let lineNumber = headerIndex + 1; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    if (!line || !line.trim()) continue
    totalRowCount += 1
    const cells = splitCsvLine(line)
    const sourceRowNumber = lineNumber + 1

    const transactionDate = parseAmazonDate(cells[idx.dateTime])
    const transactionType = toTextOrNull(cells[idx.type])

    if (!transactionDate) {
      rejected.push({ sourceRowNumber, reason: 'missing_date' })
      continue
    }
    if (!transactionType) {
      rejected.push({ sourceRowNumber, reason: 'missing_type' })
      continue
    }

    const description = toTextOrNull(cells[idx.description]) ?? ''
    const category = categorize(transactionType, description)
    const orderId = toTextOrNull(cells[idx.orderId])
    const sku = toTextOrNull(cells[idx.sku])
    const totalAmount = toNumber(cells[idx.total])

    accepted.push({
      sourceRowNumber,
      transactionDate,
      settlementId: toTextOrNull(cells[idx.settlementId]),
      transactionType,
      category,
      orderId,
      sku,
      description: description || null,
      quantity: idx.quantity >= 0 ? Math.trunc(toNumber(cells[idx.quantity])) : null,
      marketplace: toTextOrNull(cells[idx.marketplace]),
      accountType: toTextOrNull(cells[idx.accountType]),
      fulfillment: toTextOrNull(cells[idx.fulfillment]),
      orderCity: toTextOrNull(cells[idx.orderCity]),
      orderState: toTextOrNull(cells[idx.orderState]),
      orderPostal: toTextOrNull(cells[idx.orderPostal]),
      productSales: toNumber(cells[idx.productSales]),
      shippingCredits: toNumber(cells[idx.shippingCredits]),
      giftWrapCredits: toNumber(cells[idx.giftWrapCredits]),
      promotionalRebates: toNumber(cells[idx.promotionalRebates]),
      totalSalesTaxLiable: toNumber(cells[idx.totalSalesTaxLiable]),
      tcsCgst: toNumber(cells[idx.tcsCgst]),
      tcsSgst: toNumber(cells[idx.tcsSgst]),
      tcsIgst: toNumber(cells[idx.tcsIgst]),
      tds194o: toNumber(cells[idx.tds194o]),
      sellingFees: toNumber(cells[idx.sellingFees]),
      fbaFees: toNumber(cells[idx.fbaFees]),
      otherTransactionFees: toNumber(cells[idx.otherTransactionFees]),
      otherAmount: toNumber(cells[idx.other]),
      totalAmount,
      transactionStatus: toTextOrNull(cells[idx.transactionStatus]),
      transactionReleaseDate: parseAmazonDate(cells[idx.transactionReleaseDate]),
    })

    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1
    if (orderId) distinctOrders.add(orderId)
    if (sku) distinctSkus.add(sku)
    if (!dateRangeStart || transactionDate < dateRangeStart) dateRangeStart = transactionDate
    if (!dateRangeEnd || transactionDate > dateRangeEnd) dateRangeEnd = transactionDate
    totalAmountSum += totalAmount
  }

  return {
    accepted,
    rejected,
    stats: {
      totalRowCount,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      categoryCounts,
      distinctOrderCount: distinctOrders.size,
      distinctSkuCount: distinctSkus.size,
      dateRangeStart,
      dateRangeEnd,
      totalAmountSum: Math.round(totalAmountSum * 100) / 100,
    },
  }
}
