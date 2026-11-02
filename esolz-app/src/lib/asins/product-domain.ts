import {
  filterCompetitorTrackedAsins,
  marketplaceFromMarketplaceId,
  type OwnCatalogListingIdentity,
  type TrackedAsinIdentity,
} from './product-separation'

export type CatalogProductRow = OwnCatalogListingIdentity & {
  sku?: string | null
  item_name?: string | null
  brand?: string | null
  product_type?: string | null
  image_url?: string | null
}

export type CompetitorProductRow = TrackedAsinIdentity & {
  product_title?: string | null
  brand?: string | null
  category?: string | null
  image_url?: string | null
}

export type AsinProductDomain = 'my' | 'competitor'

export type AsinProduct = {
  key: string
  domain: AsinProductDomain
  asin: string
  marketplace: string
  marketplaceId: string | null
  title: string
  brand: string | null
  productType: string | null
  imageUrl: string | null
  skus: string[]
  sourceIds: string[]
  primarySourceId: string
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function productKey(domain: AsinProductDomain, marketplace: string, asin: string): string {
  return `${domain}:${marketplace.trim().toUpperCase()}:${normalized(asin)}`
}

export function groupCatalogProducts(rows: CatalogProductRow[]): AsinProduct[] {
  const products = new Map<string, AsinProduct>()

  for (const row of rows) {
    const asin = normalized(row.asin)
    const marketplaceId = row.marketplace_id?.trim() ?? ''
    if (!asin || !marketplaceId || !row.id) continue

    const marketplace = marketplaceFromMarketplaceId(marketplaceId)
    const key = productKey('my', marketplaceId, asin)
    const sku = row.sku?.trim() || null
    const existing = products.get(key)

    if (!existing) {
      products.set(key, {
        key,
        domain: 'my',
        asin,
        marketplace,
        marketplaceId,
        title: row.item_name?.trim() || asin,
        brand: row.brand?.trim() || null,
        productType: row.product_type?.trim() || null,
        imageUrl: row.image_url?.trim() || null,
        skus: sku ? [sku] : [],
        sourceIds: [row.id],
        primarySourceId: row.id,
      })
      continue
    }

    if (sku && !existing.skus.includes(sku)) existing.skus.push(sku)
    if (!existing.sourceIds.includes(row.id)) existing.sourceIds.push(row.id)
    if (existing.title === existing.asin && row.item_name?.trim()) existing.title = row.item_name.trim()
    existing.brand ??= row.brand?.trim() || null
    existing.productType ??= row.product_type?.trim() || null
    existing.imageUrl ??= row.image_url?.trim() || null
  }

  return [...products.values()].map(product => ({
    ...product,
    skus: product.skus.sort((a, b) => a.localeCompare(b)),
  }))
}

export function buildCompetitorProducts(
  trackedRows: CompetitorProductRow[],
  catalogRows: CatalogProductRow[],
): AsinProduct[] {
  return filterCompetitorTrackedAsins(trackedRows, catalogRows).flatMap(row => {
    const asin = normalized(row.asin)
    const marketplace = row.marketplace?.trim().toUpperCase() ?? ''
    if (!row.id || !asin || !marketplace) return []

    return [{
      key: productKey('competitor', marketplace, asin),
      domain: 'competitor' as const,
      asin,
      marketplace,
      marketplaceId: null,
      title: row.product_title?.trim() || asin,
      brand: row.brand?.trim() || null,
      productType: row.category?.trim() || null,
      imageUrl: row.image_url?.trim() || null,
      skus: [],
      sourceIds: [row.id],
      primarySourceId: row.id,
    }]
  })
}

export function resolveAsinProductDomains({
  catalogRows,
  trackedRows,
  catalogUnavailable,
  trackedUnavailable,
}: {
  catalogRows: CatalogProductRow[]
  trackedRows: CompetitorProductRow[]
  catalogUnavailable: boolean
  trackedUnavailable: boolean
}): { myProducts: AsinProduct[]; competitorProducts: AsinProduct[] } {
  if (catalogUnavailable) return { myProducts: [], competitorProducts: [] }
  return {
    myProducts: groupCatalogProducts(catalogRows),
    competitorProducts: trackedUnavailable ? [] : buildCompetitorProducts(trackedRows, catalogRows),
  }
}

export function selectedAsins(products: AsinProduct[], selectedKeys: Iterable<string>): string[] {
  const selected = new Set(selectedKeys)
  return [...new Set(products.filter(product => selected.has(product.key)).map(product => product.asin))]
}
