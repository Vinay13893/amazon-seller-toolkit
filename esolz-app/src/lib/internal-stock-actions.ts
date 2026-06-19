export const STOCK_TARGET_DAYS = 45
export const OVERSTOCK_DAYS = 90

export type StockStatus = 'OOS' | 'Low stock' | 'Healthy' | 'Overstock' | 'Missing data'

export type StockProductInput = {
  asin: string
  sku: string | null
  marketplaceId: string | null
  title: string | null
  brand: string | null
  imageUrl: string | null
}

export type InventoryInput = {
  asin: string | null
  sku: string
  marketplaceId: string | null
  available: number
  inbound: number
  reserved: number
  lastSyncedAt: string | null
}

export type DailySalesInput = {
  asin: string
  sku: string | null
  marketplaceId: string
  salesDate: string
  orderedUnits: number
}

export type StockAction = {
  asin: string
  sku: string | null
  marketplaceId: string | null
  title: string | null
  brand: string | null
  imageUrl: string | null
  units7d: number | null
  units30d: number | null
  velocityPerDay: number | null
  available: number | null
  inbound: number | null
  reserved: number | null
  daysCover: number | null
  demand45d: number | null
  suggestedReorder: number | null
  status: StockStatus
  action: string
  inventoryUpdatedAt: string | null
  inventorySource?: 'fulfillment_report' | 'inventory_api' | 'missing'
  salesSource?: 'sales_api' | 'csv_upload' | 'missing'
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function matchKey(marketplaceId: string | null, value: string | null): string {
  return `${normalized(marketplaceId)}|${normalized(value)}`
}

function pushMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key.endsWith('|')) {
    const current = map.get(key) ?? []
    current.push(value)
    map.set(key, current)
  }
}

function dateDaysAgo(days: number, now: Date): string {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

export function calculateStockActions(
  products: StockProductInput[],
  inventoryRows: InventoryInput[],
  salesRows: DailySalesInput[],
  now = new Date(),
): StockAction[] {
  const inventoryByAsin = new Map<string, InventoryInput>()
  const inventoryBySku = new Map<string, InventoryInput>()
  const salesByAsin = new Map<string, DailySalesInput[]>()
  const salesBySku = new Map<string, DailySalesInput[]>()

  for (const row of inventoryRows) {
    const asinKey = matchKey(row.marketplaceId, row.asin)
    const skuKey = matchKey(row.marketplaceId, row.sku)
    if (!asinKey.endsWith('|') && !inventoryByAsin.has(asinKey)) inventoryByAsin.set(asinKey, row)
    if (!skuKey.endsWith('|') && !inventoryBySku.has(skuKey)) inventoryBySku.set(skuKey, row)
  }
  for (const row of salesRows) {
    pushMapValue(salesByAsin, matchKey(row.marketplaceId, row.asin), row)
    pushMapValue(salesBySku, matchKey(row.marketplaceId, row.sku), row)
  }

  const start7d = dateDaysAgo(6, now)
  const start30d = dateDaysAgo(29, now)

  return products.map(product => {
    const asinKey = matchKey(product.marketplaceId, product.asin)
    const skuKey = matchKey(product.marketplaceId, product.sku)
    const inventory = inventoryByAsin.get(asinKey) ?? inventoryBySku.get(skuKey)
    const sales = salesByAsin.get(asinKey) ?? salesBySku.get(skuKey) ?? []

    const hasSales = sales.length > 0

    if (!inventory || !hasSales) {
      const missing = [
        !hasSales ? 'sales data' : null,
        !inventory ? 'inventory data' : null,
      ].filter(Boolean).join(' and ')

      return {
        ...product,
        units7d: hasSales
          ? sales.filter(row => row.salesDate >= start7d).reduce((sum, row) => sum + row.orderedUnits, 0)
          : null,
        units30d: hasSales
          ? sales.filter(row => row.salesDate >= start30d).reduce((sum, row) => sum + row.orderedUnits, 0)
          : null,
        velocityPerDay: null,
        available: inventory?.available ?? null,
        inbound: inventory?.inbound ?? null,
        reserved: inventory?.reserved ?? null,
        daysCover: null,
        demand45d: null,
        suggestedReorder: null,
        status: 'Missing data',
        action: `Missing ${missing}.`,
        inventoryUpdatedAt: inventory?.lastSyncedAt ?? null,
      }
    }

    const units7d = sales
      .filter(row => row.salesDate >= start7d)
      .reduce((sum, row) => sum + row.orderedUnits, 0)
    const units30d = sales
      .filter(row => row.salesDate >= start30d)
      .reduce((sum, row) => sum + row.orderedUnits, 0)
    const velocityPerDay = units30d / 30
    const demand45d = Math.ceil(velocityPerDay * STOCK_TARGET_DAYS)
    const suggestedReorder = Math.max(
      0,
      demand45d - inventory.available - inventory.inbound,
    )
    const daysCover = velocityPerDay > 0
      ? inventory.available / velocityPerDay
      : null

    let status: StockStatus
    let action: string

    if (inventory.available <= 0) {
      status = 'OOS'
      action = suggestedReorder > 0
        ? `Replenish ${suggestedReorder} units for the ${STOCK_TARGET_DAYS}-day target.`
        : 'No available stock. Review inbound inventory.'
    } else if (velocityPerDay === 0) {
      status = 'Overstock'
      action = 'No sales velocity in the last 30 days. Review stock exposure.'
    } else if ((daysCover ?? 0) < STOCK_TARGET_DAYS) {
      status = 'Low stock'
      action = suggestedReorder > 0
        ? `Replenish ${suggestedReorder} units for the ${STOCK_TARGET_DAYS}-day target.`
        : 'Inbound stock covers the current replenishment target.'
    } else if ((daysCover ?? 0) > OVERSTOCK_DAYS) {
      status = 'Overstock'
      action = `More than ${OVERSTOCK_DAYS} days of available stock. Review sell-through.`
    } else {
      status = 'Healthy'
      action = 'Stock is within the current coverage target.'
    }

    return {
      ...product,
      units7d,
      units30d,
      velocityPerDay: Number(velocityPerDay.toFixed(2)),
      available: inventory.available,
      inbound: inventory.inbound,
      reserved: inventory.reserved,
      daysCover: daysCover === null ? null : Number(daysCover.toFixed(1)),
      demand45d,
      suggestedReorder,
      status,
      action,
      inventoryUpdatedAt: inventory.lastSyncedAt,
    }
  })
}
