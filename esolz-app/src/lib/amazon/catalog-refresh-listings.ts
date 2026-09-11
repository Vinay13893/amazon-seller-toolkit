import type { ListingItem } from '@/lib/amazon/spapi-client'

export interface CatalogJobMetadata {
  page_token?: string | null
  pages?: number
  items_fetched?: number
  items_upserted?: number
}

export interface CatalogPageCounters {
  pages: number
  itemsFetched: number
  itemsUpserted: number
}

export type CatalogListingUpsert = (
  row: Record<string, unknown>,
) => Promise<{ error?: unknown | null }>

export function buildSuccessfulPageMetadata(
  counters: CatalogPageCounters,
  nextPageToken: string | undefined,
): CatalogJobMetadata {
  return {
    page_token: nextPageToken ?? null,
    pages: counters.pages + 1,
    items_fetched: counters.itemsFetched,
    items_upserted: counters.itemsUpserted,
  }
}

export function buildFailedPageMetadata(
  counters: CatalogPageCounters,
  currentPageToken: string | undefined,
): CatalogJobMetadata {
  return {
    page_token: currentPageToken ?? null,
    pages: counters.pages,
    items_fetched: counters.itemsFetched,
    items_upserted: counters.itemsUpserted,
  }
}

export async function upsertCatalogListingsPage({
  items,
  marketplaceId,
  workspaceId,
  connectionId,
  syncedAt,
  upsertListing,
}: {
  items: ListingItem[]
  marketplaceId: string
  workspaceId: string
  connectionId: string
  syncedAt: string
  upsertListing: CatalogListingUpsert
}): Promise<
  | { ok: true; confirmedUpserts: number }
  | { ok: false; confirmedUpserts: number; reason: 'listing_upsert_failed' }
> {
  let confirmedUpserts = 0

  for (const item of items) {
    const sku = item.sku
    if (!sku) continue

    const summary = item.summaries?.find(s => s.marketplaceId === marketplaceId) ?? item.summaries?.[0]
    const row = {
      workspace_id: workspaceId,
      connection_id: connectionId,
      asin: summary?.asin ?? null,
      sku,
      marketplace_id: marketplaceId,
      item_name: summary?.itemName ?? null,
      brand: item.attributes?.brand?.[0]?.value ?? null,
      product_type: summary?.productType ?? null,
      status: summary?.status?.[0] ?? null,
      image_url: summary?.mainImage?.link ?? null,
      raw_data: {},
      last_synced_at: syncedAt,
      updated_at: syncedAt,
    }

    const { error } = await upsertListing(row)
    if (error) {
      return { ok: false, confirmedUpserts, reason: 'listing_upsert_failed' }
    }

    confirmedUpserts++
  }

  return { ok: true, confirmedUpserts }
}
