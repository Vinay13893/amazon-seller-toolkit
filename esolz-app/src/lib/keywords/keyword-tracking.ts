import {
  filterCompetitorTrackedAsins,
  marketplaceFromMarketplaceId,
  type OwnCatalogListingIdentity,
  type TrackedAsinIdentity,
} from '@/lib/asins/product-separation'

export type KeywordTargetType = 'my_product' | 'competitor_asin'

export type KeywordTrackingRow = {
  id?: string | null
  amazon_listing_item_id?: string | null
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
  imageUrl?: string | null
}

export type KeywordSnapshotInsertTarget = {
  tracked_asin_id: string | null
}

export function keywordTargetType(row: KeywordTrackingRow): KeywordTargetType | null {
  const hasListing = Boolean(row.amazon_listing_item_id)
  const hasTracked = Boolean(row.tracked_asin_id)
  if (hasListing === hasTracked) return null
  return hasListing ? 'my_product' : 'competitor_asin'
}

export function keywordTargetSourceId(row: KeywordTrackingRow): string | null {
  const type = keywordTargetType(row)
  if (type === 'my_product') return row.amazon_listing_item_id ?? null
  if (type === 'competitor_asin') return row.tracked_asin_id ?? null
  return null
}

export function keywordTargetKey(targetType: KeywordTargetType, sourceId: string): string {
  return `${targetType}:${sourceId}`
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
  image_url?: string | null
}): KeywordSourceProduct | null {
  const asin = listing.asin?.trim().toUpperCase()
  if (!listing.id || !asin || !listing.marketplace_id) return null
  return {
    targetType: 'my_product',
    sourceId: listing.id,
    asin,
    marketplace: marketplaceFromMarketplaceId(listing.marketplace_id),
    label: listing.item_name?.trim() || asin,
    sku: listing.sku ?? null,
    brand: listing.brand ?? null,
    imageUrl: listing.image_url ?? null,
  }
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
