import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 30

const ALLOWED_LOOKBACK_DAYS = [7, 15, 30, 45, 60, 90, 180] as const
const DEFAULT_LOOKBACK_DAYS = 30

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function classifyFulfillmentBucket(
  fulfillment: string | null,
): 'fba_fc' | 'direct_flex_easyship' | 'unknown' {
  if (!fulfillment) return 'unknown'
  const f = fulfillment.toLowerCase().trim()
  if (f === 'amazon') return 'fba_fc'
  if (f === 'merchant') return 'direct_flex_easyship'
  return 'unknown'
}

export type GeoDemandRow = {
  state: string | null
  city: string | null
  pincode: string | null
  fulfillment_bucket: 'fba_fc' | 'direct_flex_easyship' | 'unknown'
  units_sold: number
  orders_count: number
  returns_count: number
  refunded_units: number
  gross_sales_amount: number
  refunds_amount: number
}

export type SkuDemandRow = {
  amazon_sku_norm: string
  fulfillment_bucket: 'fba_fc' | 'direct_flex_easyship' | 'unknown'
  units_sold: number
  orders_count: number
  refunded_units: number
}

export type FcLedgerRow = {
  fulfillment_center_id: string
  units_shipped: number
  distinct_skus: number
}

export type GeoDemandResponse = {
  demandStartDate: string
  demandEndDate: string
  demandDays: number

  // Transaction report totals
  totalTransactionUnits: number
  fbaFcTransactionUnits: number
  directFlexEasyshipUnits: number
  unknownFulfillmentUnits: number
  totalOrdersCount: number
  totalReturnsCount: number
  totalRefundedUnits: number

  // FBA ledger totals (event_type = 'Shipments')
  ledgerFbaShipmentUnits: number
  ledgerFcBreakdown: FcLedgerRow[]

  // Reconciliation
  transactionVsLedgerDiff: number
  transactionVsLedgerDiffPct: number | null

  // Top geo
  topStates: GeoDemandRow[]
  topCities: GeoDemandRow[]
  topPincodes: GeoDemandRow[]

  // Top SKUs
  topSkus: SkuDemandRow[]

  // Data freshness
  lastTransactionDate: string | null
  lastLedgerDate: string | null
  transactionRowsInRange: number
}

