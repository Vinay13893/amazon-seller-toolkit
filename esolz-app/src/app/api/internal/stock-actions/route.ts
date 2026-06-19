import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  calculateStockActions,
  type DailySalesInput,
  type InventoryInput,
  type StockProductInput,
} from '@/lib/internal-stock-actions'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase = await createClient()
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29)

  const [listingsResult, inventoryResult, salesResult, latestSyncResult] = await Promise.all([
    supabase
      .from('amazon_listing_items')
      .select('asin, sku, marketplace_id, item_name, brand, image_url')
      .eq('workspace_id', access.workspaceId)
      .not('asin', 'is', null)
      .order('item_name', { ascending: true })
      .limit(1000),
    supabase
      .from('amazon_inventory_summaries')
      .select('asin, sku, marketplace_id, available_quantity, inbound_quantity, reserved_quantity, last_synced_at')
      .eq('workspace_id', access.workspaceId)
      .limit(1000),
    supabase
      .from('internal_sku_daily_sales')
      .select('asin, sku, marketplace_id, sales_date, ordered_units')
      .eq('workspace_id', access.workspaceId)
      .gte('sales_date', thirtyDaysAgo.toISOString().slice(0, 10))
      .limit(30000),
    supabase
      .from('amazon_sync_jobs')
      .select('status, started_at, finished_at, metadata')
      .eq('workspace_id', access.workspaceId)
      .eq('job_type', 'internal_stock_sales_sync')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (listingsResult.error) {
    return NextResponse.json(
      { error: 'Stock action data is temporarily unavailable.' },
      { status: 503 },
    )
  }

  const products: StockProductInput[] = (listingsResult.data ?? []).map(row => ({
    asin: row.asin as string,
    sku: (row.sku as string | null) ?? null,
    marketplaceId: (row.marketplace_id as string | null) ?? null,
    title: (row.item_name as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
  }))

  const inventoryRows: InventoryInput[] = inventoryResult.error
    ? []
    : (inventoryResult.data ?? []).map(row => ({
        asin: (row.asin as string | null) ?? null,
        sku: row.sku as string,
        marketplaceId: (row.marketplace_id as string | null) ?? null,
        available: Number(row.available_quantity ?? 0),
        inbound: Number(row.inbound_quantity ?? 0),
        reserved: Number(row.reserved_quantity ?? 0),
        lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      }))

  const salesRows: DailySalesInput[] = salesResult.error
    ? []
    : (salesResult.data ?? []).map(row => ({
        asin: row.asin as string,
        sku: (row.sku as string | null) ?? null,
        marketplaceId: row.marketplace_id as string,
        salesDate: row.sales_date as string,
        orderedUnits: Number(row.ordered_units ?? 0),
      }))

  const actions = calculateStockActions(products, inventoryRows, salesRows)
  const summary = actions.reduce(
    (counts, row) => {
      counts[row.status] += 1
      return counts
    },
    {
      OOS: 0,
      'Low stock': 0,
      Healthy: 0,
      Overstock: 0,
      'Missing data': 0,
    },
  )

  const inventoryDates = inventoryRows
    .map(row => row.lastSyncedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
  const productsWithSales = actions.filter(row => row.units30d !== null).length
  const productsWithInventory = actions.filter(row => row.available !== null).length
  const latestSyncMetadata = (
    latestSyncResult.data?.metadata
    && typeof latestSyncResult.data.metadata === 'object'
    && !Array.isArray(latestSyncResult.data.metadata)
  )
    ? latestSyncResult.data.metadata as Record<string, unknown>
    : {}
  const lastSyncWarnings = Array.isArray(latestSyncMetadata.warnings)
    ? latestSyncMetadata.warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 8)
    : []
  const lastSyncStatus = latestSyncResult.data
    ? latestSyncResult.data.status === 'completed' && lastSyncWarnings.length > 0
      ? 'partial_success'
      : latestSyncResult.data.status
    : null

  return NextResponse.json({
    summary,
    actions,
    diagnostics: {
      products_with_sales: productsWithSales,
      products_missing_sales: Math.max(0, products.length - productsWithSales),
      products_with_inventory: productsWithInventory,
      products_missing_inventory: Math.max(0, products.length - productsWithInventory),
      last_sync_status: lastSyncStatus,
      last_sync_warnings: lastSyncWarnings,
    },
    freshness: {
      inventoryUpdatedAt: inventoryDates.at(-1) ?? null,
      salesThroughDate: salesRows
        .map(row => row.salesDate)
        .sort()
        .at(-1) ?? null,
      inventoryDataAvailable: !inventoryResult.error && inventoryRows.length > 0,
      salesDataAvailable: !salesResult.error && salesRows.length > 0,
      salesTableAvailable: !salesResult.error,
      amazonSyncCompletedAt: latestSyncResult.data?.finished_at
        ?? (latestSyncResult.data?.status === 'running' ? latestSyncResult.data.started_at : null)
        ?? null,
      resultLimitReached: (listingsResult.data?.length ?? 0) === 1000,
    },
  })
}
