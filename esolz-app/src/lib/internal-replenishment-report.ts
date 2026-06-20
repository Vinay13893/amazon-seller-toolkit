import type {
  FcDiagnosticRow,
  NextStockPlanAssumptions,
  NextStockPlanRow,
} from './internal-replenishment-planner'
import type { PaymentSignalRow } from './internal/replenishment-payment-signals'

export type InventoryByLocationRow = {
  asin: string | null
  sku: string | null
  marketplaceId: string | null
  locationCode: string | null
  available: number
  reserved: number
  unsellable: number
}

export type ComponentMappingRow = {
  amazonSku: string
  amazonSkuNorm: string
  componentSku: string
  componentSkuNorm: string
  componentQuantity: number
}

export type StateZoneDemandSignal = {
  componentSku: string | null
  zone: string | null
  componentDemandUnits: number
}

type ConfidenceStatus = 'high' | 'medium' | 'low'

type PaymentSignalSummary = {
  priorityFlag: PaymentSignalRow['priorityFlag']
  estimatedMarginPercent: number | null
  costAvailable: boolean
}

export type FcReplenishmentRow = {
  productTitle: string | null
  asin: string
  amazonSku: string | null
  fcCode: string
  fcType: 'fba_fc'
  zone: string | null
  demand30d: number
  dailyVelocity: number
  growthFactor: number
  targetStockDays: number
  requiredStock: number
  currentFcStockApprox: number | null
  inboundToFc: number | null
  suggestedSendQty: number
  confidenceStatus: ConfidenceStatus
  action: 'send_to_fc' | 'monitor' | 'no_action'
  reason: string
  stateZoneSignal: string | null
  paymentSignal: PaymentSignalSummary | null
}

export type FcReplenishmentSummary = {
  rows: number
  skusToSend: number
  unitsSuggested: number
  rowsNeedingStockContext: number
  rowsInboundNotIncluded: number
  rowsMarginReview: number
}

export type FlexReplenishmentRow = {
  componentSku: string
  wmsParentSkuCount: number
  linkedAmazonSkuCount: number
  amazonDemand30d: number
  componentAdjustedDemand: number
  dailyComponentVelocity: number
  growthFactor: number
  targetStockDays: number
  requiredComponentStock: number
  currentXhzuComponentStock: number | null
  suggestedVendorReplenishQty: number | null
  confidenceStatus: ConfidenceStatus
  action: 'send_to_vendor' | 'monitor' | 'needs_xhzu_stock_context'
  reason: string
  stateZoneSignal: string | null
  paymentSignal: PaymentSignalSummary | null
}

export type FcStockMatrixCell = {
  fcCode: string
  zone: string | null
  demand30d: number
  currentFcStockApprox: number | null
  inboundToFc: number | null
  suggestedSendQty: number
  action: string
  reason: string
}

export type FcStockMatrixRow = {
  productTitle: string
  asin: string | null
  amazonSku: string | null
  totalDemand30d: number
  xhzuOrSellerFlexStock: number | null
  totalSuggestedSendQty: number
  action: string
  reason: string
  fcCells: FcStockMatrixCell[]
}

export type FlexReplenishmentSummary = {
  rows: number
  componentSkusToReplenish: number
  componentUnitsRequired: number
  rowsNeedingXhzuStockContext: number
  rowsMissingMapping: number
  rowsMarginReview: number
}

