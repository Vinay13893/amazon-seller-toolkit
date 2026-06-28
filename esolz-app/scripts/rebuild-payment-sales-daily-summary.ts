// Phase R2 foundation: derives internal_payment_sales_daily_summary from
// internal_payment_transactions. Read-only against Amazon (never calls any
// Amazon API — this only reads/writes our own Supabase tables) and purely
// additive: it never touches internal_payment_transactions, never stores
// buyer name/email/phone/address, and never stores raw order IDs in the
// summary table (only aggregate counts/amounts).
//
// This is a foundation step only — nothing in the app reads this table yet.
// It exists so blended ROAS/TACOS can be built on top of it later without
// re-deriving the aggregation logic from scratch.
//
// Usage:
//   npx tsx scripts/rebuild-payment-sales-daily-summary.ts                  # full history
//   npx tsx scripts/rebuild-payment-sales-daily-summary.ts --from=2026-06-01 --to=2026-06-24

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  // no .env.local present — fine outside local dev
}

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([a-zA-Z-]+)=(.*)$/)
    if (m) args.set(m[1], m[2])
  }
  return args
}

/** Mirrors classifyFulfillmentBucket in src/app/api/internal/stock-actions/geo-demand/route.ts — same source column, same two known values ('Amazon' / 'Merchant'). */
function classifyFulfillmentBucket(fulfillment: string | null): 'fba_fc' | 'direct_flex_easyship' | 'unknown' {
  if (!fulfillment) return 'unknown'
  const f = fulfillment.toLowerCase().trim()
  if (f === 'amazon') return 'fba_fc'
  if (f === 'merchant') return 'direct_flex_easyship'
  return 'unknown'
}

type TxnRow = {
  transaction_date: string
  marketplace: string
  sku_norm: string | null
  fulfillment: string | null
  category: string
  quantity: number | null
  product_sales: number
  order_id: string | null
}

