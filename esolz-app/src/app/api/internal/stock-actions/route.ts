import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  buildNextStockPlan,
  DEFAULT_REPLENISHMENT_ASSUMPTIONS,
  SELLER_FLEX_CODES,
} from '@/lib/internal-replenishment-planner'
import {
  buildFcReplenishmentRows,
  buildFcStockMatrix,
  buildFlexDemandBreakdownRows,
  buildFlexReplenishmentRows,
} from '@/lib/internal-replenishment-report'
import {
  calculateStockActions,
  type DailySalesInput,
  type InventoryInput,
  type StockProductInput,
} from '@/lib/internal-stock-actions'
import { buildReplenishmentPaymentSignals } from '@/lib/internal/replenishment-payment-signals'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

const ALLOWED_LOOKBACK_DAYS = [15, 30, 60, 90] as const
const ALLOWED_PLANNING_CYCLE_DAYS = [15, 30, 45, 60, 90] as const
const ALLOWED_TRANSIT_BUFFER_DAYS = [7, 15, 21, 30] as const
const ALLOWED_GROWTH_MULTIPLIERS = [1, 1.25, 1.5, 2] as const

function allowedNumber<T extends readonly number[]>(
  value: string | null,
  allowed: T,
  fallback: T[number],
): T[number] {
  const parsed = value === null ? Number.NaN : Number(value)
  return allowed.includes(parsed as T[number]) ? parsed as T[number] : fallback
}