function norm(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function productKey(marketplaceId: string | null, asin: string | null, sku: string | null): string {
  return `${norm(marketplaceId)}|${norm(asin)}|${norm(sku)}`
}

function toPaymentSignalSummary(row: PaymentSignalRow | undefined | null): PaymentSignalSummary | null {
  if (!row) return null
  return {
    priorityFlag: row.priorityFlag,
    estimatedMarginPercent: row.estimatedMarginPercent,
    costAvailable: row.costAvailable,
  }
}

const INBOUND_NOT_INCLUDED_WARNING = 'Inbound shipment quantity not included yet.'

export function buildFcReplenishmentRows(input: {
  fcDiagnostics: FcDiagnosticRow[]
  inventoryByLocation: InventoryByLocationRow[]
  assumptions: NextStockPlanAssumptions
  planRows: NextStockPlanRow[]
  paymentSignals: PaymentSignalRow[]
}): { rows: FcReplenishmentRow[]; summary: FcReplenishmentSummary } {
  const stockByProductLocation = new Map<string, number>()
  for (const row of input.inventoryByLocation) {
    if (!row.locationCode) continue
    const key = `${productKey(row.marketplaceId, row.asin, row.sku)}|${norm(row.locationCode)}`
    const usable = Math.max(0, Math.trunc(row.available - row.reserved - row.unsellable))
    stockByProductLocation.set(key, (stockByProductLocation.get(key) ?? 0) + usable)
  }

  const stateZoneBySku = new Map<string, string>()
  for (const row of input.planRows) {
    stateZoneBySku.set(productKey(row.marketplaceId, row.asin, row.sku), row.stateZoneInsight)
  }

  const paymentByAmazonSku = new Map(
    input.paymentSignals.map(row => [norm(row.amazonSku), row]),
  )

  const targetStockDays = input.assumptions.planningCycleDays + input.assumptions.transitBufferDays
  const lookbackDays = input.assumptions.salesLookbackDays
  const growthFactor = input.assumptions.growthMultiplier

  const rows: FcReplenishmentRow[] = []
  for (const diag of input.fcDiagnostics) {
    if (diag.fulfillmentCenterType !== 'fba_fc') continue
    if (diag.fulfillmentCenterId === 'UNKNOWN') continue

    const pKey = productKey(diag.marketplaceId, diag.asin, diag.sku)
    const stockKey = `${pKey}|${diag.fulfillmentCenterId}`
    const currentFcStockApprox = stockByProductLocation.has(stockKey)
      ? stockByProductLocation.get(stockKey)!
      : null

    const demand30d = diag.shipments30d
    const dailyVelocity = lookbackDays > 0 ? demand30d / lookbackDays : 0
    const requiredStock = Math.ceil(dailyVelocity * growthFactor * targetStockDays)
    const inboundToFc: number | null = 0
    const suggestedSendQty = Math.max(0, requiredStock - (currentFcStockApprox ?? 0) - (inboundToFc ?? 0))

    const confidenceStatus: ConfidenceStatus = demand30d <= 0
      ? 'low'
      : currentFcStockApprox !== null
        ? 'high'
        : 'medium'

    const action: FcReplenishmentRow['action'] = suggestedSendQty > 0
      ? 'send_to_fc'
      : demand30d > 0
        ? 'monitor'
        : 'no_action'

    const reasonParts: string[] = []
    if (currentFcStockApprox === null) reasonParts.push('FC stock level not available; treated as zero for sizing.')
    reasonParts.push(INBOUND_NOT_INCLUDED_WARNING)

    rows.push({
      productTitle: diag.title,
      asin: diag.asin,
      amazonSku: diag.sku,
      fcCode: diag.fulfillmentCenterId,
      fcType: 'fba_fc',
      zone: null,
      demand30d,
      dailyVelocity: Math.round(dailyVelocity * 100) / 100,
      growthFactor,
      targetStockDays,
      requiredStock,
      currentFcStockApprox,
      inboundToFc,
      suggestedSendQty,
      confidenceStatus,
      action,
      reason: reasonParts.join(' '),
      stateZoneSignal: stateZoneBySku.get(pKey) ?? null,
      paymentSignal: toPaymentSignalSummary(paymentByAmazonSku.get(norm(diag.sku))),
    })
  }

  rows.sort((a, b) => b.suggestedSendQty - a.suggestedSendQty)

  const summary: FcReplenishmentSummary = {
    rows: rows.length,
    skusToSend: rows.filter(row => row.suggestedSendQty > 0).length,
    unitsSuggested: rows.reduce((sum, row) => sum + row.suggestedSendQty, 0),
    rowsNeedingStockContext: rows.filter(row => row.currentFcStockApprox === null).length,
    rowsInboundNotIncluded: rows.length,
    rowsMarginReview: rows.filter(row => row.paymentSignal?.priorityFlag === 'loss_or_review').length,
  }

  return { rows, summary }
}

export function buildFlexReplenishmentRows(input: {
  componentMappings: ComponentMappingRow[]
  planRows: NextStockPlanRow[]
  assumptions: NextStockPlanAssumptions
  inventoryByLocation: InventoryByLocationRow[]
  paymentSignals: PaymentSignalRow[]
  stateZoneDemand: StateZoneDemandSignal[]
  sellerFlexLocationCodes: Set<string>
}): { rows: FlexReplenishmentRow[]; summary: FlexReplenishmentSummary } {
  // Trusted Amazon demand for vendor/component planning combines FBA Ledger Detail
  // shipments at FCs and Seller Flex shipments/sales, since XHZU feeds both channels.
  // Easy Ship/MFN and unattributed sales are excluded because they are not backed by
  // a trusted shipment ledger.
  const demandBySkuNorm = new Map<string, number>()
  for (const row of input.planRows) {
    const skuNorm = norm(row.sku)
    if (!skuNorm) continue
    const trustedDemand = row.fbaSales30d + row.sellerFlexSales30d
    demandBySkuNorm.set(skuNorm, (demandBySkuNorm.get(skuNorm) ?? 0) + trustedDemand)
  }

  const mappingsByComponent = new Map<string, ComponentMappingRow[]>()
  const mappedAmazonSkuNorms = new Set<string>()
  for (const mapping of input.componentMappings) {
    mappedAmazonSkuNorms.add(mapping.amazonSkuNorm)
    const list = mappingsByComponent.get(mapping.componentSkuNorm) ?? []
    list.push(mapping)
    mappingsByComponent.set(mapping.componentSkuNorm, list)
  }

  const xhzuStockByComponent = new Map<string, number>()
  for (const row of input.inventoryByLocation) {
    if (!row.locationCode || !input.sellerFlexLocationCodes.has(norm(row.locationCode))) continue
    const skuNorm = norm(row.sku)
    if (!skuNorm) continue
    const usable = Math.max(0, Math.trunc(row.available - row.reserved - row.unsellable))
    xhzuStockByComponent.set(skuNorm, (xhzuStockByComponent.get(skuNorm) ?? 0) + usable)
  }

  const stateZoneByComponent = new Map<string, string>()
  for (const row of input.stateZoneDemand) {
    if (!row.componentSku || !row.zone) continue
    const skuNorm = norm(row.componentSku)
    if (!stateZoneByComponent.has(skuNorm)) stateZoneByComponent.set(skuNorm, row.zone)
  }

  const paymentByAmazonSku = new Map(
    input.paymentSignals.map(row => [norm(row.amazonSku), row]),
  )

  const targetStockDays = input.assumptions.planningCycleDays + input.assumptions.transitBufferDays
  const lookbackDays = input.assumptions.salesLookbackDays
  const growthFactor = input.assumptions.growthMultiplier

  const rows: FlexReplenishmentRow[] = []
  for (const [componentSkuNorm, mappings] of mappingsByComponent) {
    const componentSku = mappings[0].componentSku
    const amazonSkuNorms = new Set(mappings.map(mapping => mapping.amazonSkuNorm))

    let amazonDemand30d = 0
    let componentAdjustedDemand = 0
    for (const mapping of mappings) {
      const demand = demandBySkuNorm.get(mapping.amazonSkuNorm) ?? 0
      amazonDemand30d += demand
      componentAdjustedDemand += demand * mapping.componentQuantity
    }

    const dailyComponentVelocity = lookbackDays > 0 ? componentAdjustedDemand / lookbackDays : 0
    const requiredComponentStock = Math.ceil(dailyComponentVelocity * growthFactor * targetStockDays)
    const currentXhzuComponentStock = xhzuStockByComponent.has(componentSkuNorm)
      ? xhzuStockByComponent.get(componentSkuNorm)!
      : null

    let suggestedVendorReplenishQty: number | null
    let action: FlexReplenishmentRow['action']
    let reason: string
    if (currentXhzuComponentStock !== null) {
      suggestedVendorReplenishQty = Math.max(0, requiredComponentStock - currentXhzuComponentStock)
      action = suggestedVendorReplenishQty > 0 ? 'send_to_vendor' : 'monitor'
      reason = suggestedVendorReplenishQty > 0
        ? 'Component demand exceeds current Seller Flex stock cover.'
        : 'Component stock cover meets target; no replenishment needed now.'
    } else {
      suggestedVendorReplenishQty = null
      action = 'needs_xhzu_stock_context'
      reason = 'Component stock context is missing.'
    }

    const confidenceStatus: ConfidenceStatus = componentAdjustedDemand <= 0
      ? 'low'
      : currentXhzuComponentStock !== null
        ? 'high'
        : 'medium'

    let paymentSignal: PaymentSignalSummary | null = null
    for (const skuNorm of amazonSkuNorms) {
      const match = paymentByAmazonSku.get(skuNorm)
      if (match) {
        paymentSignal = toPaymentSignalSummary(match)
        break
      }
    }

    rows.push({
      componentSku,
      wmsParentSkuCount: amazonSkuNorms.size,
      linkedAmazonSkuCount: amazonSkuNorms.size,
      amazonDemand30d,
      componentAdjustedDemand,
      dailyComponentVelocity: Math.round(dailyComponentVelocity * 100) / 100,
      growthFactor,
      targetStockDays,
      requiredComponentStock,
      currentXhzuComponentStock,
      suggestedVendorReplenishQty,
      confidenceStatus,
      action,
      reason,
      stateZoneSignal: stateZoneByComponent.get(componentSkuNorm) ?? null,
      paymentSignal,
    })
  }

  rows.sort((a, b) => (b.suggestedVendorReplenishQty ?? 0) - (a.suggestedVendorReplenishQty ?? 0))

  let rowsMissingMapping = 0
  for (const [skuNorm, demand] of demandBySkuNorm) {
    if (demand > 0 && !mappedAmazonSkuNorms.has(skuNorm)) rowsMissingMapping += 1
  }

  const summary: FlexReplenishmentSummary = {
    rows: rows.length,
    componentSkusToReplenish: rows.filter(row => (row.suggestedVendorReplenishQty ?? 0) > 0).length,
    componentUnitsRequired: rows.reduce((sum, row) => sum + (row.suggestedVendorReplenishQty ?? 0), 0),
    rowsNeedingXhzuStockContext: rows.filter(row => row.action === 'needs_xhzu_stock_context').length,
    rowsMissingMapping,
    rowsMarginReview: rows.filter(row => row.paymentSignal?.priorityFlag === 'loss_or_review').length,
  }

  return { rows, summary }
}

export function buildFcStockMatrix(input: {
  fcReplenishmentRows: FcReplenishmentRow[]
  inventoryByLocation: InventoryByLocationRow[]
  sellerFlexLocationCodes: Set<string>
}): { rows: FcStockMatrixRow[]; columns: string[] } {
  const flexStockByAmazonSku = new Map<string, number>()
  for (const row of input.inventoryByLocation) {
    if (!row.locationCode || !input.sellerFlexLocationCodes.has(norm(row.locationCode))) continue
    const skuNorm = norm(row.sku)
    if (!skuNorm) continue
    const usable = Math.max(0, Math.trunc(row.available - row.reserved - row.unsellable))
    flexStockByAmazonSku.set(skuNorm, (flexStockByAmazonSku.get(skuNorm) ?? 0) + usable)
  }

  const rowsByKey = new Map<string, FcStockMatrixRow>()
  const demandByFcCode = new Map<string, number>()

  for (const fc of input.fcReplenishmentRows) {
    const key = `${norm(fc.asin)}|${norm(fc.amazonSku)}`
    let row = rowsByKey.get(key)
    if (!row) {
      const skuNorm = norm(fc.amazonSku)
      row = {
        productTitle: fc.productTitle ?? 'Product title unavailable',
        asin: fc.asin,
        amazonSku: fc.amazonSku,
        totalDemand30d: 0,
        xhzuOrSellerFlexStock: skuNorm && flexStockByAmazonSku.has(skuNorm)
          ? flexStockByAmazonSku.get(skuNorm)!
          : null,
        totalSuggestedSendQty: 0,
        action: 'no_action',
        reason: '',
        fcCells: [],
      }
      rowsByKey.set(key, row)
    }
    row.totalDemand30d += fc.demand30d
    row.totalSuggestedSendQty += fc.suggestedSendQty
    row.fcCells.push({
      fcCode: fc.fcCode,
      zone: fc.zone,
      demand30d: fc.demand30d,
      currentFcStockApprox: fc.currentFcStockApprox,
      inboundToFc: fc.inboundToFc,
      suggestedSendQty: fc.suggestedSendQty,
      action: fc.action,
      reason: fc.reason,
    })
    demandByFcCode.set(fc.fcCode, (demandByFcCode.get(fc.fcCode) ?? 0) + fc.demand30d)
  }

  const rows = [...rowsByKey.values()]
    .map(row => {
      row.fcCells.sort((a, b) => b.demand30d - a.demand30d)
      row.action = row.totalSuggestedSendQty > 0
        ? 'send_to_fc'
        : row.totalDemand30d > 0
          ? 'monitor'
          : 'no_action'
      row.reason = row.totalSuggestedSendQty > 0
        ? 'Demand exceeds FC stock cover at one or more fulfillment centers.'
        : row.totalDemand30d > 0
          ? 'FC stock cover currently meets demand target.'
          : 'No FC shipment demand found in the lookback window.'
      return row
    })
    .sort((a, b) => b.totalSuggestedSendQty - a.totalSuggestedSendQty)

  const columns = [...demandByFcCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fcCode]) => fcCode)

  return { rows, columns }
}
