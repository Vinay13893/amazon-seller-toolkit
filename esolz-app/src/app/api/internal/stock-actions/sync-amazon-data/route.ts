import { NextResponse } from 'next/server'
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
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 45

const ALLOWED_LOOKBACK_DAYS = new Set([30, 90, 180, 365])
const SALES_BATCH_SIZE = 1

type SyncPhase = 'listings' | 'inventory' | 'sales' | 'completed'

type SyncMetadata = {
  phase?: SyncPhase
  lookback_days?: number
  listings_page_token?: string | null
  inventory_next_token?: string | null
  sales_offset?: number
  listings_updated?: number
  listings_used?: number
  inventory_updated?: number
  sales_rows_updated?: number
  warnings?: string[]
}

type RequestBody = {
  jobId?: unknown
  days?: unknown
}

function safeWarnings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : []
}

function responseForJob(jobId: string, status: string, metadata: SyncMetadata) {
  const warnings = safeWarnings(metadata.warnings)
  return NextResponse.json({
    jobId,
    status: status === 'completed' && warnings.length > 0 ? 'partial_success' : status,
    phase: metadata.phase ?? 'listings',
    listingsUpdated: metadata.listings_updated ?? 0,
    listingsUsed: metadata.listings_used ?? 0,
    inventoryUpdated: metadata.inventory_updated ?? 0,
    salesRowsUpdated: metadata.sales_rows_updated ?? 0,
    warnings,
    warehouseStockAvailable: false,
  })
}

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({})) as RequestBody
  const admin = createAdminClient()

  const { data: connection } = await admin
    .from('amazon_connections')
    .select('id, status, selling_partner_id, marketplace_id, refresh_token_encrypted')
    .eq('workspace_id', access.workspaceId)
    .maybeSingle()

  if (
    !connection
    || connection.status !== 'active'
    || !connection.selling_partner_id
    || !connection.refresh_token_encrypted
  ) {
    return NextResponse.json(
      { error: 'An active Amazon connection is required.' },
      { status: 409 },
    )
  }

  if (typeof body.jobId !== 'string' || !body.jobId) {
    const requestedDays = Number(body.days ?? 90)
    const lookbackDays = ALLOWED_LOOKBACK_DAYS.has(requestedDays) ? requestedDays : 90
    const now = new Date().toISOString()
    const { count: storedListingCount } = await admin
      .from('amazon_listing_items')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', access.workspaceId)

    await admin
      .from('amazon_sync_jobs')
      .update({ status: 'cancelled', finished_at: now })
      .eq('workspace_id', access.workspaceId)
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
        workspace_id: access.workspaceId,
        connection_id: connection.id,
        job_type: 'internal_stock_sales_sync',
        status: 'running',
        started_at: now,
        metadata,
      })
      .select('id')
      .single()

    if (error || !job) {
      return NextResponse.json({ error: 'Unable to start Amazon sync.' }, { status: 500 })
    }
    return responseForJob(job.id as string, 'running', metadata)
  }

  const { data: job } = await admin
    .from('amazon_sync_jobs')
    .select('id, status, metadata')
    .eq('id', body.jobId)
    .eq('workspace_id', access.workspaceId)
    .eq('job_type', 'internal_stock_sales_sync')
    .maybeSingle()

  if (!job) return NextResponse.json({ error: 'Sync job not found.' }, { status: 404 })
  const metadata = (job.metadata ?? {}) as SyncMetadata
  if (job.status !== 'running') return responseForJob(job.id, job.status, metadata)

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
    return NextResponse.json({ error: 'Amazon connection could not be refreshed.' }, { status: 502 })
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
              workspace_id: access.workspaceId,
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
      } catch {
        warnings.push('Amazon listings refresh was unavailable; existing stored listings will be used.')
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
          workspace_id: access.workspaceId,
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
      const { data: products } = await admin
        .from('amazon_listing_items')
        .select('asin, sku')
        .eq('workspace_id', access.workspaceId)
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

        for (const product of products) {
          try {
            const metrics = await getDailyOrderMetricsForSku({
              accessToken,
              marketplaceId,
              sku: product.sku as string,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
            })
            const rows = metrics.map(metric => ({
              workspace_id: access.workspaceId,
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
        }
        metadata.sales_offset = offset + products.length
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
    return NextResponse.json({ error: 'Amazon stock and sales sync could not continue.' }, { status: 502 })
  }

  metadata.warnings = warnings.slice(0, 8)
  const completed = metadata.phase === 'completed'
  await admin
    .from('amazon_sync_jobs')
    .update({
      status: completed ? 'completed' : 'running',
      finished_at: completed ? now : null,
      metadata,
    })
    .eq('id', job.id)

  return responseForJob(job.id, completed ? 'completed' : 'running', metadata)
}
