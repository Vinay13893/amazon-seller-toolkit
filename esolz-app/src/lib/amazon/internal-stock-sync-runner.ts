import 'server-only'
import { decryptToken } from '@/lib/amazon/crypto'
import {
  getDailyOrderMetricsForSku,
  getFbaInventoryPage,
} from '@/lib/amazon/internal-stock-sync'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import {
  extractNextPageToken,
  searchListingsItems,
  type ListingItem,
} from '@/lib/amazon/spapi-client'
import type { createAdminClient } from '@/lib/supabase/admin'

/**
 * Shared step logic for the 'internal_stock_sales_sync' job (listings ->
 * FBA inventory -> per-SKU daily sales). Used by BOTH the browser-driven button
 * route (/api/internal/stock-actions/sync-amazon-data) and the scheduled route
 * (/api/cron/stock/sync-amazon-data) so they can never drift apart.
 *
 * The step logic below is moved verbatim from the original route handler.
 */

type Admin = ReturnType<typeof createAdminClient>

export type StockSyncConnection = {
  id: string
  selling_partner_id: string
  marketplace_id: string | null
  refresh_token_encrypted: string
}

export type StockSyncOutcome =
  | { ok: true; body: StockSyncBody }
  | { ok: false; status: number; error: string }

export const ALLOWED_LOOKBACK_DAYS = new Set([30, 90, 180, 365])
const SALES_BATCH_SIZE = 5
const SALES_API_DELAY_MS = 2_100

type SyncPhase = 'listings' | 'inventory' | 'sales' | 'completed'
type SalesScope = 'inventory' | 'listings'

type SyncMetadata = {
  phase?: SyncPhase
  lookback_days?: number
  listings_page_token?: string | null
  inventory_next_token?: string | null
  sales_offset?: number
  sales_total?: number
  sales_scope?: SalesScope
  listings_updated?: number
  listings_used?: number
  inventory_updated?: number
  sales_rows_updated?: number
  last_progress_at?: string
  warnings?: string[]
}

function safeWarnings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : []
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Classifies a thrown SP-API error (which only ever carries a safe
 * "HTTP <status>" message, never a raw body) into a sanitized warning so the
 * operator knows whether a failure is a permission/role issue, a transient
 * rate limit, or something else — instead of one generic "unavailable" string.
 */
function describeListingsRefreshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const statusMatch = message.match(/HTTP (\d{3})/)
  const status = statusMatch ? Number(statusMatch[1]) : null

  if (status === 401 || status === 403) {
    return 'Amazon listings refresh requires re-authorizing Listings Items API access; existing stored listings will be used.'
  }
  if (status === 429) {
    return 'Amazon rate-limited the listings refresh; it will retry on the next sync. Existing stored listings will be used.'
  }
  if (status && status >= 500) {
    return 'Amazon listings service was temporarily unavailable; existing stored listings will be used.'
  }
  return 'Amazon listings refresh was unavailable; existing stored listings will be used.'
}

export function stockSyncResponseBody(jobId: string, status: string, metadata: SyncMetadata) {
  const warnings = safeWarnings(metadata.warnings)
  return {
    jobId,
    status: status === 'completed' && warnings.length > 0 ? 'partial_success' : status,
    phase: metadata.phase ?? 'listings',
    listingsUpdated: metadata.listings_updated ?? 0,
    listingsUsed: metadata.listings_used ?? 0,
    inventoryUpdated: metadata.inventory_updated ?? 0,
    salesRowsUpdated: metadata.sales_rows_updated ?? 0,
    warnings,
    warehouseStockAvailable: false,
  }
}

export type StockSyncBody = ReturnType<typeof stockSyncResponseBody>

export async function startStockSyncJob(
  admin: Admin,
  params: { workspaceId: string; connection: StockSyncConnection; days?: unknown },
): Promise<StockSyncOutcome> {
  const { workspaceId, connection } = params
  const requestedDays = Number(params.days ?? 90)
  const lookbackDays = ALLOWED_LOOKBACK_DAYS.has(requestedDays) ? requestedDays : 90
  const now = new Date().toISOString()
  const { count: storedListingCount } = await admin
    .from('amazon_listing_items')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)

  await admin
    .from('amazon_sync_jobs')
    .update({ status: 'cancelled', finished_at: now })
    .eq('workspace_id', workspaceId)
    .eq('job_type', 'internal_stock_sales_sync')
    .eq('status', 'running')

  const metadata: SyncMetadata = {
    phase: 'listings',
    lookback_days: Math.min(365, lookbackDays),
    listings_page_token: null,
    inventory_next_token: null,
    sales_offset: 0,
    listings_updated: 0,
    listings_used: storedListingCount ?? 0,
    inventory_updated: 0,
    sales_rows_updated: 0,
    warnings: [],
  }
  const { data: job, error } = await admin
    .from('amazon_sync_jobs')
    .insert({
      workspace_id: workspaceId,
      connection_id: connection.id,
      job_type: 'internal_stock_sales_sync',
      status: 'running',
      started_at: now,
      metadata,
    })
    .select('id')
    .single()

  if (error || !job) {
    return { ok: false, status: 500, error: 'Unable to start Amazon sync.' }
  }
  return { ok: true, body: stockSyncResponseBody(job.id as string, 'running', metadata) }
}