type SummaryBucket = {
  marketplaceId: string
  salesDate: string
  amazonSku: string | null
  fulfillmentBucket: 'fba_fc' | 'direct_flex_easyship' | 'unknown'
  unitsSold: number
  ordersSet: Set<string>
  grossSalesAmount: number
  refundsAmount: number
  returnsSet: Set<string>
  refundedUnits: number
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

async function main() {
  const args = parseArgs()
  const from = args.get('from') ?? null
  const to = args.get('to') ?? null

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log(`Rebuilding internal_payment_sales_daily_summary${from || to ? ` for ${from ?? 'earliest'}..${to ?? 'latest'}` : ' (full history)'} — read-only against Amazon.`)

  const { data: workspaceRows } = await admin.from('internal_payment_transactions').select('workspace_id').limit(1)
  const workspaceId = workspaceRows?.[0]?.workspace_id as string | undefined
  if (!workspaceId) {
    console.error('No workspace found with any payment transactions.')
    process.exitCode = 1
    return
  }

  const buckets = new Map<string, SummaryBucket>()
  const PAGE = 1000
  let totalRows = 0
  for (let offset = 0; ; offset += PAGE) {
    let query = admin
      .from('internal_payment_transactions')
      .select('transaction_date, marketplace, sku_norm, fulfillment, category, quantity, product_sales, order_id')
      .eq('workspace_id', workspaceId)
      .in('category', ['Order', 'Refund'])
      .order('transaction_date', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (from) query = query.gte('transaction_date', from)
    if (to) query = query.lte('transaction_date', to)

    const { data, error } = await query
    if (error) {
      console.error(`Reading internal_payment_transactions failed: ${error.message}`)
      process.exitCode = 1
      return
    }
    for (const row of (data ?? []) as TxnRow[]) {
      totalRows += 1
      const salesDate = row.transaction_date.slice(0, 10)
      const marketplaceId = row.marketplace
      const amazonSku = row.sku_norm
      const fulfillmentBucket = classifyFulfillmentBucket(row.fulfillment)
      const key = [marketplaceId, salesDate, amazonSku ?? '', fulfillmentBucket].join('|')

      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {
          marketplaceId, salesDate, amazonSku, fulfillmentBucket,
          unitsSold: 0, ordersSet: new Set(), grossSalesAmount: 0, refundsAmount: 0, returnsSet: new Set(), refundedUnits: 0,
        }
        buckets.set(key, bucket)
      }

      if (row.category === 'Order') {
        bucket.unitsSold += row.quantity ?? 0
        bucket.grossSalesAmount += row.product_sales
        if (row.order_id) bucket.ordersSet.add(row.order_id)
      } else {
        bucket.refundsAmount += Math.abs(row.product_sales)
        bucket.refundedUnits += Math.abs(row.quantity ?? 0)
        if (row.order_id) bucket.returnsSet.add(row.order_id)
      }
    }
    if (!data || data.length < PAGE) break
  }

  console.log(`Aggregated ${totalRows} transaction rows into ${buckets.size} daily summary bucket(s).`)

  if (buckets.size === 0) {
    console.log('Nothing to write.')
    return
  }

  // Read existing summary rows for the same key space so this rebuild
  // updates in place rather than duplicating (no DB-level upsert here since
  // the unique index is expression-based on coalesce(amazon_sku, '')).
  const existingIdByKey = new Map<string, string>()
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('internal_payment_sales_daily_summary')
      .select('id, marketplace_id, sales_date, amazon_sku, fulfillment_bucket')
      .eq('workspace_id', workspaceId)
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error(`Reading existing internal_payment_sales_daily_summary failed: ${error.message}`)
      process.exitCode = 1
      return
    }
    for (const row of data ?? []) {
      const key = [row.marketplace_id, row.sales_date, row.amazon_sku ?? '', row.fulfillment_bucket].join('|')
      existingIdByKey.set(key, row.id as string)
    }
    if (!data || data.length < PAGE) break
  }

  const insertRows: Array<Record<string, unknown>> = []
  const updateRows: Array<Record<string, unknown> & { id: string }> = []
  for (const [key, b] of buckets) {
    const row = {
      workspace_id: workspaceId,
      marketplace_id: b.marketplaceId,
      sales_date: b.salesDate,
      amazon_sku: b.amazonSku,
      fulfillment_bucket: b.fulfillmentBucket,
      units_sold: b.unitsSold,
      orders_count: b.ordersSet.size,
      gross_sales_amount: round2(b.grossSalesAmount),
      refunds_amount: round2(b.refundsAmount),
      net_sales_amount: round2(b.grossSalesAmount - b.refundsAmount),
      returns_count: b.returnsSet.size,
      refunded_units: b.refundedUnits,
      source: 'payment_transactions_derived',
    }
    const existingId = existingIdByKey.get(key)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

  const CHUNK = 500
  let actuallyInserted = 0
  let conflictsResolvedAsUpdate = 0
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const chunk = insertRows.slice(i, i + CHUNK)
    const { error } = await admin.from('internal_payment_sales_daily_summary').insert(chunk)
    if (!error) {
      actuallyInserted += chunk.length
      continue
    }
    if (error.code !== '23505') {
      console.error(`Inserting summary rows failed: ${error.message}`)
      process.exitCode = 1
      return
    }
    // A row that looked new a moment ago can collide with one written
    // between the existing-rows read and this write (e.g. a concurrent
    // rebuild, or read-after-large-write replica lag). Fall back to
    // row-by-row: insert what's genuinely new, update the rest by key.
    for (const row of chunk) {
      const { error: rowError } = await admin.from('internal_payment_sales_daily_summary').insert([row])
      if (!rowError) { actuallyInserted += 1; continue }
      if (rowError.code !== '23505') {
        console.error(`Inserting summary row failed: ${rowError.message}`)
        process.exitCode = 1
        return
      }
      const { error: updateError } = await admin
        .from('internal_payment_sales_daily_summary')
        .update(row)
        .eq('workspace_id', row.workspace_id)
        .eq('marketplace_id', row.marketplace_id)
        .eq('sales_date', row.sales_date)
        .eq('fulfillment_bucket', row.fulfillment_bucket)
        .filter('amazon_sku', row.amazon_sku === null ? 'is' : 'eq', row.amazon_sku)
      if (updateError) {
        console.error(`Resolving conflicting summary row failed: ${updateError.message}`)
        process.exitCode = 1
        return
      }
      conflictsResolvedAsUpdate += 1
    }
  }
  for (let i = 0; i < updateRows.length; i += CHUNK) {
    const { error } = await admin.from('internal_payment_sales_daily_summary').upsert(updateRows.slice(i, i + CHUNK), { onConflict: 'id' })
    if (error) {
      console.error(`Updating summary rows failed: ${error.message}`)
      process.exitCode = 1
      return
    }
  }

  console.log(`Done. Inserted ${actuallyInserted}, updated ${updateRows.length + conflictsResolvedAsUpdate} summary row(s). No buyer PII or raw order IDs were stored.`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
