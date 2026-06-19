export const DEFAULT_REPLENISHMENT_ASSUMPTIONS = {
  targetFbaCoverDays: 45,
  targetFlexCoverDays: 30,
  safetyStockDays: 7,
  salesLookbackDays: 30,
  maxLookbackDays: 365,
} as const

const SELLER_FLEX_CODES = new Set(['XHZU', 'XHZV', 'XHZR', 'TPKR'])
const EASY_SHIP_SOURCES = new Set(['easy_ship', 'easyship', 'mfn', 'merchant_fulfilled'])

type LocationType = 'seller_flex' | 'fba_fc' | 'easy_ship_mfn' | 'unknown'

type ProductInput = {
  asin: string
  sku: string | null
  marketplaceId: string | null
  title: string | null
  brand: string | null
  imageUrl: string | null
}

type SalesInput = {
  asin: string
  sku: string | null
  marketplaceId: string
  salesDate: string
  orderedUnits: number
  source?: string | null
}

type InventoryApiInput = {
  asin: string | null
  sku: string
  marketplaceId: string | null
  available: number
  inbound: number
  reserved: number
  unfulfillable?: number
}

type FulfillmentReportInput = {
  asin: string | null
  sku: string | null
  marketplaceId: string | null
  fulfillmentCenterId: string | null
  eventType: string | null
  quantity: number | null
  reportDate: string | null
}

type FulfillmentLocationInput = {
  locationCode: string
  locationType: string
}

type StateZoneMapInput = {
  stateCode: string
  zoneCode: string
}

type FulfillmentSalesDailyInput = {
  asin: string | null
  sku: string | null
  marketplaceId: string | null
  salesDate: string
  units: number
  stateCode: string | null
  source: string | null
}

type InventoryByLocationInput = {
  asin: string | null
  sku: string | null
  marketplaceId: string | null
  locationCode: string | null
  available: number
  inbound: number
  reserved: number
  unsellable: number
}

export type NextStockPlanRow = {
  asin: string
  sku: string | null
  marketplaceId: string | null
  title: string | null
  brand: string | null
  imageUrl: string | null
  primarySource: 'fulfillment_report' | 'inventory_api' | 'sales_api' | 'csv_upload' | 'missing'
  totalSales30d: number
  fbaSales30d: number
  sellerFlexSales30d: number
  easyShipMfnSales30d: number
  unknownSourceSales30d: number
  availableFbaStock: number
  availableSellerFlexStock: number
  inboundStock: number
  reservedStock: number
  unsellableStock: number
  daysCover: number | null
  targetCoverDays: number
  safetyStock: number
  suggestedFbaReplenishment: number
  suggestedSellerFlexReplenishment: number
  missingDataWarnings: string[]
  stateZoneInsight: string
  actionMessage: string
}

export type NextStockPlanSummary = {
  fbaReplenishmentNeeded: number
  sellerFlexReplenishmentNeeded: number
  productsMissingStockData: number
  productsUnknownSourceSales: number
  zoneMappingGaps: number
}

export type NextStockPlanAssumptions = {
  targetFbaCoverDays: number
  targetFlexCoverDays: number
  safetyStockDays: number
  salesLookbackDays: number
  maxLookbackDays: number
}

export type NextStockPlanResult = {
  assumptions: NextStockPlanAssumptions
  summary: NextStockPlanSummary
  rows: NextStockPlanRow[]
}

type BuildInput = {
  products: ProductInput[]
  salesRows: SalesInput[]
  inventoryApiRows: InventoryApiInput[]
  fulfillmentRows: FulfillmentReportInput[]
  fulfillmentLocations: FulfillmentLocationInput[]
  stateZoneMap: StateZoneMapInput[]
  fulfillmentSalesDaily: FulfillmentSalesDailyInput[]
  inventoryByLocation: InventoryByLocationInput[]
  lookbackDays?: number
  now?: Date
}

type StockSlice = {
  available: number
  inbound: number
  reserved: number
  unsellable: number
}

