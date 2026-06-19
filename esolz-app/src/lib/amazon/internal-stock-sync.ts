import 'server-only'

const EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
const NA_ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'

function endpointForMarketplace(marketplaceId: string): string {
  return marketplaceId === 'ATVPDKIKX0DER' ? NA_ENDPOINT : EU_ENDPOINT
}

function safeApiError(scope: string, status: number): Error {
  return new Error(`${scope}_http_${status}`)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export type InventorySummaryNormalized = {
  asin: string | null
  sku: string
  available: number
  inbound: number
  reserved: number
  fulfillable: number
  unfulfillable: number
}

export async function getFbaInventoryPage(params: {
  accessToken: string
  marketplaceId: string
  nextToken?: string
}): Promise<{ rows: InventorySummaryNormalized[]; nextToken: string | null }> {
  const endpoint = endpointForMarketplace(params.marketplaceId)
  const url = new URL(`${endpoint}/fba/inventory/v1/summaries`)
  url.searchParams.set('granularityType', 'Marketplace')
  url.searchParams.set('granularityId', params.marketplaceId)
  url.searchParams.set('marketplaceIds', params.marketplaceId)
  url.searchParams.set('details', 'true')
  if (params.nextToken) url.searchParams.set('nextToken', params.nextToken)

  const response = await fetch(url, {
    headers: {
      'x-amz-access-token': params.accessToken,
      accept: 'application/json',
    },
  })
  if (!response.ok) throw safeApiError('inventory', response.status)

  const data = await response.json() as Record<string, unknown>
  const payload = asRecord(data.payload) ?? data
  const summaries = Array.isArray(payload.inventorySummaries)
    ? payload.inventorySummaries
    : []
  const pagination = asRecord(payload.pagination)

  const rows: InventorySummaryNormalized[] = []
  for (const value of summaries) {
    const summary = asRecord(value)
    if (!summary || typeof summary.sellerSku !== 'string' || !summary.sellerSku.trim()) continue
    const details = asRecord(summary.inventoryDetails) ?? {}
    const reserved = asRecord(details.reservedQuantity)
    const unfulfillable = asRecord(details.unfulfillableQuantity)
    const inbound =
      asNumber(details.inboundWorkingQuantity)
      + asNumber(details.inboundShippedQuantity)
      + asNumber(details.inboundReceivingQuantity)

    rows.push({
      asin: typeof summary.asin === 'string' ? summary.asin : null,
      sku: summary.sellerSku,
      available: asNumber(details.fulfillableQuantity),
      inbound,
      reserved: asNumber(reserved?.totalReservedQuantity),
      fulfillable: asNumber(details.fulfillableQuantity),
      unfulfillable: asNumber(unfulfillable?.totalUnfulfillableQuantity),
    })
  }

  return {
    rows,
    nextToken: typeof pagination?.nextToken === 'string' ? pagination.nextToken : null,
  }
}

export type DailyOrderMetric = {
  salesDate: string
  orderedUnits: number
  orderedRevenue: number | null
}

export async function getDailyOrderMetricsForSku(params: {
  accessToken: string
  marketplaceId: string
  sku: string
  startTime: string
  endTime: string
}): Promise<DailyOrderMetric[]> {
  const endpoint = endpointForMarketplace(params.marketplaceId)
  const url = new URL(`${endpoint}/sales/v1/orderMetrics`)
  url.searchParams.set('marketplaceIds', params.marketplaceId)
  url.searchParams.set('interval', `${params.startTime}--${params.endTime}`)
  url.searchParams.set('granularity', 'Day')
  url.searchParams.set('granularityTimeZone', 'Asia/Kolkata')
  url.searchParams.set('sku', params.sku)

  const response = await fetch(url, {
    headers: {
      'x-amz-access-token': params.accessToken,
      accept: 'application/json',
    },
  })
  if (!response.ok) throw safeApiError('sales', response.status)

  const data = await response.json() as Record<string, unknown>
  const payload = Array.isArray(data.payload) ? data.payload : []
  const rows: DailyOrderMetric[] = []

  for (const value of payload) {
    const metric = asRecord(value)
    if (!metric || typeof metric.interval !== 'string') continue
    const salesDate = metric.interval.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(salesDate)) continue
    const totalSales = asRecord(metric.totalSales)
    const revenue = totalSales?.amount
    const parsedRevenue = revenue === null || revenue === undefined ? null : Number(revenue)

    rows.push({
      salesDate,
      orderedUnits: Math.trunc(asNumber(metric.unitCount)),
      orderedRevenue: parsedRevenue !== null && Number.isFinite(parsedRevenue)
        ? Math.max(0, parsedRevenue)
        : null,
    })
  }

  return rows
}
