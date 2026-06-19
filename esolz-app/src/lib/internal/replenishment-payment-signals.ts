export type PaymentSignalTransactionInput = {
  transactionDate: string
  category: string
  sku: string | null
  skuNorm: string | null
  orderState: string | null
  quantity: number | null
  productSales: number
  sellingFees: number
  fbaFees: number
  otherTransactionFees: number
}

export type StateZoneInput = {
  stateCode: string
  stateName: string | null
  zoneCode: string
  zoneName: string | null
}

export type ComponentMappingInput = {
  amazonSku: string
  amazonSkuNorm: string
  componentSku: string
  componentSkuNorm: string
  componentQuantity: number
}

export type CostInput = {
  skuNorm: string
  costPrice: number | null
  packingTransport: number | null
}

export type StockSignalInput = {
  sku: string | null
  suggestedFbaReplenishment: number
  suggestedSellerFlexReplenishment: number
}

export type StateZoneDemandRow = {
  state: string
  zone: string | null
  amazonSku: string
  componentSku: string | null
  unitsSold: number
  componentDemandUnits: number
  transactionCount: number
  grossSales: number
  refundUnits: number
  refundAmount: number
}

export type PaymentPriorityFlag =
  | 'profitable_high_demand'
  | 'profitable_low_stock'
  | 'loss_or_review'
  | 'missing_cost'
  | 'insufficient_data'

export type PaymentSignalRow = {
  amazonSku: string
  unitsSold: number
  grossSales: number
  refundUnits: number
  refundAmount: number
  amazonFees: number
  costAvailable: boolean
  estimatedContribution: number | null
  estimatedMarginPercent: number | null
  priorityFlag: PaymentPriorityFlag
  note: string
}

