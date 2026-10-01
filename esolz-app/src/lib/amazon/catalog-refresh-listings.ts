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

export interface CatalogUpsertDiagnostic {
  code: string
  message: string
  details: null
  hint: null
}

export function sanitizeCatalogUpsertError(error: unknown): CatalogUpsertDiagnostic {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof record.code === 'string' && /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(record.code)
    ? record.code : 'unknown'
  const rawMessage = typeof record.message === 'string' ? record.message : ''
  const message = code === '23505' && rawMessage.includes('amazon_listing_items_asin_marketplace_uidx')
    ? 'asin_unique_index_conflict'
    : code === '23505' && rawMessage.includes('amazon_listing_items_workspace_id_sku_marketplace_id_key')
      ? 'sku_unique_constraint_conflict'
      : code === '23505' ? 'unique_violation'
        : code === '23503' ? 'foreign_key_violation'
          : code === '23502' ? 'not_null_violation'
            : code === '23514' ? 'check_violation'
              : code === '42P10' ? 'invalid_conflict_target'
                : 'database_write_failed'

  return { code, message, details: null, hint: null }
}

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
  | { ok: false; confirmedUpserts: number; reason: 'listing_upsert_failed'; diagnostic: CatalogUpsertDiagnostic }
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

    try {
      const { error } = await upsertListing(row)
      if (error) {
        return { ok: false, confirmedUpserts, reason: 'listing_upsert_failed', diagnostic: sanitizeCatalogUpsertError(error) }
      }
    } catch (error) {
      return { ok: false, confirmedUpserts, reason: 'listing_upsert_failed', diagnostic: sanitizeCatalogUpsertError(error) }
    }

    confirmedUpserts++
  }

  return { ok: true, confirmedUpserts }
}
