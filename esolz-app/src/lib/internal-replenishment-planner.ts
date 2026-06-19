export const DEFAULT_REPLENISHMENT_ASSUMPTIONS = {
  salesLookbackDays: 30,
  planningCycleDays: 30,
  transitBufferDays: 15,
  growthMultiplier: 1.5,
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
  runningBalance: number | null
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
  locationCode: string | null
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
  ledgerBalanceStock: number | null
  ledgerBalanceSource: 'fulfillment_report' | null
  ledgerBalanceAmbiguous: boolean
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
  salesLookbackDays: number
  planningCycleDays: number
  transitBufferDays: number
  growthMultiplier: number
  maxLookbackDays: number
}

export type FcDiagnosticRow = {
  asin: string
  sku: string | null
  marketplaceId: string | null
  title: string | null
  fulfillmentCenterId: string
  fulfillmentCenterType: 'seller_flex' | 'fba_fc' | 'unknown'
  shipments30d: number
  ledgerBalanceStock: number | null
  ledgerBalanceAmbiguous: boolean
  latestReportDate: string | null
}

export type NextStockPlanResult = {
  assumptions: NextStockPlanAssumptions
  summary: NextStockPlanSummary
  rows: NextStockPlanRow[]
  fcDiagnostics: FcDiagnosticRow[]
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
  planningCycleDays?: number
  transitBufferDays?: number
  growthMultiplier?: number
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

const FULFILLMENT_DEMAND_EVENT_TYPES = new Set(['shipments'])

function inferFulfillmentSalesUnits(eventType: string | null, quantity: number | null): number {
  if (!Number.isFinite(quantity)) return 0
  const qty = Number(quantity ?? 0)
  const event = (eventType ?? '').trim().toLowerCase()
  if (!FULFILLMENT_DEMAND_EVENT_TYPES.has(event)) return 0
  return Math.abs(Math.trunc(qty))
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

  const resolvedPlanningCycleDays = Math.max(
    1,
    Math.trunc(input.planningCycleDays ?? DEFAULT_REPLENISHMENT_ASSUMPTIONS.planningCycleDays),
  )
  const resolvedTransitBufferDays = Math.max(
    0,
    Math.trunc(input.transitBufferDays ?? DEFAULT_REPLENISHMENT_ASSUMPTIONS.transitBufferDays),
  )
  const resolvedGrowthMultiplier = Number.isFinite(input.growthMultiplier) && (input.growthMultiplier ?? 0) > 0
    ? Number(input.growthMultiplier)
    : DEFAULT_REPLENISHMENT_ASSUMPTIONS.growthMultiplier
  const targetStockDays = resolvedPlanningCycleDays + resolvedTransitBufferDays

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
      targetCoverDays: targetStockDays,
      safetyStock: 0,
      suggestedFbaReplenishment: 0,
      suggestedSellerFlexReplenishment: 0,
      ledgerBalanceStock: null,
      ledgerBalanceSource: null,
      ledgerBalanceAmbiguous: false,
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

    const normalizedLocationCode = norm(row.locationCode)
    const channel = normalizedLocationCode
      ? toLocationType(locationTypeByCode.get(normalizedLocationCode), row.locationCode)
      : channelFromSalesSource(row.source)
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

  const ledgerBalanceByRowKey = new Map<string, { balance: number; reportDate: string; tieCount: number }>()
  for (const row of input.fulfillmentRows) {
    if (row.runningBalance === null || !Number.isFinite(row.runningBalance) || !row.reportDate) continue
    const planRow = resolvePlanRow(row.marketplaceId, row.asin, row.sku)
    if (!planRow) continue
    const key = productKey(planRow.marketplaceId, planRow.asin, planRow.sku)
    const existing = ledgerBalanceByRowKey.get(key)
    if (!existing || row.reportDate > existing.reportDate) {
      ledgerBalanceByRowKey.set(key, { balance: row.runningBalance, reportDate: row.reportDate, tieCount: 1 })
    } else if (row.reportDate === existing.reportDate) {
      ledgerBalanceByRowKey.set(key, {
        balance: row.runningBalance,
        reportDate: row.reportDate,
        tieCount: existing.tieCount + 1,
      })
    }
  }

  const fcDiagnosticsByKey = new Map<string, {
    row: FcDiagnosticRow
    latestBalances: Set<number>
  }>()
  for (const fulfillmentRow of input.fulfillmentRows) {
    const planRow = resolvePlanRow(
      fulfillmentRow.marketplaceId,
      fulfillmentRow.asin,
      fulfillmentRow.sku,
    )
    if (!planRow) continue

    const fulfillmentCenterId = norm(fulfillmentRow.fulfillmentCenterId) || 'UNKNOWN'
    const diagnosticKey = `${productKey(planRow.marketplaceId, planRow.asin, planRow.sku)}|${fulfillmentCenterId}`
    let diagnostic = fcDiagnosticsByKey.get(diagnosticKey)
    if (!diagnostic) {
      const resolvedType = toLocationType(
        locationTypeByCode.get(fulfillmentCenterId),
        fulfillmentRow.fulfillmentCenterId,
      )
      diagnostic = {
        row: {
          asin: planRow.asin,
          sku: planRow.sku,
          marketplaceId: planRow.marketplaceId,
          title: planRow.title,
          fulfillmentCenterId,
          fulfillmentCenterType: resolvedType === 'seller_flex' || resolvedType === 'fba_fc'
            ? resolvedType
            : 'unknown',
          shipments30d: 0,
          ledgerBalanceStock: null,
          ledgerBalanceAmbiguous: false,
          latestReportDate: null,
        },
        latestBalances: new Set<number>(),
      }
      fcDiagnosticsByKey.set(diagnosticKey, diagnostic)
    }

    if (fulfillmentRow.reportDate && fulfillmentRow.reportDate >= startDateIso) {
      diagnostic.row.shipments30d += inferFulfillmentSalesUnits(
        fulfillmentRow.eventType,
        fulfillmentRow.quantity,
      )
    }

    if (
      fulfillmentRow.reportDate
      && fulfillmentRow.runningBalance !== null
      && Number.isFinite(fulfillmentRow.runningBalance)
    ) {
      const balance = Number(fulfillmentRow.runningBalance)
      if (
        !diagnostic.row.latestReportDate
        || fulfillmentRow.reportDate > diagnostic.row.latestReportDate
      ) {
        diagnostic.row.latestReportDate = fulfillmentRow.reportDate
        diagnostic.latestBalances = new Set([balance])
      } else if (fulfillmentRow.reportDate === diagnostic.row.latestReportDate) {
        diagnostic.latestBalances.add(balance)
      }
    }
  }

  const fcDiagnostics = [...fcDiagnosticsByKey.values()]
    .map(diagnostic => {
      const balances = [...diagnostic.latestBalances].sort((a, b) => a - b)
      diagnostic.row.ledgerBalanceStock = balances.length > 0
        ? balances[balances.length - 1]
        : null
      diagnostic.row.ledgerBalanceAmbiguous = balances.length > 1
      return diagnostic.row
    })
    .sort((a, b) => {
      if (b.shipments30d !== a.shipments30d) return b.shipments30d - a.shipments30d
      const productComparison = (a.title ?? a.asin).localeCompare(b.title ?? b.asin)
      if (productComparison !== 0) return productComparison
      return a.fulfillmentCenterId.localeCompare(b.fulfillmentCenterId)
    })

  const rows = [...planRows.values()].map(row => {
    const ledgerEntry = ledgerBalanceByRowKey.get(productKey(row.marketplaceId, row.asin, row.sku))
    row.ledgerBalanceStock = ledgerEntry ? ledgerEntry.balance : null
    row.ledgerBalanceSource = ledgerEntry ? 'fulfillment_report' : null
    row.ledgerBalanceAmbiguous = ledgerEntry ? ledgerEntry.tieCount > 1 : false

    const flags = flagsForRow(row)
    row.totalSales30d = row.fbaSales30d
      + row.sellerFlexSales30d
      + row.easyShipMfnSales30d
      + row.unknownSourceSales30d

    const avgDailyFba = row.fbaSales30d / resolvedLookbackDays
    const avgDailyFlex = row.sellerFlexSales30d / resolvedLookbackDays
    const avgDailyTotal = row.totalSales30d / resolvedLookbackDays

    const adjustedDailyFba = avgDailyFba * resolvedGrowthMultiplier
    const adjustedDailyFlex = avgDailyFlex * resolvedGrowthMultiplier
    const adjustedDailyTotal = avgDailyTotal * resolvedGrowthMultiplier

    const requiredFba = adjustedDailyFba * targetStockDays
    const requiredFlex = adjustedDailyFlex * targetStockDays

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

    row.safetyStock = Math.ceil(adjustedDailyTotal * resolvedTransitBufferDays)
    row.targetCoverDays = targetStockDays

    row.suggestedFbaReplenishment = Math.max(
      0,
      Math.ceil(requiredFba - usableStock(fbaSlice) - fbaSlice.inbound),
    )
    row.suggestedSellerFlexReplenishment = Math.max(
      0,
      Math.ceil(requiredFlex - usableStock(flexSlice) - flexSlice.inbound),
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
      warnings.push('Unattributed daily sales found; fulfillment channel is not identified.')
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
      row.actionMessage = 'Unattributed daily sales signal found; review channel attribution.'
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
      planningCycleDays: resolvedPlanningCycleDays,
      transitBufferDays: resolvedTransitBufferDays,
      growthMultiplier: resolvedGrowthMultiplier,
    },
    summary,
    rows,
    fcDiagnostics,
  }
}