export async function GET(request: Request): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const { searchParams } = new URL(request.url)
  const lookbackParam = Number(searchParams.get('lookbackDays') ?? DEFAULT_LOOKBACK_DAYS)
  const lookbackDays = (ALLOWED_LOOKBACK_DAYS as readonly number[]).includes(lookbackParam)
    ? lookbackParam
    : DEFAULT_LOOKBACK_DAYS

  const demandEndDateParam = searchParams.get('demandEndDate')
  const demandStartDateParam = searchParams.get('demandStartDate')

  const today = new Date()
  const demandEndDate = demandEndDateParam ?? toDateStr(today)
  const demandStartDate = demandStartDateParam ?? toDateStr(
    new Date(today.getTime() - (lookbackDays - 1) * 86400000),
  )
  const demandDays = Math.max(
    1,
    Math.round(
      (new Date(demandEndDate).getTime() - new Date(demandStartDate).getTime()) / 86400000,
    ) + 1,
  )

  const supabase = createAdminClient()

  // ── Transaction report aggregates ──────────────────────────────────────────
  const { data: txRows, error: txError } = await supabase
    .from('internal_payment_transactions')
    .select(
      'fulfillment, quantity, order_state, order_city, order_postal, category, product_sales, total_amount, transaction_date',
    )
    .eq('workspace_id', workspaceId)
    .in('category', ['Order', 'Refund'])
    .gte('transaction_date', `${demandStartDate}T00:00:00+00:00`)
    .lte('transaction_date', `${demandEndDate}T23:59:59+00:00`)
    .limit(200000)

  if (txError) {
    return NextResponse.json({ error: 'Failed to load transaction data.' }, { status: 500 })
  }

  type TxRow = {
    fulfillment: string | null
    quantity: number | null
    order_state: string | null
    order_city: string | null
    order_postal: string | null
    category: string | null
    product_sales: number | null
    total_amount: number | null
    transaction_date: string
  }
  const rows = (txRows ?? []) as TxRow[]

  let totalTransactionUnits = 0
  let fbaFcTransactionUnits = 0
  let directFlexEasyshipUnits = 0
  let unknownFulfillmentUnits = 0
  let totalOrdersCount = 0
  let totalReturnsCount = 0
  let totalRefundedUnits = 0

  const stateMap = new Map<string, GeoDemandRow>()
  const cityMap = new Map<string, GeoDemandRow>()
  const pincodeMap = new Map<string, GeoDemandRow>()
  const skuMap = new Map<string, SkuDemandRow>()

  for (const row of rows) {
    const qty = Math.abs(Number(row.quantity ?? 0))
    const bucket = classifyFulfillmentBucket(row.fulfillment)
    const isRefund = row.category === 'Refund'
    const state = row.order_state ?? null
    const city = row.order_city ?? null
    const pincode = row.order_postal ?? null
    const sales = Number(row.product_sales ?? 0)

    if (!isRefund) {
      totalTransactionUnits += qty
      totalOrdersCount += 1
      if (bucket === 'fba_fc') fbaFcTransactionUnits += qty
      else if (bucket === 'direct_flex_easyship') directFlexEasyshipUnits += qty
      else unknownFulfillmentUnits += qty
    } else {
      totalReturnsCount += 1
      totalRefundedUnits += qty
    }

    // Geo aggregation (Order rows only for units_sold; track refunds separately)
    if (state) {
      const stateKey = `${state}|${bucket}`
      const existing = stateMap.get(stateKey) ?? {
        state, city: null, pincode: null, fulfillment_bucket: bucket,
        units_sold: 0, orders_count: 0, returns_count: 0, refunded_units: 0,
        gross_sales_amount: 0, refunds_amount: 0,
      }
      if (!isRefund) {
        existing.units_sold += qty
        existing.orders_count += 1
        existing.gross_sales_amount += sales
      } else {
        existing.returns_count += 1
        existing.refunded_units += qty
        existing.refunds_amount += Math.abs(Number(row.total_amount ?? 0))
      }
      stateMap.set(stateKey, existing)
    }

    if (city && state) {
      const cityKey = `${state}|${city}|${bucket}`
      const existing = cityMap.get(cityKey) ?? {
        state, city, pincode: null, fulfillment_bucket: bucket,
        units_sold: 0, orders_count: 0, returns_count: 0, refunded_units: 0,
        gross_sales_amount: 0, refunds_amount: 0,
      }
      if (!isRefund) {
        existing.units_sold += qty
        existing.orders_count += 1
        existing.gross_sales_amount += sales
      } else {
        existing.returns_count += 1
        existing.refunded_units += qty
        existing.refunds_amount += Math.abs(Number(row.total_amount ?? 0))
      }
      cityMap.set(cityKey, existing)
    }

    if (pincode) {
      const pincodeKey = `${pincode}|${bucket}`
      const existing = pincodeMap.get(pincodeKey) ?? {
        state, city, pincode, fulfillment_bucket: bucket,
        units_sold: 0, orders_count: 0, returns_count: 0, refunded_units: 0,
        gross_sales_amount: 0, refunds_amount: 0,
      }
      if (!isRefund) {
        existing.units_sold += qty
        existing.orders_count += 1
        existing.gross_sales_amount += sales
      } else {
        existing.returns_count += 1
        existing.refunded_units += qty
        existing.refunds_amount += Math.abs(Number(row.total_amount ?? 0))
      }
      pincodeMap.set(pincodeKey, existing)
    }
  }

  const topStates = [...stateMap.values()]
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 15)

  const topCities = [...cityMap.values()]
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 15)

  const topPincodes = [...pincodeMap.values()]
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 15)

  const topSkus = [...skuMap.values()]
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 20)

  const lastTransactionDate = rows.length > 0
    ? rows.reduce((max, r) => {
        const d = r.transaction_date.slice(0, 10)
        return d > max ? d : max
      }, '0000-00-00')
    : null

  // ── FBA ledger shipments (FC breakdown) ─────────────────────────────────────
  const { data: ledgerRows, error: ledgerError } = await supabase
    .from('internal_fba_report_rows')
    .select('fulfillment_center_id, quantity')
    .eq('workspace_id', workspaceId)
    .eq('event_type', 'Shipments')
    .gte('reported_date', demandStartDate)
    .lte('reported_date', demandEndDate)
    .limit(200000)

  type LedgerRow = { fulfillment_center_id: string | null; quantity: number | null }
  let ledgerFbaShipmentUnits = 0
  const fcMap = new Map<string, { units: number; skus: Set<string> }>()

  if (!ledgerError) {
    for (const row of (ledgerRows ?? []) as LedgerRow[]) {
      const qty = Math.abs(Number(row.quantity ?? 0))
      ledgerFbaShipmentUnits += qty
      const fc = row.fulfillment_center_id ?? 'UNKNOWN'
      const existing = fcMap.get(fc) ?? { units: 0, skus: new Set() }
      existing.units += qty
      fcMap.set(fc, existing)
    }
  }

  const ledgerFcBreakdown: FcLedgerRow[] = [...fcMap.entries()]
    .sort((a, b) => b[1].units - a[1].units)
    .map(([fc, data]) => ({
      fulfillment_center_id: fc,
      units_shipped: data.units,
      distinct_skus: data.skus.size,
    }))

  const lastLedgerDate = (ledgerRows ?? []).length > 0
    ? null // reported_date not selected — keep null for now
    : null

  const transactionVsLedgerDiff = fbaFcTransactionUnits - ledgerFbaShipmentUnits
  const transactionVsLedgerDiffPct =
    ledgerFbaShipmentUnits > 0
      ? Math.round((transactionVsLedgerDiff / ledgerFbaShipmentUnits) * 10000) / 100
      : null

  const response: GeoDemandResponse = {
    demandStartDate,
    demandEndDate,
    demandDays,
    totalTransactionUnits,
    fbaFcTransactionUnits,
    directFlexEasyshipUnits,
    unknownFulfillmentUnits,
    totalOrdersCount,
    totalReturnsCount,
    totalRefundedUnits,
    ledgerFbaShipmentUnits,
    ledgerFcBreakdown,
    transactionVsLedgerDiff,
    transactionVsLedgerDiffPct,
    topStates,
    topCities,
    topPincodes,
    topSkus,
    lastTransactionDate,
    lastLedgerDate,
    transactionRowsInRange: rows.length,
  }

  return NextResponse.json(response)
}
