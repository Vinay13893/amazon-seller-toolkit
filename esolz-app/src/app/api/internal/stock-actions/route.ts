import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  buildNextStockPlan,
  DEFAULT_REPLENISHMENT_ASSUMPTIONS,
} from '@/lib/internal-replenishment-planner'
import {
  calculateStockActions,
  type DailySalesInput,
  type InventoryInput,
  type StockProductInput,
} from '@/lib/internal-stock-actions'
import { createAdminClient } from '@/lib/supabase/admin'
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
  const lookbackStart = new Date()
  lookbackStart.setUTCDate(
    lookbackStart.getUTCDate() - (DEFAULT_REPLENISHMENT_ASSUMPTIONS.salesLookbackDays - 1),
  )

  const [
    listingsResult,
    inventoryResult,
    salesResult,
    latestSyncResult,
    fulfillmentRowsResult,
    fulfillmentJobResult,
    fulfillmentLocationsResult,
    stateZoneMapResult,
    fulfillmentSalesDailyResult,
    inventoryByLocationResult,
  ] = await Promise.all([
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
      .select('asin, sku, marketplace_id, sales_date, ordered_units, source')
      .eq('workspace_id', access.workspaceId)
      .gte('sales_date', thirtyDaysAgo.toISOString().slice(0, 10))
      .limit(30000),
    supabase
      .from('amazon_sync_jobs')
      .select('id, status, started_at, finished_at, metadata')
      .eq('workspace_id', access.workspaceId)
      .eq('job_type', 'internal_stock_sales_sync')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('internal_fba_report_rows')
      .select('asin, sku, marketplace_id, fulfillment_center_id, event_type, quantity, report_date')
      .eq('workspace_id', access.workspaceId)
      .limit(20000),
    supabase
      .from('internal_fba_report_jobs')
      .select('report_type, processing_status, completed_at, stored_row_count, fc_field_available')
      .eq('workspace_id', access.workspaceId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('internal_fulfillment_locations')
      .select('location_code, location_type')
      .eq('workspace_id', access.workspaceId)
      .eq('is_active', true)
      .limit(5000),
    supabase
      .from('internal_state_zone_map')
      .select('state_code, zone_code')
      .eq('workspace_id', access.workspaceId)
      .eq('is_active', true)
      .limit(5000),
    supabase
      .from('internal_fulfillment_sales_daily')
      .select('asin, sku, marketplace_id, sales_date, ordered_units, state_code, location_code, source')
      .eq('workspace_id', access.workspaceId)
      .gte('sales_date', lookbackStart.toISOString().slice(0, 10))
      .limit(30000),
    supabase
      .from('internal_inventory_by_location')
      .select('asin, sku, marketplace_id, location_code, available_quantity, inbound_quantity, reserved_quantity, unsellable_quantity')
      .eq('workspace_id', access.workspaceId)
      .order('snapshot_at', { ascending: false })
      .limit(30000),
  ])

  if (listingsResult.error) {
    return NextResponse.json(
      { error: 'Stock action data is temporarily unavailable.' },
      { status: 503 },
    )
  }

  if (latestSyncResult.data?.status === 'running') {
    const metadata = (
      latestSyncResult.data.metadata
      && typeof latestSyncResult.data.metadata === 'object'
      && !Array.isArray(latestSyncResult.data.metadata)
    )
      ? latestSyncResult.data.metadata as Record<string, unknown>
      : {}
    const progressAt = typeof metadata.last_progress_at === 'string'
      ? metadata.last_progress_at
      : latestSyncResult.data.started_at
    const progressTime = progressAt ? new Date(progressAt).getTime() : Number.NaN
    const hasSavedData = Number(metadata.inventory_updated ?? 0) > 0
      || Number(metadata.sales_rows_updated ?? 0) > 0

    if (
      hasSavedData
      && Number.isFinite(progressTime)
      && Date.now() - progressTime > 2 * 60 * 1000
    ) {
      const warning = 'Sync session ended after partial Amazon data was saved.'
      const warnings = Array.isArray(metadata.warnings)
        ? metadata.warnings.filter((value): value is string => typeof value === 'string')
        : []
      if (!warnings.includes(warning)) warnings.push(warning)
      const finishedAt = new Date().toISOString()
      const finalizedMetadata = {
        ...metadata,
        phase: 'completed',
        warnings: warnings.slice(0, 8),
        last_progress_at: finishedAt,
      }

      await createAdminClient()
        .from('amazon_sync_jobs')
        .update({
          status: 'completed',
          finished_at: finishedAt,
          metadata: finalizedMetadata,
        })
        .eq('id', latestSyncResult.data.id)
        .eq('workspace_id', access.workspaceId)

      latestSyncResult.data.status = 'completed'
      latestSyncResult.data.finished_at = finishedAt
      latestSyncResult.data.metadata = finalizedMetadata
    }
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

  const key = (marketplace: string | null, value: string | null) =>
    `${marketplace?.trim().toUpperCase() ?? ''}|${value?.trim().toUpperCase() ?? ''}`
  const fulfillmentAsins = new Set<string>()
  const fulfillmentSkus = new Set<string>()
  for (const row of fulfillmentRowsResult.data ?? []) {
    if (row.asin) fulfillmentAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) fulfillmentSkus.add(key(row.marketplace_id, row.sku))
  }
  const salesSourcesByAsin = new Map<string, string>()
  const salesSourcesBySku = new Map<string, string>()
  for (const row of salesResult.data ?? []) {
    const source = row.source === 'amazon_api' ? 'sales_api' : 'csv_upload'
    if (row.asin) {
      const asinKey = key(row.marketplace_id, row.asin)
      if (source === 'sales_api' || !salesSourcesByAsin.has(asinKey)) {
        salesSourcesByAsin.set(asinKey, source)
      }
    }
    if (row.sku) {
      const skuKey = key(row.marketplace_id, row.sku)
      if (source === 'sales_api' || !salesSourcesBySku.has(skuKey)) {
        salesSourcesBySku.set(skuKey, source)
      }
    }
  }

  const actions = calculateStockActions(products, inventoryRows, salesRows).map(action => {
    const hasFulfillment = fulfillmentAsins.has(key(action.marketplaceId, action.asin))
      || fulfillmentSkus.has(key(action.marketplaceId, action.sku))
    const salesSource = salesSourcesByAsin.get(key(action.marketplaceId, action.asin))
      ?? salesSourcesBySku.get(key(action.marketplaceId, action.sku))

    return {
      ...action,
      inventorySource: hasFulfillment
        ? 'fulfillment_report' as const
        : action.available !== null
          ? 'inventory_api' as const
          : 'missing' as const,
      salesSource: action.units30d !== null
        ? (salesSource === 'sales_api' ? 'sales_api' as const : 'csv_upload' as const)
        : 'missing' as const,
    }
  })
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

  const nextStockPlan = buildNextStockPlan({
    products,
    salesRows: (salesResult.error
      ? []
      : (salesResult.data ?? []).map(row => ({
          asin: row.asin as string,
          sku: (row.sku as string | null) ?? null,
          marketplaceId: row.marketplace_id as string,
          salesDate: row.sales_date as string,
          orderedUnits: Number(row.ordered_units ?? 0),
          source: (row.source as string | null) ?? null,
        }))),
    inventoryApiRows: (inventoryResult.error
      ? []
      : (inventoryResult.data ?? []).map(row => ({
          asin: (row.asin as string | null) ?? null,
          sku: row.sku as string,
          marketplaceId: (row.marketplace_id as string | null) ?? null,
          available: Number(row.available_quantity ?? 0),
          inbound: Number(row.inbound_quantity ?? 0),
          reserved: Number(row.reserved_quantity ?? 0),
          unfulfillable: Number((row as { unfulfillable_quantity?: number | null }).unfulfillable_quantity ?? 0),
        }))),
    fulfillmentRows: (fulfillmentRowsResult.data ?? []).map(row => ({
      asin: (row.asin as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      marketplaceId: (row.marketplace_id as string | null) ?? null,
      fulfillmentCenterId: (row.fulfillment_center_id as string | null) ?? null,
      eventType: ((row as { event_type?: string | null }).event_type as string | null) ?? null,
      quantity: Number((row as { quantity?: number | null }).quantity ?? 0),
      reportDate: ((row as { report_date?: string | null }).report_date as string | null) ?? null,
    })),
    fulfillmentLocations: (fulfillmentLocationsResult.data ?? []).map(row => ({
      locationCode: row.location_code as string,
      locationType: row.location_type as string,
    })),
    stateZoneMap: (stateZoneMapResult.data ?? []).map(row => ({
      stateCode: row.state_code as string,
      zoneCode: row.zone_code as string,
    })),
    fulfillmentSalesDaily: (fulfillmentSalesDailyResult.data ?? []).map(row => ({
      asin: (row.asin as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      marketplaceId: (row.marketplace_id as string | null) ?? null,
      salesDate: row.sales_date as string,
      units: Number(row.ordered_units ?? 0),
      stateCode: (row.state_code as string | null) ?? null,
      locationCode: (row.location_code as string | null) ?? null,
      source: (row.source as string | null) ?? null,
    })),
    inventoryByLocation: (inventoryByLocationResult.data ?? []).map(row => ({
      asin: (row.asin as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      marketplaceId: (row.marketplace_id as string | null) ?? null,
      locationCode: (row.location_code as string | null) ?? null,
      available: Number(row.available_quantity ?? 0),
      inbound: Number(row.inbound_quantity ?? 0),
      reserved: Number(row.reserved_quantity ?? 0),
      unsellable: Number(row.unsellable_quantity ?? 0),
    })),
    lookbackDays: DEFAULT_REPLENISHMENT_ASSUMPTIONS.salesLookbackDays,
  })

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
    nextStockPlan,
    diagnostics: {
      products_with_sales: productsWithSales,
      products_missing_sales: Math.max(0, products.length - productsWithSales),
      products_with_inventory: productsWithInventory,
      products_missing_inventory: Math.max(0, products.length - productsWithInventory),
      last_sync_status: lastSyncStatus,
      last_sync_warnings: lastSyncWarnings,
      fulfillment_report_type: fulfillmentJobResult.data?.report_type ?? null,
      fulfillment_report_status: fulfillmentJobResult.data?.processing_status ?? null,
      fulfillment_report_completed_at: fulfillmentJobResult.data?.completed_at ?? null,
      fulfillment_report_rows: fulfillmentJobResult.data?.stored_row_count ?? 0,
      fulfillment_fc_available: fulfillmentJobResult.data?.fc_field_available ?? null,
      state_zone_rows: stateZoneMapResult.data?.length ?? 0,
      fulfillment_location_rows: fulfillmentLocationsResult.data?.length ?? 0,
      fulfillment_sales_daily_rows: fulfillmentSalesDailyResult.data?.length ?? 0,
      inventory_by_location_rows: inventoryByLocationResult.data?.length ?? 0,
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