function norm(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function productKey(marketplaceId: string | null, asin: string | null, sku: string | null): string {
  return `${norm(marketplaceId)}|${norm(asin)}|${norm(sku)}`
}

function usableStock(slice: StockSlice): number {
  return Math.max(0, slice.available - slice.reserved - slice.unsellable)
}

function safeRound(value: number, decimals = 1): number {
  const base = 10 ** decimals
  return Math.round(value * base) / base
}

function toLocationType(value: string | null | undefined, locationCode: string | null | undefined): LocationType {
  const normalizedCode = norm(locationCode)
  if (SELLER_FLEX_CODES.has(normalizedCode)) return 'seller_flex'

  const normalizedType = norm(value)
  if (normalizedType === 'SELLER_FLEX') return 'seller_flex'
  if (normalizedType === 'FBA_FC') return 'fba_fc'
  if (normalizedType === 'EASY_SHIP_MFN') return 'easy_ship_mfn'
  if (normalizedType === 'UNKNOWN') return 'unknown'

  if (normalizedCode) return 'fba_fc'
  return 'unknown'
}

function channelFromSalesSource(source: string | null | undefined): LocationType {
  const normalized = norm(source).toLowerCase()
  if (!normalized) return 'unknown'
  if (EASY_SHIP_SOURCES.has(normalized)) return 'easy_ship_mfn'
  if (normalized === 'seller_flex') return 'seller_flex'
  if (normalized === 'fba_fc' || normalized === 'fba') return 'fba_fc'
  return 'unknown'
}

function inferFulfillmentSalesUnits(eventType: string | null, quantity: number | null): number {
  if (!Number.isFinite(quantity)) return 0
  const qty = Number(quantity ?? 0)
  const event = (eventType ?? '').toLowerCase()
  const salesEvent = event.includes('sale')
    || event.includes('ship')
    || event.includes('customer')
    || event.includes('order')

  if (salesEvent) return Math.abs(Math.trunc(qty))
  if (qty < 0) return Math.abs(Math.trunc(qty))
  return 0
}

export function buildNextStockPlan(input: BuildInput): NextStockPlanResult {
  const now = input.now ?? new Date()
  const resolvedLookbackDays = Math.max(
    1,
    Math.min(
      DEFAULT_REPLENISHMENT_ASSUMPTIONS.maxLookbackDays,
      Math.trunc(input.lookbackDays ?? DEFAULT_REPLENISHMENT_ASSUMPTIONS.salesLookbackDays),
    ),
  )
  const startDate = new Date(now)
  startDate.setUTCDate(startDate.getUTCDate() - (resolvedLookbackDays - 1))
  const startDateIso = startDate.toISOString().slice(0, 10)

  const locationTypeByCode = new Map<string, LocationType>()
  for (const code of SELLER_FLEX_CODES) locationTypeByCode.set(code, 'seller_flex')
  for (const location of input.fulfillmentLocations) {
    const code = norm(location.locationCode)
    if (!code) continue
    locationTypeByCode.set(code, toLocationType(location.locationType, location.locationCode))
  }

  const zoneByState = new Map<string, string>()
  for (const row of input.stateZoneMap) {
    const state = norm(row.stateCode)
    const zone = norm(row.zoneCode)
    if (state && zone) zoneByState.set(state, zone)
  }

  const productsByAsin = new Map<string, ProductInput>()
  const productsBySku = new Map<string, ProductInput>()
  for (const product of input.products) {
    if (product.asin) productsByAsin.set(productKey(product.marketplaceId, product.asin, null), product)
    if (product.sku) productsBySku.set(productKey(product.marketplaceId, null, product.sku), product)
  }

  const planRows = new Map<string, NextStockPlanRow>()
  const resolvePlanRow = (
    marketplaceId: string | null,
    asin: string | null,
    sku: string | null,
  ): NextStockPlanRow | null => {
    const byAsin = asin ? productsByAsin.get(productKey(marketplaceId, asin, null)) : null
    const bySku = sku ? productsBySku.get(productKey(marketplaceId, null, sku)) : null
    const product = byAsin ?? bySku
    if (!product) return null

    const key = productKey(product.marketplaceId, product.asin, product.sku)
    const existing = planRows.get(key)
    if (existing) return existing

    const created: NextStockPlanRow = {
      asin: product.asin,
      sku: product.sku,
      marketplaceId: product.marketplaceId,
      title: product.title,
      brand: product.brand,
      imageUrl: product.imageUrl,
      primarySource: 'missing',
      totalSales30d: 0,
      fbaSales30d: 0,
      sellerFlexSales30d: 0,
      easyShipMfnSales30d: 0,
      unknownSourceSales30d: 0,
      availableFbaStock: 0,
      availableSellerFlexStock: 0,
      inboundStock: 0,
      reservedStock: 0,
      unsellableStock: 0,
      daysCover: null,
      targetCoverDays: DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFbaCoverDays,
      safetyStock: 0,
      suggestedFbaReplenishment: 0,
      suggestedSellerFlexReplenishment: 0,
      missingDataWarnings: [],
      stateZoneInsight: 'State/zone sales not available yet.',
      actionMessage: 'Sales exist but inventory missing; sync fulfillment report.',
    }
    planRows.set(key, created)
    return created
  }

  const productFlags = new Map<string, {
    hasFulfillmentReportData: boolean
    hasInventoryApiData: boolean
    hasSalesApiData: boolean
    hasCsvSalesData: boolean
    fcWiseStockAvailable: boolean
    states: Map<string, number>
    zones: Map<string, number>
    unmappedStateCount: number
  }>()

  const flagsForRow = (row: NextStockPlanRow) => {
    const key = productKey(row.marketplaceId, row.asin, row.sku)
    const existing = productFlags.get(key)
    if (existing) return existing
    const created = {
      hasFulfillmentReportData: false,
      hasInventoryApiData: false,
      hasSalesApiData: false,
      hasCsvSalesData: false,
      fcWiseStockAvailable: false,
      states: new Map<string, number>(),
      zones: new Map<string, number>(),
      unmappedStateCount: 0,
    }
    productFlags.set(key, created)
    return created
  }

  for (const row of input.inventoryByLocation) {
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const flags = flagsForRow(planRow)
    flags.fcWiseStockAvailable = true

    const locationType = toLocationType(locationTypeByCode.get(norm(row.locationCode)), row.locationCode)
    const available = Math.max(0, Math.trunc(Number(row.available ?? 0)))
    const inbound = Math.max(0, Math.trunc(Number(row.inbound ?? 0)))
    const reserved = Math.max(0, Math.trunc(Number(row.reserved ?? 0)))
    const unsellable = Math.max(0, Math.trunc(Number(row.unsellable ?? 0)))

    if (locationType === 'seller_flex') {
      planRow.availableSellerFlexStock += available
    } else if (locationType === 'fba_fc') {
      planRow.availableFbaStock += available
    }
    planRow.inboundStock += inbound
    planRow.reservedStock += reserved
    planRow.unsellableStock += unsellable
  }

  for (const row of input.inventoryApiRows) {
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const flags = flagsForRow(planRow)
    flags.hasInventoryApiData = true

    if (!flags.fcWiseStockAvailable) {
      planRow.availableFbaStock = Math.max(0, Math.trunc(Number(row.available ?? 0)))
      planRow.inboundStock = Math.max(0, Math.trunc(Number(row.inbound ?? 0)))
      planRow.reservedStock = Math.max(0, Math.trunc(Number(row.reserved ?? 0)))
      planRow.unsellableStock = Math.max(0, Math.trunc(Number(row.unfulfillable ?? 0)))
    }
  }

  for (const row of input.fulfillmentRows) {
    if (!row.reportDate || row.reportDate < startDateIso) continue
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const flags = flagsForRow(planRow)
    flags.hasFulfillmentReportData = true

    const units = inferFulfillmentSalesUnits(row.eventType, row.quantity)
    if (units <= 0) continue

    const locationType = toLocationType(locationTypeByCode.get(norm(row.fulfillmentCenterId)), row.fulfillmentCenterId)
    if (locationType === 'seller_flex') {
      planRow.sellerFlexSales30d += units
    } else if (locationType === 'fba_fc') {
      planRow.fbaSales30d += units
    } else {
      planRow.unknownSourceSales30d += units
    }
  }

  for (const row of input.salesRows) {
    if (!row.salesDate || row.salesDate < startDateIso) continue
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const flags = flagsForRow(planRow)
    const units = Math.max(0, Math.trunc(Number(row.orderedUnits ?? 0)))
    if (units <= 0) continue

    const normalizedSource = norm(row.source).toLowerCase()
    if (normalizedSource === 'amazon_api' || normalizedSource === 'sales_api') {
      flags.hasSalesApiData = true
    }
    if (normalizedSource === 'csv_upload') {
      flags.hasCsvSalesData = true
    }

    const channel = channelFromSalesSource(row.source)
    if (channel === 'easy_ship_mfn') {
      planRow.easyShipMfnSales30d += units
    } else {
      planRow.unknownSourceSales30d += units
    }
  }

  for (const row of input.fulfillmentSalesDaily) {
    if (!row.salesDate || row.salesDate < startDateIso) continue
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const flags = flagsForRow(planRow)
    const units = Math.max(0, Math.trunc(Number(row.units ?? 0)))
    if (units <= 0) continue

    const state = norm(row.stateCode)
    if (state) {
      flags.states.set(state, (flags.states.get(state) ?? 0) + units)
      const zone = zoneByState.get(state)
      if (zone) {
        flags.zones.set(zone, (flags.zones.get(zone) ?? 0) + units)
      } else {
        flags.unmappedStateCount += 1
      }
    }

    const channel = channelFromSalesSource(row.source)
    if (channel === 'seller_flex') {
      planRow.sellerFlexSales30d += units
    } else if (channel === 'fba_fc') {
      planRow.fbaSales30d += units
    } else if (channel === 'easy_ship_mfn') {
      planRow.easyShipMfnSales30d += units
    } else {
      planRow.unknownSourceSales30d += units
    }
  }

  const rows = [...planRows.values()].map(row => {
    const flags = flagsForRow(row)
    row.totalSales30d = row.fbaSales30d
      + row.sellerFlexSales30d
      + row.easyShipMfnSales30d
      + row.unknownSourceSales30d

    const avgDailyFba = row.fbaSales30d / resolvedLookbackDays
    const avgDailyFlex = row.sellerFlexSales30d / resolvedLookbackDays
    const avgDailyTotal = row.totalSales30d / resolvedLookbackDays

    const expectedFba = avgDailyFba * DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFbaCoverDays
    const expectedFlex = avgDailyFlex * DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFlexCoverDays
    const safetyFba = avgDailyFba * DEFAULT_REPLENISHMENT_ASSUMPTIONS.safetyStockDays
    const safetyFlex = avgDailyFlex * DEFAULT_REPLENISHMENT_ASSUMPTIONS.safetyStockDays

    const fbaSlice: StockSlice = {
      available: row.availableFbaStock,
      inbound: row.inboundStock,
      reserved: row.reservedStock,
      unsellable: row.unsellableStock,
    }
    const flexSlice: StockSlice = {
      available: row.availableSellerFlexStock,
      inbound: row.inboundStock,
      reserved: row.reservedStock,
      unsellable: row.unsellableStock,
    }

    row.safetyStock = Math.ceil(avgDailyTotal * DEFAULT_REPLENISHMENT_ASSUMPTIONS.safetyStockDays)
    row.targetCoverDays = row.sellerFlexSales30d > 0
      ? Math.max(
          DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFbaCoverDays,
          DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFlexCoverDays,
        )
      : DEFAULT_REPLENISHMENT_ASSUMPTIONS.targetFbaCoverDays

    row.suggestedFbaReplenishment = Math.max(
      0,
      Math.ceil(expectedFba + safetyFba - usableStock(fbaSlice) - fbaSlice.inbound),
    )
    row.suggestedSellerFlexReplenishment = Math.max(
      0,
      Math.ceil(expectedFlex + safetyFlex - usableStock(flexSlice) - flexSlice.inbound),
    )

    const usableTotal = usableStock({
      available: row.availableFbaStock + row.availableSellerFlexStock,
      inbound: row.inboundStock,
      reserved: row.reservedStock,
      unsellable: row.unsellableStock,
    })
    row.daysCover = avgDailyTotal > 0 ? safeRound(usableTotal / avgDailyTotal, 1) : null

    const warnings: string[] = []
    if (!flags.fcWiseStockAvailable) {
      warnings.push('FC/warehouse-wise stock not available yet.')
    }
    if (row.totalSales30d > 0 && row.availableFbaStock + row.availableSellerFlexStock <= 0) {
      warnings.push('Sales exist but inventory missing; sync fulfillment report.')
    }
    if (row.unknownSourceSales30d > 0) {
      warnings.push('Unknown source sales found; do not ignore.')
    }
    if (row.easyShipMfnSales30d > 0) {
      warnings.push('Easy Ship sales found; keep separate from FBA replenishment.')
    }
    if (flags.unmappedStateCount > 0) {
      warnings.push('Zone mapping missing; add state-zone map.')
    }

    if (flags.states.size > 0) {
      const topState = [...flags.states.entries()].sort((a, b) => b[1] - a[1])[0]
      if (flags.unmappedStateCount > 0) {
        row.stateZoneInsight = `Zone mapping missing for ${flags.unmappedStateCount.toLocaleString('en-IN')} state rows.`
      } else if (flags.zones.size > 0) {
        const topZone = [...flags.zones.entries()].sort((a, b) => b[1] - a[1])[0]
        row.stateZoneInsight = `Top state ${topState[0]} (${topState[1].toLocaleString('en-IN')}); top zone ${topZone[0]} (${topZone[1].toLocaleString('en-IN')}).`
      } else {
        row.stateZoneInsight = `Top state ${topState[0]} (${topState[1].toLocaleString('en-IN')}).`
      }
    }

    row.missingDataWarnings = warnings

    if (flags.hasFulfillmentReportData) {
      row.primarySource = 'fulfillment_report'
    } else if (flags.hasInventoryApiData) {
      row.primarySource = 'inventory_api'
    } else if (flags.hasSalesApiData) {
      row.primarySource = 'sales_api'
    } else if (flags.hasCsvSalesData) {
      row.primarySource = 'csv_upload'
    } else {
      row.primarySource = 'missing'
    }

    if (row.suggestedFbaReplenishment > 0) {
      row.actionMessage = 'Plan FBA replenishment: demand exceeds cover target.'
    } else if (row.suggestedSellerFlexReplenishment > 0) {
      row.actionMessage = 'Seller Flex demand found; check XHZU/XHZV/XHZR/TPKR stock.'
    } else if (row.easyShipMfnSales30d > 0) {
      row.actionMessage = 'Easy Ship sales found; keep separate from FBA replenishment.'
    } else if (row.unknownSourceSales30d > 0) {
      row.actionMessage = 'Unknown source sales found; do not ignore.'
    } else if (flags.unmappedStateCount > 0) {
      row.actionMessage = 'Zone mapping missing; add state-zone map.'
    } else if (warnings.length > 0) {
      row.actionMessage = warnings[0]
    } else {
      row.actionMessage = 'Stock cover is within target for the current lookback window.'
    }

    return row
  }).sort((a, b) => {
    const criticalA = a.suggestedFbaReplenishment + a.suggestedSellerFlexReplenishment
    const criticalB = b.suggestedFbaReplenishment + b.suggestedSellerFlexReplenishment
    return criticalB - criticalA
  })

  const summary: NextStockPlanSummary = {
    fbaReplenishmentNeeded: rows.filter(row => row.suggestedFbaReplenishment > 0).length,
    sellerFlexReplenishmentNeeded: rows.filter(row => row.suggestedSellerFlexReplenishment > 0).length,
    productsMissingStockData: rows.filter(row => row.missingDataWarnings.includes('Sales exist but inventory missing; sync fulfillment report.')).length,
    productsUnknownSourceSales: rows.filter(row => row.unknownSourceSales30d > 0).length,
    zoneMappingGaps: rows.filter(row => row.missingDataWarnings.includes('Zone mapping missing; add state-zone map.')).length,
  }

  return {
    assumptions: {
      ...DEFAULT_REPLENISHMENT_ASSUMPTIONS,
      salesLookbackDays: resolvedLookbackDays,
    },
    summary,
    rows,
  }
}