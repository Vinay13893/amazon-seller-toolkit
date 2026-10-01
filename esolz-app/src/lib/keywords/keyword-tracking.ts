import {
  filterCompetitorTrackedAsins,
  marketplaceFromMarketplaceId,
  type OwnCatalogListingIdentity,
  type TrackedAsinIdentity,
} from '@/lib/asins/product-separation'

export type KeywordTargetType = 'my_product' | 'competitor_asin'

export type KeywordTrackingRow = {
  id?: string | null
  own_asin?: string | null
  tracked_asin_id?: string | null
  keyword?: string | null
  marketplace?: string | null
}

export type KeywordSourceProduct = {
  targetType: KeywordTargetType
  sourceId: string
  asin: string
  marketplace: string
  label: string
  sku?: string | null
  brand?: string | null
  productType?: string | null
  imageUrl?: string | null
}

export type KeywordSnapshotInsertTarget = {
  tracked_asin_id: string | null
}

export type KeywordRefreshTarget = {
  asin: string
  marketplace: string
  trackedAsinId: string | null
}

export function keywordTargetType(row: KeywordTrackingRow): KeywordTargetType | null {
  const hasOwnAsin = Boolean(row.own_asin)
  const hasTracked = Boolean(row.tracked_asin_id)
  if (hasOwnAsin === hasTracked) return null
  return hasOwnAsin ? 'my_product' : 'competitor_asin'
}

export function keywordTargetSourceId(row: KeywordTrackingRow): string | null {
  const type = keywordTargetType(row)
  if (type === 'my_product') return row.own_asin?.trim().toUpperCase() ?? null
  if (type === 'competitor_asin') return row.tracked_asin_id ?? null
  return null
}

export function keywordTargetKey(targetType: KeywordTargetType, sourceId: string, marketplace: string): string {
  return `${targetType}:${marketplace.trim().toUpperCase()}:${sourceId.trim().toUpperCase()}`
}

export function hasDuplicateKeywordForTarget(
  rows: KeywordTrackingRow[],
  targetType: KeywordTargetType,
  sourceId: string,
  keyword: string,
  marketplace: string,
): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase()
  const normalizedMarketplace = marketplace.trim().toUpperCase()

  return rows.some(row => {
    if (keywordTargetType(row) !== targetType) return false
    if (keywordTargetSourceId(row) !== sourceId) return false
    if ((row.keyword ?? '').trim().toLowerCase() !== normalizedKeyword) return false
    return (row.marketplace ?? '').trim().toUpperCase() === normalizedMarketplace
  })
}

export function filterKeywordCompetitorCandidates<T extends TrackedAsinIdentity>(
  trackedAsins: T[],
  ownListings: OwnCatalogListingIdentity[],
): T[] {
  return filterCompetitorTrackedAsins(trackedAsins, ownListings)
}

export function keywordSourceFromListing(listing: OwnCatalogListingIdentity & {
  sku?: string | null
  item_name?: string | null
  brand?: string | null
  product_type?: string | null
  image_url?: string | null
}): KeywordSourceProduct | null {
  const asin = listing.asin?.trim().toUpperCase()
  if (!asin || !listing.marketplace_id) return null
  return {
    targetType: 'my_product',
    sourceId: asin,
    asin,
    marketplace: marketplaceFromMarketplaceId(listing.marketplace_id),
    label: listing.item_name?.trim() || asin,
    sku: listing.sku ?? null,
    brand: listing.brand ?? null,
    productType: listing.product_type ?? null,
    imageUrl: listing.image_url ?? null,
  }
}

export function buildKeywordOwnAsinSources(
  listings: Array<OwnCatalogListingIdentity & {
    sku?: string | null
    item_name?: string | null
    brand?: string | null
    product_type?: string | null
    image_url?: string | null
  }>,
): KeywordSourceProduct[] {
  const sources = new Map<string, KeywordSourceProduct>()

  for (const listing of listings) {
    const source = keywordSourceFromListing(listing)
    if (!source) continue
    const key = keywordTargetKey(source.targetType, source.sourceId, source.marketplace)
    const existing = sources.get(key)
    if (!existing) {
      sources.set(key, source)
      continue
    }

    sources.set(key, {
      ...existing,
      label: existing.label === existing.asin && source.label !== source.asin ? source.label : existing.label,
      sku: existing.sku ?? source.sku,
      brand: existing.brand ?? source.brand,
      productType: existing.productType ?? source.productType,
      imageUrl: existing.imageUrl ?? source.imageUrl,
    })
  }

  return [...sources.values()]
}

export function keywordSourceFromCompetitor(tracked: TrackedAsinIdentity & {
  product_title?: string | null
  brand?: string | null
  image_url?: string | null
}): KeywordSourceProduct | null {
  const asin = tracked.asin?.trim().toUpperCase()
  if (!tracked.id || !asin || !tracked.marketplace) return null
  return {
    targetType: 'competitor_asin',
    sourceId: tracked.id,
    asin,
    marketplace: tracked.marketplace,
    label: tracked.product_title?.trim() || asin,
    brand: tracked.brand ?? null,
    imageUrl: tracked.image_url ?? null,
  }
}

export function snapshotTargetForKeyword(row: KeywordTrackingRow): KeywordSnapshotInsertTarget | null {
  const type = keywordTargetType(row)
  if (type === 'my_product') return { tracked_asin_id: null }
  if (type === 'competitor_asin') return { tracked_asin_id: row.tracked_asin_id ?? null }
  return null
}

export function resolveKeywordRefreshTarget(
  row: KeywordTrackingRow,
  trackedAsins: Map<string, { asin: string | null; marketplace: string | null }>,
  ownCatalogKeys: Set<string> | null,
): KeywordRefreshTarget | null {
  if (!ownCatalogKeys) return null

  const type = keywordTargetType(row)
  if (type === 'my_product') {
    const asin = row.own_asin?.trim().toUpperCase()
    const marketplace = row.marketplace?.trim().toUpperCase()
    if (!asin || !marketplace) return null
    if (!ownCatalogKeys.has(keywordTargetKey('my_product', asin, marketplace))) return null
    return { asin, marketplace, trackedAsinId: null }
  }

  if (type === 'competitor_asin') {
    const trackedAsinId = row.tracked_asin_id ?? ''
    const tracked = trackedAsins.get(trackedAsinId)
    const asin = tracked?.asin?.trim().toUpperCase()
    const marketplace = tracked?.marketplace?.trim().toUpperCase()
    if (!asin || !marketplace) return null
    if (ownCatalogKeys.has(keywordTargetKey('my_product', asin, marketplace))) return null
    return { asin, marketplace, trackedAsinId }
  }

  return null
}
