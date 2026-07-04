/**
 * src/lib/amazon/pricing.ts
 *
 * Server-only Amazon Product Pricing helper.
 * Uses Product Pricing API getItemOffers for Buy Box / offers data.
 */

const SPAPI_EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
const SPAPI_NA_ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'

const MARKETPLACE_ENDPOINTS: Record<string, string> = {
  A21TJRUUN4KGV: SPAPI_EU_ENDPOINT, // India
  A1F83G8C2ARO7P: SPAPI_EU_ENDPOINT, // UK
  A1PA6795UKMFR9: SPAPI_EU_ENDPOINT, // DE
  ATVPDKIKX0DER: SPAPI_NA_ENDPOINT, // US
}

export type BuyBoxOfferStatus =
  | 'won'
  | 'lost'
  | 'unknown'
  | 'no_buybox'
  | 'partial_success'
  | 'failed'

export interface PricingSalesRanking {
  category_id: string
  rank: number
}

export interface ItemOffersNormalized {
  asin: string
  marketplace_id: string
  buy_box_price: number | null
  buy_box_currency: string | null
  buy_box_owner: string | null
  buy_box_status: BuyBoxOfferStatus
  number_of_offers: number | null
  number_of_buybox_eligible_offers: number | null
  lowest_price: number | null
  lowest_price_currency: string | null
  your_offer_price: number | null
  buy_box_fulfillment: string | null
  // Summary.ListPrice (MRP) — official discount-signal source (R11.2).
  list_price: number | null
  list_price_currency: string | null
  // Summary.SalesRankings — official BSR fallback when Catalog has no ranks.
  sales_rankings: PricingSalesRanking[]
  offers_raw: unknown[]
  summary_raw: Record<string, unknown> | null
  raw: Record<string, unknown>
}

