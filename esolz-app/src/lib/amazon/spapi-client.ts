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
  amazonErrorCode: string | null
}

function safeAmazonErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const sanitized = value.trim().replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 64)
  return sanitized || null
}

/**
 * Calls GET /fba/inbound/v0/shipments with a small status filter purely
 * to test whether the current Amazon authorization includes inbound-shipment
 * access. Never logs or returns the raw response body, shipment IDs, or rows.
 */
export async function probeInboundShipmentsAccess(
  accessToken: string,
  params: InboundShipmentProbeParams,
): Promise<InboundShipmentProbeResult> {
  const endpoint = params.endpoint ?? SPAPI_EU_ENDPOINT

  const qs = new URLSearchParams({
    QueryType:         'SHIPMENT',
    MarketplaceId:     params.marketplaceId,
    ShipmentStatusList: 'WORKING,SHIPPED,RECEIVING,CLOSED',
  })

  const res = await fetch(`${endpoint}/fba/inbound/v0/shipments?${qs}`, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    let amazonErrorCode: string | null = null
    try {
      const errorBody = await res.json() as {
        errors?: Array<{ code?: unknown }>
      }
      amazonErrorCode = safeAmazonErrorCode(errorBody.errors?.[0]?.code)
    } catch {
      // Intentionally ignore malformed/non-JSON bodies and never log raw content.
    }
    return {
      ok: false,
      statusCode: res.status,
      shipmentCount: null,
      amazonErrorCode,
    }
  }

  const data = await res.json() as { payload?: { ShipmentData?: unknown[] } }
  const shipmentCount = Array.isArray(data.payload?.ShipmentData)
    ? data.payload!.ShipmentData!.length
    : 0

  return {
    ok: true,
    statusCode: res.status,
    shipmentCount,
    amazonErrorCode: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders API v0 — read-only. No order-mutation calls exist in this client.
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderSummary {
  amazonOrderId: string
  orderStatus: string | null
  purchaseDate: string | null
  lastUpdateDate: string | null
}

export interface ListOrdersParams {
  marketplaceId: string
  createdAfter: string
  maxResultsPerPage?: number
  endpoint?: string
}

export interface ListOrdersResult {
  ok:              boolean
  statusCode:      number
  orders:          OrderSummary[]
  nextToken:       string | null
  amazonErrorCode: string | null
}

/**
 * Calls GET /orders/v0/orders and returns a small, defensively-parsed list
 * of order summaries (no buyer name/address/phone/email fields are ever
 * read or returned — Amazon's own response for this endpoint does not
 * include them; BuyerInfo requires a separate, restricted-PII endpoint
 * this client intentionally does not call).
 *
 * Never throws on a non-2xx response — returns { ok: false, ... } instead,
 * so callers (e.g. the permission probe) can report a sanitized status
 * rather than crash.
 */
export async function listOrders(
  accessToken: string,
  params: ListOrdersParams,
): Promise<ListOrdersResult> {
  const {
    marketplaceId,
    createdAfter,
    maxResultsPerPage = 5,
    endpoint = SPAPI_EU_ENDPOINT,
  } = params

  const qs = new URLSearchParams({
    MarketplaceIds:     marketplaceId,
    CreatedAfter:       createdAfter,
    MaxResultsPerPage:  String(maxResultsPerPage),
  })

  const res = await fetch(`${endpoint}/orders/v0/orders?${qs}`, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    let amazonErrorCode: string | null = null
    try {
      const errorBody = await res.json() as { errors?: Array<{ code?: unknown }> }
      amazonErrorCode = safeAmazonErrorCode(errorBody.errors?.[0]?.code)
    } catch {
      // Intentionally ignore malformed/non-JSON bodies and never log raw content.
    }
    console.error('[spapi] listOrders error:', res.status)
    return { ok: false, statusCode: res.status, orders: [], nextToken: null, amazonErrorCode }
  }

  const data = await res.json() as {
    payload?: { Orders?: unknown[]; NextToken?: string }
  }
  const rawOrders = Array.isArray(data.payload?.Orders) ? data.payload!.Orders! : []

  const orders: OrderSummary[] = rawOrders
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map(o => ({
      amazonOrderId:  typeof o['AmazonOrderId'] === 'string' ? o['AmazonOrderId'] : '',
      orderStatus:    typeof o['OrderStatus'] === 'string' ? o['OrderStatus'] : null,
      purchaseDate:   typeof o['PurchaseDate'] === 'string' ? o['PurchaseDate'] : null,
      lastUpdateDate: typeof o['LastUpdateDate'] === 'string' ? o['LastUpdateDate'] : null,
    }))
    .filter(o => o.amazonOrderId !== '')

  if (process.env.NODE_ENV !== 'production') {
    console.log('[spapi] listOrders success — count:', orders.length)
  }

  return {
    ok: true,
    statusCode: res.status,
    orders,
    nextToken: typeof data.payload?.NextToken === 'string' ? data.payload.NextToken : null,
    amazonErrorCode: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Solicitations API v1 — GET (eligibility check) only.
//
// Intentionally, this file does not implement
// createProductReviewAndSellerFeedbackSolicitation (the POST that actually
// sends a solicitation) or any other Solicitations write call. Only the
// read-only eligibility check exists here.
// ─────────────────────────────────────────────────────────────────────────────

export interface SolicitationActionsResult {
  ok:              boolean
  statusCode:      number
  actions:         string[]
  amazonErrorCode: string | null
}

export interface GetSolicitationActionsParams {
  amazonOrderId: string
  marketplaceId: string
  endpoint?: string
}

/**
 * Calls GET /solicitations/v1/orders/{amazonOrderId} and returns the list
 * of available solicitation action names (e.g. "productReviewAndSellerFeedback"
 * when eligible). Never returns or logs the raw order id beyond what the
 * caller already supplied, and never returns buyer PII (this endpoint's
 * response does not include any).
 *
 * Never throws on a non-2xx response — returns { ok: false, ... } instead.
 */
export async function getSolicitationActionsForOrder(
  accessToken: string,
  params: GetSolicitationActionsParams,
): Promise<SolicitationActionsResult> {
  const { amazonOrderId, marketplaceId, endpoint = SPAPI_EU_ENDPOINT } = params

  const qs = new URLSearchParams({ marketplaceIds: marketplaceId })
  const url = `${endpoint}/solicitations/v1/orders/${encodeURIComponent(amazonOrderId)}?${qs}`

  const res = await fetch(url, {
    method:  'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'content-type':       'application/json',
    },
  })

  if (!res.ok) {
    let amazonErrorCode: string | null = null
    try {
      const errorBody = await res.json() as { errors?: Array<{ code?: unknown }> }
      amazonErrorCode = safeAmazonErrorCode(errorBody.errors?.[0]?.code)
    } catch {
      // Intentionally ignore malformed/non-JSON bodies and never log raw content.
    }
    console.error('[spapi] getSolicitationActionsForOrder error:', res.status)
    return { ok: false, statusCode: res.status, actions: [], amazonErrorCode }
  }

  const data = await res.json() as {
    _links?: { actions?: Array<{ name?: unknown }> }
  }
  const actions = Array.isArray(data._links?.actions)
    ? data._links!.actions!
        .map(a => (a && typeof a === 'object' && typeof a.name === 'string' ? a.name : null))
        .filter((name): name is string => name !== null)
    : []

  if (process.env.NODE_ENV !== 'production') {
    console.log('[spapi] getSolicitationActionsForOrder success — actions:', actions.length)
  }

  return { ok: true, statusCode: res.status, actions, amazonErrorCode: null }
}