export async function GET(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const searchParams = new URL(request.url).searchParams
  const lookbackDays = allowedNumber(
    searchParams.get('lookbackDays'),
    ALLOWED_LOOKBACK_DAYS,
    DEFAULT_REPLENISHMENT_ASSUMPTIONS.salesLookbackDays,
  )
  const planningCycleDays = allowedNumber(
    searchParams.get('planningCycleDays'),
    ALLOWED_PLANNING_CYCLE_DAYS,
    DEFAULT_REPLENISHMENT_ASSUMPTIONS.planningCycleDays,
  )
  const transitBufferDays = allowedNumber(
    searchParams.get('transitBufferDays'),
    ALLOWED_TRANSIT_BUFFER_DAYS,
    DEFAULT_REPLENISHMENT_ASSUMPTIONS.transitBufferDays,
  )
  const growthMultiplier = allowedNumber(
    searchParams.get('growthMultiplier'),
    ALLOWED_GROWTH_MULTIPLIERS,
    DEFAULT_REPLENISHMENT_ASSUMPTIONS.growthMultiplier,
  )

  const supabase = await createClient()
  const salesStart = new Date()
  salesStart.setUTCDate(salesStart.getUTCDate() - (Math.max(30, lookbackDays) - 1))
  const lookbackStart = new Date()
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - (lookbackDays - 1))
  const paymentTransactionsPromise = async () => {
    const pageSize = 1000
    const maxRows = 50000
    const rows: Array<{
      transaction_date: string
      category: string
      sku: string | null
      sku_norm: string | null
      order_state: string | null
      quantity: number | null
      product_sales: number | null
      selling_fees: number | null
      fba_fees: number | null
      other_transaction_fees: number | null
    }> = []

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const result = await supabase
        .from('internal_payment_transactions')
        .select('transaction_date, category, sku, sku_norm, order_state, quantity, product_sales, selling_fees, fba_fees, other_transaction_fees')
        .eq('workspace_id', access.workspaceId)
        .gte('transaction_date', lookbackStart.toISOString())
        .order('transaction_date', { ascending: true })
        .range(offset, offset + pageSize - 1)
      if (result.error) return { data: rows, error: result.error, limitReached: false }
      rows.push(...(result.data ?? []))
      if (!result.data || result.data.length < pageSize) {
        return { data: rows, error: null, limitReached: false }
      }
    }
    return { data: rows, error: null, limitReached: true }
  }

  // Supabase/PostgREST enforces a server-side max-rows cap (commonly 1000) that silently
  // truncates a single .limit(N) request even when N is larger. FBA Ledger Detail volume
  // regularly exceeds that cap, which was silently dropping most "Shipments" rows and
  // under-counting trusted FBA/Seller Flex demand. Paginate the same way as payment
  // transactions above to fetch the full set.
  const fulfillmentReportRowsPromise = async () => {
    const pageSize = 1000
    const maxRows = 50000
    const rows: Array<{
      asin: string | null
      sku: string | null
      marketplace_id: string | null
      fulfillment_center_id: string | null
      event_type: string | null
      quantity: number | null
      report_date: string | null
      running_balance: number | null
    }> = []

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const result = await supabase
        .from('internal_fba_report_rows')
        .select('asin, sku, marketplace_id, fulfillment_center_id, event_type, quantity, report_date, running_balance')
        .eq('workspace_id', access.workspaceId)
        .order('report_date', { ascending: true })
        .range(offset, offset + pageSize - 1)
      if (result.error) return { data: rows, error: result.error, limitReached: false }
      rows.push(...(result.data ?? []))
      if (!result.data || result.data.length < pageSize) {
        return { data: rows, error: null, limitReached: false }
      }
    }
    return { data: rows, error: null, limitReached: true }
  }

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
    paymentTransactionsResult,
    skuCostsResult,
    componentMappingsResult,
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
      .gte('sales_date', salesStart.toISOString().slice(0, 10))
      .limit(30000),
    supabase
      .from('amazon_sync_jobs')
      .select('id, status, started_at, finished_at, metadata')
      .eq('workspace_id', access.workspaceId)
      .eq('job_type', 'internal_stock_sales_sync')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    fulfillmentReportRowsPromise(),
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
      .select('state_code, state_name, zone_code, zone_name')
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
    paymentTransactionsPromise(),
    supabase
      .from('internal_sku_cost_master')
      .select('sku_norm, cost_price, packing_transport')
      .eq('workspace_id', access.workspaceId)
      .eq('is_active', true)
      .limit(10000),
    supabase
      .from('internal_sku_component_mappings')
      .select('amazon_sku, amazon_sku_norm, wms_parent_sku, component_sku, component_sku_norm, component_quantity')
      .eq('workspace_id', access.workspaceId)
      .eq('is_active', true)
      .limit(10000),
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

  // Broader coverage signals: a product can have a usable demand or stock
  // signal from more than one source. Each set below tracks presence only
  // (never summed quantities), so union counts below cannot double-count units.
  const demandAsins = new Set<string>()
  const demandSkus = new Set<string>()
  const genericSourceAsins = new Set<string>()
  const genericSourceSkus = new Set<string>()
  const genericSalesSources = new Set(['amazon_api', 'csv_upload', 'manual', 'unknown', ''])
  for (const row of salesResult.data ?? []) {
    if (Number(row.ordered_units ?? 0) === 0) continue
    if (row.asin) demandAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) demandSkus.add(key(row.marketplace_id, row.sku))
    const source = ((row.source as string | null) ?? '').trim().toLowerCase()
    if (genericSalesSources.has(source)) {
      if (row.asin) genericSourceAsins.add(key(row.marketplace_id, row.asin))
      if (row.sku) genericSourceSkus.add(key(row.marketplace_id, row.sku))
    }
  }
  const blankFcShipmentAsins = new Set<string>()
  const blankFcShipmentSkus = new Set<string>()
  for (const row of fulfillmentRowsResult.data ?? []) {
    const eventType = ((row as { event_type?: string | null }).event_type ?? '').toString().trim().toLowerCase()
    const quantity = Number((row as { quantity?: number | null }).quantity ?? 0)
    if (eventType !== 'shipments' || quantity === 0) continue
    if (row.asin) demandAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) demandSkus.add(key(row.marketplace_id, row.sku))
    const fulfillmentCenterId = ((row as { fulfillment_center_id?: string | null }).fulfillment_center_id ?? '').trim()
    if (!fulfillmentCenterId) {
      if (row.asin) blankFcShipmentAsins.add(key(row.marketplace_id, row.asin))
      if (row.sku) blankFcShipmentSkus.add(key(row.marketplace_id, row.sku))
    }
  }
  for (const row of fulfillmentSalesDailyResult.data ?? []) {
    if (Number(row.ordered_units ?? 0) === 0) continue
    if (row.asin) demandAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) demandSkus.add(key(row.marketplace_id, row.sku))
  }

  const ledgerBalanceAsins = new Set<string>()
  const ledgerBalanceSkus = new Set<string>()
  for (const row of fulfillmentRowsResult.data ?? []) {
    const runningBalance = (row as { running_balance?: number | null }).running_balance
    if (runningBalance === null || runningBalance === undefined) continue
    if (row.asin) ledgerBalanceAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) ledgerBalanceSkus.add(key(row.marketplace_id, row.sku))
  }

  const locationStockAsins = new Set<string>()
  const locationStockSkus = new Set<string>()
  for (const row of inventoryByLocationResult.data ?? []) {
    if (row.asin) locationStockAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) locationStockSkus.add(key(row.marketplace_id, row.sku))
  }

  const fbaInventoryApiAsins = new Set<string>()
  const fbaInventoryApiSkus = new Set<string>()
  for (const row of inventoryResult.data ?? []) {
    if (row.asin) fbaInventoryApiAsins.add(key(row.marketplace_id, row.asin))
    if (row.sku) fbaInventoryApiSkus.add(key(row.marketplace_id, row.sku))
  }

  let productsWithDemandSignal = 0
  let productsWithFbaInventoryApi = 0
  let productsWithLedgerBalance = 0
  let productsWithLocationStock = 0
  let productsWithAnyStockContext = 0
  let productsWithGenericSourceLabels = 0
  let productsWithBlankFcShipments = 0
  for (const product of products) {
    const asinKey = key(product.marketplaceId, product.asin)
    const skuKey = key(product.marketplaceId, product.sku)
    const hasDemand = demandAsins.has(asinKey) || demandSkus.has(skuKey)
    const hasFbaInventoryApi = fbaInventoryApiAsins.has(asinKey) || fbaInventoryApiSkus.has(skuKey)
    const hasLedgerBalance = ledgerBalanceAsins.has(asinKey) || ledgerBalanceSkus.has(skuKey)
    const hasLocationStock = locationStockAsins.has(asinKey) || locationStockSkus.has(skuKey)
    const hasGenericSource = genericSourceAsins.has(asinKey) || genericSourceSkus.has(skuKey)
    const hasBlankFcShipment = blankFcShipmentAsins.has(asinKey) || blankFcShipmentSkus.has(skuKey)
    if (hasDemand) productsWithDemandSignal += 1
    if (hasFbaInventoryApi) productsWithFbaInventoryApi += 1
    if (hasLedgerBalance) productsWithLedgerBalance += 1
    if (hasLocationStock) productsWithLocationStock += 1
    if (hasFbaInventoryApi || hasLedgerBalance || hasLocationStock) productsWithAnyStockContext += 1
    if (hasGenericSource) productsWithGenericSourceLabels += 1
    if (hasBlankFcShipment) productsWithBlankFcShipments += 1
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

  const inventoryByLocationRows = (inventoryByLocationResult.data ?? []).map(row => ({
    asin: (row.asin as string | null) ?? null,
    sku: (row.sku as string | null) ?? null,
    marketplaceId: (row.marketplace_id as string | null) ?? null,
    locationCode: (row.location_code as string | null) ?? null,
    available: Number(row.available_quantity ?? 0),
    inbound: Number(row.inbound_quantity ?? 0),
    reserved: Number(row.reserved_quantity ?? 0),
    unsellable: Number(row.unsellable_quantity ?? 0),
  }))
  const componentMappingRows = componentMappingsResult.error
    ? []
    : (componentMappingsResult.data ?? []).map(row => ({
        amazonSku: row.amazon_sku as string,
        amazonSkuNorm: row.amazon_sku_norm as string,
        wmsParentSku: (row.wms_parent_sku as string | null) ?? null,
        componentSku: row.component_sku as string,
        componentSkuNorm: row.component_sku_norm as string,
        componentQuantity: Number(row.component_quantity),
      }))
  const sellerFlexLocationCodes = new Set<string>(SELLER_FLEX_CODES)
  for (const row of fulfillmentLocationsResult.data ?? []) {
    if ((row.location_type as string | null) === 'seller_flex' && row.location_code) {
      sellerFlexLocationCodes.add(String(row.location_code).trim().toUpperCase())
    }
  }

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
      runningBalance: (row as { running_balance?: number | null }).running_balance ?? null,
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
    inventoryByLocation: inventoryByLocationRows,
    lookbackDays,
    planningCycleDays,
    transitBufferDays,
    growthMultiplier,
  })
  const paymentContext = buildReplenishmentPaymentSignals({
    transactions: paymentTransactionsResult.error
      ? []
      : (paymentTransactionsResult.data ?? []).map(row => ({
          transactionDate: row.transaction_date as string,
          category: row.category as string,
          sku: (row.sku as string | null) ?? null,
          skuNorm: (row.sku_norm as string | null) ?? null,
          orderState: (row.order_state as string | null) ?? null,
          quantity: row.quantity === null ? null : Number(row.quantity),
          productSales: Number(row.product_sales ?? 0),
          sellingFees: Number(row.selling_fees ?? 0),
          fbaFees: Number(row.fba_fees ?? 0),
          otherTransactionFees: Number(row.other_transaction_fees ?? 0),
        })),
    stateZoneMap: (stateZoneMapResult.data ?? []).map(row => ({
      stateCode: row.state_code as string,
      stateName: (row.state_name as string | null) ?? null,
      zoneCode: row.zone_code as string,
      zoneName: (row.zone_name as string | null) ?? null,
    })),
    componentMappings: componentMappingRows,
    costs: skuCostsResult.error
      ? []
      : (skuCostsResult.data ?? []).map(row => ({
          skuNorm: row.sku_norm as string,
          costPrice: row.cost_price === null ? null : Number(row.cost_price),
          packingTransport: row.packing_transport === null ? null : Number(row.packing_transport),
        })),
    stockSignals: nextStockPlan.rows.map(row => ({
      sku: row.sku,
      suggestedFbaReplenishment: row.suggestedFbaReplenishment,
      suggestedSellerFlexReplenishment: row.suggestedSellerFlexReplenishment,
    })),
    transactionRowLimitReached: paymentTransactionsResult.limitReached,
  })
  const unattributedDailySalesUnits = nextStockPlan.rows.reduce(
    (sum, row) => sum + row.unknownSourceSales30d,
    0,
  )

  const fcReplenishment = buildFcReplenishmentRows({
    fcDiagnostics: nextStockPlan.fcDiagnostics,
    inventoryByLocation: inventoryByLocationRows,
    assumptions: nextStockPlan.assumptions,
    planRows: nextStockPlan.rows,
    paymentSignals: paymentContext.paymentSignals,
  })
  const flexReplenishment = buildFlexReplenishmentRows({
    componentMappings: componentMappingRows,
    planRows: nextStockPlan.rows,
    assumptions: nextStockPlan.assumptions,
    inventoryByLocation: inventoryByLocationRows,
    paymentSignals: paymentContext.paymentSignals,
    stateZoneDemand: paymentContext.stateZoneDemand,
    sellerFlexLocationCodes,
  })
  const fcStockMatrix = buildFcStockMatrix({
    fcReplenishmentRows: fcReplenishment.rows,
    inventoryByLocation: inventoryByLocationRows,
    sellerFlexLocationCodes,
  })
  const flexDemandBreakdownRows = buildFlexDemandBreakdownRows({
    componentMappings: componentMappingRows,
    planRows: nextStockPlan.rows,
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
    paymentContext,
    fcReplenishmentRows: fcReplenishment.rows,
    fcReplenishmentSummary: fcReplenishment.summary,
    flexReplenishmentRows: flexReplenishment.rows,
    flexReplenishmentSummary: flexReplenishment.summary,
    fcStockMatrixRows: fcStockMatrix.rows,
    fcStockMatrixColumns: fcStockMatrix.columns,
    flexDemandBreakdownRows,
    diagnostics: {
      products_with_sales: productsWithSales,
      products_missing_sales: Math.max(0, products.length - productsWithSales),
      products_with_inventory: productsWithInventory,
      products_missing_inventory: Math.max(0, products.length - productsWithInventory),
      products_with_demand_signal: productsWithDemandSignal,
      products_missing_demand_signal: Math.max(0, products.length - productsWithDemandSignal),
      products_with_fba_inventory_api: productsWithFbaInventoryApi,
      products_with_ledger_balance: productsWithLedgerBalance,
      products_with_location_stock: productsWithLocationStock,
      products_with_any_stock_context: productsWithAnyStockContext,
      products_missing_any_stock_context: Math.max(0, products.length - productsWithAnyStockContext),
      unattributed_daily_sales_units: unattributedDailySalesUnits,
      products_with_unattributed_daily_sales: nextStockPlan.summary.productsUnknownSourceSales,
      products_with_blank_fc_shipments: productsWithBlankFcShipments,
      products_with_generic_source_labels: productsWithGenericSourceLabels,
      last_sync_status: lastSyncStatus,
      last_sync_warnings: lastSyncWarnings,
      fulfillment_report_type: fulfillmentJobResult.data?.report_type ?? null,
      fulfillment_report_status: fulfillmentJobResult.data?.processing_status ?? null,
      fulfillment_report_completed_at: fulfillmentJobResult.data?.completed_at ?? null,
      fulfillment_report_rows: fulfillmentJobResult.data?.stored_row_count ?? 0,
      fulfillment_fc_available: fulfillmentJobResult.data?.fc_field_available ?? null,
      fulfillment_report_rows_fetched: fulfillmentRowsResult.data?.length ?? 0,
      fulfillment_report_row_limit_reached: fulfillmentRowsResult.limitReached ?? false,
      state_zone_rows: stateZoneMapResult.data?.length ?? 0,
      fulfillment_location_rows: fulfillmentLocationsResult.data?.length ?? 0,
      fulfillment_sales_daily_rows: fulfillmentSalesDailyResult.data?.length ?? 0,
      inventory_by_location_rows: inventoryByLocationResult.data?.length ?? 0,
      component_mapping_rows: componentMappingRows.length,
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
