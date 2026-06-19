/**
 * src/lib/amazon/spapi-client.ts
 *
 * Thin SP-API client helpers — server-only.
 *
 * SECURITY: accessToken must NEVER be logged or returned to the frontend.
 * Always call these helpers from server-side API route handlers only.
 */

const SPAPI_EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'

export interface SPAPIMarketplace {
  id:                  string
  name:                string
  countryCode:         string
  defaultCurrencyCode: string
  domainName:          string
}

export interface SPAPIParticipation {
  isParticipating:      boolean
  hasSuspendedListings: boolean
}

export interface MarketplaceParticipation {
  marketplace:    SPAPIMarketplace
  participation:  SPAPIParticipation
}

export interface MarketplaceParticipationsResponse {
  payload?: MarketplaceParticipation[]
  errors?:  Array<{ code: string; message: string; details?: string }>
}

/**
 * Calls GET /sellers/v1/marketplaceParticipations and returns the raw response.
 *
 * @param accessToken  Fresh LWA access token — never log this value
 * @param endpoint     SP-API regional endpoint (defaults to EU which covers India)
 * @throws Error with a safe message on non-2xx response
 */
export async function getMarketplaceParticipations(
  accessToken: string,
  endpoint = SPAPI_EU_ENDPOINT,
): Promise<MarketplaceParticipationsResponse> {
  const url = `${endpoint}/sellers/v1/marketplaceParticipations`

  const res = await fetch(url, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    console.error('[spapi] getMarketplaceParticipations error:', res.status)
    throw new Error(`SP-API call failed with HTTP ${res.status}`)
  }

  const data = await res.json() as MarketplaceParticipationsResponse

  if (process.env.NODE_ENV !== 'production') {
    console.log('[spapi] getMarketplaceParticipations success — payload count:', data.payload?.length ?? 0)
  }

  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings Items API
// ─────────────────────────────────────────────────────────────────────────────

export interface ListingItemSummary {
  marketplaceId:  string
  asin?:          string
  productType?:   string
  status?:        string[]
  itemName?:      string
  createdDate?:   string
  lastUpdatedDate?: string
  mainImage?: {
    link?:   string
    height?: number
    width?:  number
  }
}

export interface ListingItemAttributes {
  brand?: Array<{ value?: string }>
  item_name?: Array<{ value?: string }>
  [key: string]: unknown
}

export interface ListingItem {
  sku:          string
  summaries?:   ListingItemSummary[]
  attributes?:  ListingItemAttributes
  issues?:      unknown[]
}

export interface SearchListingsPagination {
  nextToken?:     string
  previousToken?: string
}

export interface SearchListingsResponse {
  numberOfResults: number
  /**
   * Amazon wraps the pagination token in a nested `pagination` object.
   * Shape: { pagination: { nextToken?: string } }
   * Do NOT read top-level `nextPageToken` — it does not exist in the real response.
   */
  pagination?:     SearchListingsPagination
  items?:          ListingItem[]
  errors?:         Array<{ code: string; message: string; details?: string }>
}

/**
 * Extracts the next-page token from a searchListingsItems response.
 *
 * Amazon's real response shape (v2021-08-01):
 *   response.pagination.nextToken
 *
 * This helper is defensive: it also checks the (incorrect) top-level
 * `nextPageToken` and `nextToken` fields in case Amazon ever changes the shape.
 */
export function extractNextPageToken(
  res: SearchListingsResponse & Record<string, unknown>,
): string | undefined {
  // Primary: nested pagination object (documented shape)
  if (res.pagination?.nextToken) return res.pagination.nextToken
  // Fallback: top-level variants (undocumented but guard against shape changes)
  if (typeof res['nextPageToken'] === 'string' && res['nextPageToken']) return res['nextPageToken'] as string
  if (typeof res['nextToken']     === 'string' && res['nextToken'])     return res['nextToken']     as string
  return undefined
}

export interface SearchListingsParams {
  sellerId:      string
  marketplaceId: string
  pageSize?:     number
  pageToken?:    string
  endpoint?:     string
}

/**
 * Calls GET /listings/2021-08-01/items/{sellerId}
 * Returns catalog + listing metadata for all seller SKUs in the marketplace.
 *
 * @param accessToken  Fresh LWA access token — never log this value
 * @throws Error with a safe message on non-2xx response
 */
export async function searchListingsItems(
  accessToken: string,
  params: SearchListingsParams,
): Promise<SearchListingsResponse> {
  const {
    sellerId,
    marketplaceId,
    pageSize  = 20,
    pageToken,
    endpoint  = SPAPI_EU_ENDPOINT,
  } = params

  const qs = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData:   'summaries,attributes,issues',
    pageSize:       String(pageSize),
  })
  if (pageToken) qs.set('pageToken', pageToken)

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}?${qs}`

  const res = await fetch(url, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    console.error('[spapi] searchListingsItems error:', res.status)
    throw new Error(`SP-API listings call failed with HTTP ${res.status}`)
  }

  const data = await res.json() as SearchListingsResponse & Record<string, unknown>

  if (process.env.NODE_ENV !== 'production') {
    const nextTok = extractNextPageToken(data)
    console.log(
      '[spapi] searchListingsItems page —',
      'items:', data.items?.length ?? 0,
      '| total:', data.numberOfResults,
      '| hasNextToken:', !!nextTok,
    )
  }

  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Fulfillment Inbound Shipment v0 — permission probe only.
// Intentionally does not parse or return shipment details/IDs.
// ─────────────────────────────────────────────────────────────────────────────

export interface InboundShipmentProbeParams {
  marketplaceId: string
  endpoint?: string
}

export interface InboundShipmentProbeResult {
  ok:            boolean
  statusCode:    number
  shipmentCount: number | null
}

/**
 * Calls GET /fba/inbound/v0/shipments with a narrow recent date range purely
 * to test whether the current Amazon authorization includes inbound-shipment
 * access. Never logs or returns the raw response body, shipment IDs, or rows.
 */
export async function probeInboundShipmentsAccess(
  accessToken: string,
  params: InboundShipmentProbeParams,
): Promise<InboundShipmentProbeResult> {
  const endpoint = params.endpoint ?? SPAPI_EU_ENDPOINT
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const qs = new URLSearchParams({
    QueryType:          'DATE_RANGE',
    MarketplaceId:      params.marketplaceId,
    LastUpdatedAfter:   sevenDaysAgo.toISOString(),
    LastUpdatedBefore:  now.toISOString(),
  })

  const res = await fetch(`${endpoint}/fba/inbound/v0/shipments?${qs}`, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    return { ok: false, statusCode: res.status, shipmentCount: null }
  }

  const data = await res.json() as { payload?: { ShipmentData?: unknown[] } }
  const shipmentCount = Array.isArray(data.payload?.ShipmentData)
    ? data.payload!.ShipmentData!.length
    : 0

  return { ok: true, statusCode: res.status, shipmentCount }
}