interface MoneyType {
  CurrencyCode?: string
  Amount?: number | string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseMoney(value: unknown): { amount: number | null; currency: string | null } {
  if (!isRecord(value)) return { amount: null, currency: null }
  const money = value as MoneyType
  return {
    amount: toNumber(money.Amount),
    currency: typeof money.CurrencyCode === 'string' ? money.CurrencyCode : null,
  }
}

function getMarketplaceEndpoint(marketplaceId: string): string {
  return MARKETPLACE_ENDPOINTS[marketplaceId] ?? SPAPI_EU_ENDPOINT
}

function sumOfferCounts(value: unknown): number | null {
  const rows = asRecordArray(value)
  if (rows.length === 0) return null
  let total = 0
  for (const row of rows) {
    const count = toNumber(row.offerCount ?? row.quantity)
    if (count !== null) total += count
  }
  return total
}

function parsePricingPayload(params: {
  payload: Record<string, unknown>
  asin: string
  marketplaceId: string
  sellingPartnerId?: string | null
}): ItemOffersNormalized {
  const summary = isRecord(params.payload.Summary) ? params.payload.Summary : null
  const offers = asRecordArray(params.payload.Offers)

  const buyBoxPrices = asRecordArray(summary?.BuyBoxPrices)
  const lowestPrices = asRecordArray(summary?.LowestPrices)

  const firstBuyBoxPrice = buyBoxPrices[0]
  const firstLowestPrice = lowestPrices[0]

  const bbPriceMoney = parseMoney(firstBuyBoxPrice?.LandedPrice ?? firstBuyBoxPrice?.ListingPrice)
  const lowPriceMoney = parseMoney(firstLowestPrice?.LandedPrice ?? firstLowestPrice?.ListingPrice)

  const winningOffer = offers.find(o => o.IsBuyBoxWinner === true)
  const winningSellerId = typeof winningOffer?.SellerId === 'string' ? winningOffer.SellerId : null

  const winningListingPrice = parseMoney(winningOffer?.ListingPrice)
  const winningShipping = parseMoney(winningOffer?.Shipping)
  const winningCombinedPrice =
    winningListingPrice.amount !== null
      ? winningListingPrice.amount + (winningShipping.amount ?? 0)
      : null

  const buyBoxPrice = bbPriceMoney.amount ?? winningCombinedPrice
  const buyBoxCurrency = bbPriceMoney.currency ?? winningListingPrice.currency

  const listPriceMoney = parseMoney(summary?.ListPrice)

  const salesRankings: PricingSalesRanking[] = []
  for (const ranking of asRecordArray(summary?.SalesRankings)) {
    const categoryId = typeof ranking.ProductCategoryId === 'string' ? ranking.ProductCategoryId : null
    const rank = toNumber(ranking.Rank)
    if (categoryId && rank !== null) salesRankings.push({ category_id: categoryId, rank })
  }

  const totalOfferCount = toNumber(summary?.TotalOfferCount) ?? sumOfferCounts(summary?.NumberOfOffers)
  const buyBoxEligibleOffers = sumOfferCounts(summary?.BuyBoxEligibleOffers)

  const ourOffer =
    params.sellingPartnerId
      ? offers.find(o => o.SellerId === params.sellingPartnerId)
      : null
  const ourListingPrice = parseMoney(ourOffer?.ListingPrice)

  const buyBoxFulfillment =
    typeof firstBuyBoxPrice?.fulfillmentChannel === 'string'
      ? firstBuyBoxPrice.fulfillmentChannel
      : typeof winningOffer?.IsFulfilledByAmazon === 'boolean'
        ? (winningOffer.IsFulfilledByAmazon ? 'FBA' : 'FBM')
        : null

  let status: BuyBoxOfferStatus = 'unknown'
  if (buyBoxPrice === null && (totalOfferCount ?? 0) === 0) {
    status = 'no_buybox'
  } else if (winningSellerId && params.sellingPartnerId) {
    status = winningSellerId === params.sellingPartnerId ? 'won' : 'lost'
  } else if (buyBoxPrice !== null) {
    status = 'unknown'
  } else if ((totalOfferCount ?? 0) > 0 || offers.length > 0) {
    status = 'partial_success'
  } else {
    status = 'no_buybox'
  }

  return {
    asin: params.asin.toUpperCase(),
    marketplace_id: params.marketplaceId,
    buy_box_price: buyBoxPrice,
    buy_box_currency: buyBoxCurrency,
    buy_box_owner: winningSellerId,
    buy_box_status: status,
    number_of_offers: totalOfferCount,
    number_of_buybox_eligible_offers: buyBoxEligibleOffers,
    lowest_price: lowPriceMoney.amount,
    lowest_price_currency: lowPriceMoney.currency,
    your_offer_price: ourListingPrice.amount,
    buy_box_fulfillment: buyBoxFulfillment,
    list_price: listPriceMoney.amount,
    list_price_currency: listPriceMoney.currency,
    sales_rankings: salesRankings,
    offers_raw: offers,
    summary_raw: summary,
    raw: params.payload,
  }
}

export async function getItemOffersForAsin(params: {
  accessToken: string
  marketplaceId: string
  asin: string
  itemCondition?: string
  sellingPartnerId?: string | null
}): Promise<ItemOffersNormalized> {
  const endpoint = getMarketplaceEndpoint(params.marketplaceId)
  const itemCondition = params.itemCondition ?? 'New'

  const url = new URL(`${endpoint}/products/pricing/v0/items/${encodeURIComponent(params.asin)}/offers`)
  url.searchParams.set('MarketplaceId', params.marketplaceId)
  url.searchParams.set('ItemCondition', itemCondition)

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': params.accessToken,
      accept: 'application/json',
    },
  })

  if (!res.ok) {
    if (process.env.NODE_ENV !== 'production') {
      const errBody = await res.text().catch(() => '<unreadable>')
      console.error('[amazon-pricing] getItemOffersForAsin error:', res.status, errBody)
    } else {
      console.error('[amazon-pricing] getItemOffersForAsin error:', res.status)
    }
    throw new Error(`SP-API pricing call failed with HTTP ${res.status}`)
  }

  const data = await res.json() as Record<string, unknown>
  const payload = isRecord(data.payload) ? data.payload : data

  return parsePricingPayload({
    payload,
    asin: params.asin,
    marketplaceId: params.marketplaceId,
    sellingPartnerId: params.sellingPartnerId ?? null,
  })
}
