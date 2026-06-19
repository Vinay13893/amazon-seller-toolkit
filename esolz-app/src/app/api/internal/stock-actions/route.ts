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
      .select('finished_at')
      .eq('workspace_id', access.workspaceId)
      .eq('job_type', 'internal_stock_sales_sync')
      .eq('status', 'completed')
      .order('finished_at', { ascending: false })
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

  return NextResponse.json({
    summary,
    actions,
    freshness: {
      inventoryUpdatedAt: inventoryDates.at(-1) ?? null,
      salesThroughDate: salesRows
        .map(row => row.salesDate)
        .sort()
        .at(-1) ?? null,
      inventoryDataAvailable: !inventoryResult.error && inventoryRows.length > 0,
      salesDataAvailable: !salesResult.error && salesRows.length > 0,
      salesTableAvailable: !salesResult.error,
      amazonSyncCompletedAt: latestSyncResult.data?.finished_at ?? null,
      resultLimitReached: (listingsResult.data?.length ?? 0) === 1000,
    },
  })
}