export async function advanceStockSyncJob(
  admin: Admin,
  params: { workspaceId: string; connection: StockSyncConnection; jobId: string },
): Promise<StockSyncOutcome> {
  const { workspaceId, connection, jobId } = params
  const { data: job } = await admin
    .from('amazon_sync_jobs')
    .select('id, status, metadata')
    .eq('id', jobId)
    .eq('workspace_id', workspaceId)
    .eq('job_type', 'internal_stock_sales_sync')
    .maybeSingle()

  if (!job) return { ok: false, status: 404, error: 'Sync job not found.' }
  const metadata = (job.metadata ?? {}) as SyncMetadata
  if (job.status !== 'running') return { ok: true, body: stockSyncResponseBody(job.id, job.status, metadata) }

  let accessToken: string
  try {
    const token = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted))
    accessToken = token.access_token
  } catch {
    await admin
      .from('amazon_sync_jobs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: 'amazon_connection_refresh_failed',
      })
      .eq('id', job.id)
    return { ok: false, status: 502, error: 'Amazon connection could not be refreshed.' }
  }

  const marketplaceId = connection.marketplace_id ?? 'A21TJRUUN4KGV'
  const now = new Date().toISOString()
  const warnings = safeWarnings(metadata.warnings)

  try {
    if ((metadata.phase ?? 'listings') === 'listings') {
      try {
        const result = await searchListingsItems(accessToken, {
          sellerId: connection.selling_partner_id,
          marketplaceId,
          pageSize: 20,
          pageToken: metadata.listings_page_token ?? undefined,
        })
        const items = result.items ?? []
        const rows = items
          .map((item: ListingItem) => {
            const summary = item.summaries?.find(value => value.marketplaceId === marketplaceId)
              ?? item.summaries?.[0]
            if (!item.sku) return null
            return {
              workspace_id: workspaceId,
              connection_id: connection.id,
              asin: summary?.asin ?? null,
              sku: item.sku,
              marketplace_id: marketplaceId,
              item_name: summary?.itemName ?? null,
              brand: item.attributes?.brand?.[0]?.value ?? null,
              product_type: summary?.productType ?? null,
              status: summary?.status?.[0] ?? null,
              image_url: summary?.mainImage?.link ?? null,
              raw_data: {},
              last_synced_at: now,
              updated_at: now,
            }
          })
          .filter((row): row is NonNullable<typeof row> => Boolean(row))

        if (rows.length > 0) {
          const { error } = await admin
            .from('amazon_listing_items')
            .upsert(rows, { onConflict: 'workspace_id,sku,marketplace_id' })
          if (error) throw new Error('listing_storage_failed')
        }

        const nextToken = extractNextPageToken(result as typeof result & Record<string, unknown>)
        metadata.listings_updated = (metadata.listings_updated ?? 0) + rows.length
        metadata.listings_used = Math.max(
          metadata.listings_used ?? 0,
          metadata.listings_updated,
        )
        metadata.listings_page_token = nextToken ?? null
        metadata.phase = nextToken ? 'listings' : 'inventory'
      } catch (listingsError) {
        const warning = describeListingsRefreshFailure(listingsError)
        if (!warnings.includes(warning)) warnings.push(warning)
        metadata.phase = 'inventory'
      }
    } else if (metadata.phase === 'inventory') {
      try {
        const result = await getFbaInventoryPage({
          accessToken,
          marketplaceId,
          nextToken: metadata.inventory_next_token ?? undefined,
        })
        const rows = result.rows.map(row => ({
          workspace_id: workspaceId,
          connection_id: connection.id,
          asin: row.asin,
          sku: row.sku,
          marketplace_id: marketplaceId,
          available_quantity: row.available,
          inbound_quantity: row.inbound,
          reserved_quantity: row.reserved,
          fulfillable_quantity: row.fulfillable,
          unfulfillable_quantity: row.unfulfillable,
          source: 'amazon_api',
          raw_data: {},
          last_synced_at: now,
          updated_at: now,
        }))
        if (rows.length > 0) {
          const { error } = await admin
            .from('amazon_inventory_summaries')
            .upsert(rows, { onConflict: 'workspace_id,sku,marketplace_id' })
          if (error) throw new Error('inventory_storage_failed')
        }
        metadata.inventory_updated = (metadata.inventory_updated ?? 0) + rows.length
        metadata.inventory_next_token = result.nextToken
        metadata.phase = result.nextToken ? 'inventory' : 'sales'
      } catch {
        warnings.push('FBA inventory is not available from the current Amazon connection.')
        metadata.phase = 'sales'
      }
    } else if (metadata.phase === 'sales') {
      const offset = metadata.sales_offset ?? 0
      let salesScope = metadata.sales_scope
      let salesTotal = metadata.sales_total

      if (!salesScope || salesTotal === null || salesTotal === undefined) {
        const { count: inventoryProductCount } = await admin
          .from('amazon_inventory_summaries')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('marketplace_id', marketplaceId)
          .not('asin', 'is', null)
          .not('sku', 'is', null)

        salesScope = (inventoryProductCount ?? 0) > 0 ? 'inventory' : 'listings'
        const countTable = salesScope === 'inventory'
          ? 'amazon_inventory_summaries'
          : 'amazon_listing_items'
        const { count } = await admin
          .from(countTable)
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('marketplace_id', marketplaceId)
          .not('asin', 'is', null)
          .not('sku', 'is', null)

        salesTotal = count ?? 0
        metadata.sales_scope = salesScope
        metadata.sales_total = salesTotal
      }

      if (offset >= salesTotal) {
        metadata.phase = 'completed'
      } else {
        const salesTable = salesScope === 'inventory'
          ? 'amazon_inventory_summaries'
          : 'amazon_listing_items'
        const { data: products } = await admin
          .from(salesTable)
        .select('asin, sku')
        .eq('workspace_id', workspaceId)
        .eq('marketplace_id', marketplaceId)
        .not('asin', 'is', null)
        .not('sku', 'is', null)
        .order('sku', { ascending: true })
        .range(offset, offset + SALES_BATCH_SIZE - 1)

        if (!products || products.length === 0) {
          metadata.phase = 'completed'
        } else {
          const lookbackDays = Math.min(365, Math.max(30, metadata.lookback_days ?? 90))
          const endTime = new Date()
          const startTime = new Date(endTime)
          startTime.setUTCDate(startTime.getUTCDate() - lookbackDays)

          for (let index = 0; index < products.length; index += 1) {
            const product = products[index]
            try {
              const metrics = await getDailyOrderMetricsForSku({
                accessToken,
                marketplaceId,
                sku: product.sku as string,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
              })
              const rows = metrics.map(metric => ({
                workspace_id: workspaceId,
                marketplace_id: marketplaceId,
                asin: product.asin as string,
                sku: product.sku as string,
                sales_date: metric.salesDate,
                ordered_units: metric.orderedUnits,
                ordered_revenue: metric.orderedRevenue,
                source: 'amazon_api',
              }))
              if (rows.length > 0) {
                const { error } = await admin
                  .from('internal_sku_daily_sales')
                  .upsert(rows, {
                    onConflict: 'workspace_id,marketplace_id,asin,sku,sales_date,source',
                  })
                if (error) throw new Error('sales_storage_failed')
              }
              metadata.sales_rows_updated = (metadata.sales_rows_updated ?? 0) + rows.length
            } catch {
              if (!warnings.includes('Some SKU sales metrics were unavailable from Amazon.')) {
                warnings.push('Some SKU sales metrics were unavailable from Amazon.')
              }
            }
            if (index < products.length - 1) {
              await delay(SALES_API_DELAY_MS)
            }
          }

          const nextOffset = offset + products.length
          metadata.sales_offset = nextOffset
          if (nextOffset >= salesTotal) {
            metadata.phase = 'completed'
          }
          if (salesScope === 'inventory' && salesTotal < (metadata.listings_used ?? 0)) {
            const warning = 'Sales sync covered inventory-backed products; other listings remain without stock context.'
            if (!warnings.includes(warning)) {
              warnings.push(warning)
            }
          }
        }
      }
    }
  } catch {
    await admin
      .from('amazon_sync_jobs')
      .update({
        status: 'failed',
        finished_at: now,
        error_message: 'internal_stock_sync_failed',
        metadata: { ...metadata, warnings },
      })
      .eq('id', job.id)
    return { ok: false, status: 502, error: 'Amazon stock and sales sync could not continue.' }
  }

  metadata.warnings = warnings.slice(0, 8)
  metadata.last_progress_at = now
  const completed = metadata.phase === 'completed'
  await admin
    .from('amazon_sync_jobs')
    .update({
      status: completed ? 'completed' : 'running',
      finished_at: completed ? now : null,
      metadata,
    })
    .eq('id', job.id)

  return { ok: true, body: stockSyncResponseBody(job.id, completed ? 'completed' : 'running', metadata) }
}