export type ReplenishmentPaymentSignals = {
  stateZoneDemand: StateZoneDemandRow[]
  paymentSignals: PaymentSignalRow[]
  diagnostics: {
    transactionRowsRead: number
    salesTransactionRowsUsed: number
    refundTransactionRowsUsed: number
    rowsMissingSku: number
    rowsMissingState: number
    mappedComponentRows: number
    stateZoneMappedRows: number
    transactionRowLimitReached: boolean
    exactPnlAvailable: false
  }
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function positiveUnits(value: number | null): number {
  return Math.max(0, Math.abs(Math.trunc(value ?? 0)))
}

function paymentFeeCost(row: PaymentSignalTransactionInput): number {
  const signedFees = row.sellingFees + row.fbaFees + row.otherTransactionFees
  return Math.max(0, -signedFees)
}

function stateLookupKey(value: string | null | undefined): string {
  return normalized(value).replace(/[^A-Z0-9]/g, '')
}

export function buildReplenishmentPaymentSignals(input: {
  transactions: PaymentSignalTransactionInput[]
  stateZoneMap: StateZoneInput[]
  componentMappings: ComponentMappingInput[]
  costs: CostInput[]
  stockSignals: StockSignalInput[]
  transactionRowLimitReached?: boolean
}): ReplenishmentPaymentSignals {
  const zoneByState = new Map<string, { zoneCode: string; zoneName: string | null }>()
  for (const row of input.stateZoneMap) {
    const zone = { zoneCode: row.zoneCode, zoneName: row.zoneName }
    zoneByState.set(stateLookupKey(row.stateCode), zone)
    if (row.stateName) zoneByState.set(stateLookupKey(row.stateName), zone)
  }

  const mappingsByAmazonSku = new Map<string, ComponentMappingInput[]>()
  for (const mapping of input.componentMappings) {
    const rows = mappingsByAmazonSku.get(mapping.amazonSkuNorm) ?? []
    rows.push(mapping)
    mappingsByAmazonSku.set(mapping.amazonSkuNorm, rows)
  }

  const costBySku = new Map<string, number>()
  for (const row of input.costs) {
    if (row.costPrice === null) continue
    costBySku.set(row.skuNorm, row.costPrice + (row.packingTransport ?? 0))
  }
  const stockBySku = new Map(
    input.stockSignals
      .filter(row => row.sku)
      .map(row => [
        normalized(row.sku),
        row.suggestedFbaReplenishment + row.suggestedSellerFlexReplenishment,
      ]),
  )

  type MutableDemand = StateZoneDemandRow
  type MutablePayment = Omit<PaymentSignalRow, 'costAvailable' | 'estimatedContribution' | 'estimatedMarginPercent' | 'priorityFlag' | 'note'> & {
    estimatedUnitCost: number | null
  }
  const demandByKey = new Map<string, MutableDemand>()
  const paymentBySku = new Map<string, MutablePayment>()
  let salesTransactionRowsUsed = 0
  let refundTransactionRowsUsed = 0
  let rowsMissingSku = 0
  let rowsMissingState = 0
  let mappedComponentRows = 0
  let stateZoneMappedRows = 0

  for (const row of input.transactions) {
    const isOrder = row.category === 'Order'
    const isRefund = row.category === 'Refund'
    if (!isOrder && !isRefund) continue

    const skuNorm = row.skuNorm || normalized(row.sku)
    if (!skuNorm || !row.sku) {
      rowsMissingSku += 1
      continue
    }

    if (isOrder) salesTransactionRowsUsed += 1
    if (isRefund) refundTransactionRowsUsed += 1

    const units = positiveUnits(row.quantity)
    const grossSales = isOrder ? Math.max(0, row.productSales) : 0
    const refundAmount = isRefund ? Math.abs(Math.min(0, row.productSales)) : 0
    const refundUnits = isRefund ? units : 0
    const amazonFees = paymentFeeCost(row)
    const mappings = mappingsByAmazonSku.get(skuNorm) ?? []
    const directCost = costBySku.get(skuNorm)
    const mappedCost = mappings.length > 0 && mappings.every(mapping => costBySku.has(mapping.componentSkuNorm))
      ? mappings.reduce(
          (sum, mapping) => sum + (costBySku.get(mapping.componentSkuNorm) ?? 0) * mapping.componentQuantity,
          0,
        )
      : null
    const estimatedUnitCost = directCost ?? mappedCost

    const payment = paymentBySku.get(skuNorm) ?? {
      amazonSku: row.sku,
      unitsSold: 0,
      grossSales: 0,
      refundUnits: 0,
      refundAmount: 0,
      amazonFees: 0,
      estimatedUnitCost,
    }
    if (payment.estimatedUnitCost === null && estimatedUnitCost !== null) {
      payment.estimatedUnitCost = estimatedUnitCost
    }
    payment.unitsSold += isOrder ? units : 0
    payment.grossSales += grossSales
    payment.refundUnits += refundUnits
    payment.refundAmount += refundAmount
    payment.amazonFees += amazonFees
    paymentBySku.set(skuNorm, payment)

    const state = row.orderState?.trim() || 'State unavailable'
    if (!row.orderState?.trim()) rowsMissingState += 1
    const zoneMatch = zoneByState.get(stateLookupKey(row.orderState))
    if (zoneMatch) stateZoneMappedRows += 1
    const zone = zoneMatch?.zoneName || zoneMatch?.zoneCode || null
    const componentRows = mappings.length > 0
      ? mappings
      : [{
          amazonSku: row.sku,
          amazonSkuNorm: skuNorm,
          componentSku: '',
          componentSkuNorm: '',
          componentQuantity: 1,
        }]

    for (const component of componentRows) {
      if (mappings.length > 0) mappedComponentRows += 1
      const componentSku = component.componentSku || null
      const key = [stateLookupKey(state), normalized(zone), skuNorm, component.componentSkuNorm].join('|')
      const demand = demandByKey.get(key) ?? {
        state,
        zone,
        amazonSku: row.sku,
        componentSku,
        unitsSold: 0,
        componentDemandUnits: 0,
        transactionCount: 0,
        grossSales: 0,
        refundUnits: 0,
        refundAmount: 0,
      }
      demand.unitsSold += isOrder ? units : 0
      demand.componentDemandUnits += isOrder ? units * component.componentQuantity : 0
      demand.transactionCount += 1
      demand.grossSales += grossSales
      demand.refundUnits += refundUnits
      demand.refundAmount += refundAmount
      demandByKey.set(key, demand)
    }
  }

  const averageUnits = paymentBySku.size > 0
    ? [...paymentBySku.values()].reduce((sum, row) => sum + row.unitsSold, 0) / paymentBySku.size
    : 0
  const paymentSignals: PaymentSignalRow[] = [...paymentBySku.entries()].map(([skuNorm, row]) => {
    const netUnits = Math.max(0, row.unitsSold - row.refundUnits)
    const costAvailable = row.estimatedUnitCost !== null
    const estimatedContribution = costAvailable
      ? rounded(row.grossSales - row.refundAmount - row.amazonFees - netUnits * (row.estimatedUnitCost ?? 0))
      : null
    const estimatedMarginPercent = estimatedContribution !== null && row.grossSales > 0
      ? rounded((estimatedContribution / row.grossSales) * 100)
      : null
    const suggestedStock = stockBySku.get(skuNorm) ?? 0
    let priorityFlag: PaymentPriorityFlag = 'insufficient_data'
    if (!costAvailable) priorityFlag = 'missing_cost'
    else if (row.unitsSold <= 0 || row.grossSales <= 0) priorityFlag = 'insufficient_data'
    else if ((estimatedContribution ?? 0) <= 0) priorityFlag = 'loss_or_review'
    else if (suggestedStock > 0) priorityFlag = 'profitable_low_stock'
    else if (row.unitsSold >= Math.max(1, averageUnits)) priorityFlag = 'profitable_high_demand'

    return {
      amazonSku: row.amazonSku,
      unitsSold: row.unitsSold,
      grossSales: rounded(row.grossSales),
      refundUnits: row.refundUnits,
      refundAmount: rounded(row.refundAmount),
      amazonFees: rounded(row.amazonFees),
      costAvailable,
      estimatedContribution,
      estimatedMarginPercent,
      priorityFlag,
      note: 'Estimated payment signal only; exact GST-aware P&L is not applied.',
    }
  })

  return {
    stateZoneDemand: [...demandByKey.values()]
      .map(row => ({
        ...row,
        grossSales: rounded(row.grossSales),
        refundAmount: rounded(row.refundAmount),
      }))
      .sort((a, b) => b.componentDemandUnits - a.componentDemandUnits),
    paymentSignals: paymentSignals.sort((a, b) => b.unitsSold - a.unitsSold),
    diagnostics: {
      transactionRowsRead: input.transactions.length,
      salesTransactionRowsUsed,
      refundTransactionRowsUsed,
      rowsMissingSku,
      rowsMissingState,
      mappedComponentRows,
      stateZoneMappedRows,
      transactionRowLimitReached: input.transactionRowLimitReached ?? false,
      exactPnlAvailable: false,
    },
  }
}
