export type ListingSkuIdentity = {
  asin: string | null
  marketplace_id: string | null
  sku: string | null
}

function normalized(value: string | null): string {
  return value?.trim().toUpperCase() ?? ''
}

export function listingProductKey(row: Pick<ListingSkuIdentity, 'asin' | 'marketplace_id'>): string | null {
  const asin = normalized(row.asin)
  const marketplaceId = normalized(row.marketplace_id)
  return asin && marketplaceId ? `${marketplaceId}:${asin}` : null
}

export function listingSkuAssociationScope(rows: ListingSkuIdentity[]): {
  asins: string[]
  marketplaceIds: string[]
  productKeys: Set<string>
} {
  const asins = new Set<string>()
  const marketplaceIds = new Set<string>()
  const productKeys = new Set<string>()

  for (const row of rows) {
    const key = listingProductKey(row)
    if (!key || !row.asin || !row.marketplace_id) continue
    asins.add(row.asin.trim())
    marketplaceIds.add(row.marketplace_id.trim())
    productKeys.add(key)
  }

  return { asins: [...asins], marketplaceIds: [...marketplaceIds], productKeys }
}

export function attachCompleteListingSkus<T extends ListingSkuIdentity>(
  pageRows: T[],
  associationRows: ListingSkuIdentity[],
): Array<T & { skus: string[] }> {
  const requestedKeys = new Set(pageRows.flatMap(row => {
    const key = listingProductKey(row)
    return key ? [key] : []
  }))
  const skusByProduct = new Map<string, Set<string>>()

  for (const row of [...pageRows, ...associationRows]) {
    const key = listingProductKey(row)
    const sku = row.sku?.trim()
    if (!key || !sku || !requestedKeys.has(key)) continue
    if (!skusByProduct.has(key)) skusByProduct.set(key, new Set())
    skusByProduct.get(key)?.add(sku)
  }

  return pageRows.map(row => {
    const key = listingProductKey(row)
    return {
      ...row,
      skus: key
        ? [...(skusByProduct.get(key) ?? [])].sort((a, b) => a.localeCompare(b))
        : (row.sku?.trim() ? [row.sku.trim()] : []),
    }
  })
}
