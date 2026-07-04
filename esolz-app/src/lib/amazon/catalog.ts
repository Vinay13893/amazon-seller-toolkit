/**
 * src/lib/amazon/catalog.ts
 *
 * Server-only Amazon Catalog Items helper.
 *
 * SECURITY: accessToken must never be logged or returned to the frontend.
 */

const SPAPI_EU_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
const SPAPI_NA_ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'

const MARKETPLACE_ENDPOINTS: Record<string, string> = {
  A21TJRUUN4KGV: SPAPI_EU_ENDPOINT, // Amazon India
  ATVPDKIKX0DER:  SPAPI_NA_ENDPOINT, // Amazon US
  A1F83G8C2ARO7P: SPAPI_EU_ENDPOINT, // Amazon UK
  A1PA6795UKMFR9: SPAPI_EU_ENDPOINT, // Amazon Germany
}

export interface CatalogRankEntry {
  category: string | null
  category_id: string | null
  rank: number
  rank_type: 'display_group' | 'classification'
}

export interface CatalogItemNormalized {
  asin: string
  title: string | null
  brand: string | null
  image_url: string | null
  category: string | null
  bsr: number | null
  bsr_category: string | null
  bsr_ranks: CatalogRankEntry[]
}

interface CatalogItemsResponse {
  payload?: unknown
  errors?: Array<{ code: string; message: string; details?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = toStringOrNull(value)
    if (str) return str
  }
  return null
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function getMarketplaceEndpoint(marketplaceId: string): string {
  return MARKETPLACE_ENDPOINTS[marketplaceId] ?? SPAPI_EU_ENDPOINT
}

function marketplaceRecords(value: unknown, marketplaceId: string): Record<string, unknown>[] {
  const records = asRecordArray(value)
  const matching = records.filter(record => record.marketplaceId === marketplaceId)
  return matching.length > 0 ? matching : records
}

function extractImageUrl(item: Record<string, unknown>, marketplaceId: string): string | null {
  const images = marketplaceRecords(item.images, marketplaceId)
  for (const image of images) {
    const link = firstString(image.link, image.url)
    if (link) return link

    const imageVariants = asRecordArray(image.images)
    for (const nested of imageVariants) {
      const nestedLink = firstString(nested.link, nested.url, nested.imageUrl)
      if (nestedLink) return nestedLink
    }
  }

  const summaries = asRecordArray(item.summaries)
  for (const summary of summaries) {
    const mainImage = isRecord(summary.mainImage) ? summary.mainImage : null
    const link = firstString(summary.link, mainImage?.link)
    if (link) return link
  }

  return null
}

function extractCatalogMeta(item: Record<string, unknown>, marketplaceId: string) {
  const summaries = marketplaceRecords(item.summaries, marketplaceId)
  const attributeSets = asRecordArray(item.attributeSets)
  const attributes = isRecord(item.attributes) ? item.attributes : null
  const productTypes = asRecordArray(item.productTypes)
  const salesRanks = asRecordArray(item.salesRanks)

  const title = firstString(
    summaries[0]?.itemName,
    summaries[0]?.title,
    item.itemName,
    item.title,
    attributes?.item_name && Array.isArray(attributes.item_name) ? (attributes.item_name[0] as Record<string, unknown> | undefined)?.value : null,
    attributeSets[0]?.item_name && Array.isArray(attributeSets[0].item_name) ? (attributeSets[0].item_name[0] as Record<string, unknown> | undefined)?.value : null,
  )

  const brand = firstString(
    summaries[0]?.brand,
    isRecord(summaries[0]?.byLineInfo) ? summaries[0].byLineInfo.brandName : null,
    isRecord(summaries[0]?.byLineInfo) ? summaries[0].byLineInfo.brand : null,
    item.brand,
    attributes?.brand && Array.isArray(attributes.brand) ? (attributes.brand[0] as Record<string, unknown> | undefined)?.value : null,
    attributeSets[0]?.brand && Array.isArray(attributeSets[0].brand) ? (attributeSets[0].brand[0] as Record<string, unknown> | undefined)?.value : null,
  )

  const category = firstString(
    summaries[0]?.itemClassification,
    summaries[0]?.classification,
    summaries[0]?.productType,
    productTypes[0]?.name,
    productTypes[0]?.productType,
    productTypes[0]?.displayName,
  )

  // Catalog Items 2022-04-01 nests ranks inside displayGroupRanks /
  // classificationRanks per marketplace record; the rank is NOT on the
  // top-level salesRanks entry (R11.2: this was why stored BSR was ~always null).
  const parseRankNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  const bsrRanks: CatalogRankEntry[] = []
  for (const marketRank of salesRanks) {
    for (const dg of asRecordArray(marketRank.displayGroupRanks)) {
      const rank = parseRankNumber(dg.rank)
      if (rank !== null) {
        bsrRanks.push({
          category: firstString(dg.title, dg.displayName),
          category_id: firstString(dg.websiteDisplayGroup),
          rank,
          rank_type: 'display_group',
        })
      }
    }
    for (const cl of asRecordArray(marketRank.classificationRanks)) {
      const rank = parseRankNumber(cl.rank)
      if (rank !== null) {
        bsrRanks.push({
          category: firstString(cl.title, cl.displayName),
          category_id: firstString(cl.classificationId),
          rank,
          rank_type: 'classification',
        })
      }
    }
    // Legacy shape fallback (rank directly on the record).
    const legacyRank = parseRankNumber(marketRank.rank ?? marketRank.salesRank ?? marketRank.rankNumber)
    if (legacyRank !== null) {
      bsrRanks.push({
        category: firstString(marketRank.classificationName, marketRank.displayName, marketRank.title, marketRank.name),
        category_id: null,
        rank: legacyRank,
        rank_type: 'classification',
      })
    }
  }

  // Main BSR = top-level display-group rank (e.g. "Home & Kitchen"),
  // falling back to the first classification rank.
  const mainRank = bsrRanks.find(r => r.rank_type === 'display_group') ?? bsrRanks[0] ?? null
  const bsr: number | null = mainRank?.rank ?? null
  const bsrCategory: string | null = mainRank?.category ?? null

  return {
    title,
    brand,
    image_url: extractImageUrl(item, marketplaceId),
    category,
    bsr,
    bsr_category: bsrCategory,
    bsr_ranks: bsrRanks,
  }
}

export async function getCatalogItemForAsin(params: {
  accessToken: string
  marketplaceId: string
  asin: string
  signal?: AbortSignal
}): Promise<CatalogItemNormalized> {
  const endpoint = getMarketplaceEndpoint(params.marketplaceId)
  const url = new URL(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(params.asin)}`)
  url.searchParams.set('marketplaceIds', params.marketplaceId)
  url.searchParams.set('includedData', 'summaries,images,attributes,salesRanks,identifiers,productTypes')

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': params.accessToken,
      accept: 'application/json',
    },
    signal: params.signal,
  })

  if (!res.ok) {
    console.error('[amazon-catalog] getCatalogItemForAsin error:', res.status)
    throw new Error(res.status === 404 ? 'catalog_not_found' : 'catalog_unavailable')
  }

  const data = await res.json() as CatalogItemsResponse & Record<string, unknown>
  const payload = data.payload ?? data
  const payloadRecord = isRecord(payload) ? payload : null
  const payloadItems = payloadRecord ? asRecordArray(payloadRecord.items) : []
  const dataItems = asRecordArray(data.items)
  const item = Array.isArray(payload)
    ? payload.find(isRecord)
    : payloadItems[0]
      ?? dataItems[0]
      ?? (payloadRecord && isRecord(payloadRecord.item) ? payloadRecord.item : null)
      ?? (isRecord(data.item) ? data.item : null)
      ?? payloadRecord

  if (!item) {
    throw new Error('catalog_not_found')
  }

  const normalized = extractCatalogMeta(item, params.marketplaceId)

  return {
    asin: params.asin.toUpperCase(),
    title: normalized.title,
    brand: normalized.brand,
    image_url: normalized.image_url,
    category: normalized.category,
    bsr: normalized.bsr,
    bsr_category: normalized.bsr_category,
    bsr_ranks: normalized.bsr_ranks,
  }
}
