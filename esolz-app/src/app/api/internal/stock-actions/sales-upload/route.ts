import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { parseAggregatedSalesCsv } from '@/lib/internal-sales-csv'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 5000
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const UPSERT_CHUNK_SIZE = 500

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const formData = await request.formData().catch(() => null)
  const file = formData?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Select a CSV file.' }, { status: 400 })
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'CSV must be between 1 byte and 2 MB.' }, { status: 400 })
  }
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return NextResponse.json({ error: 'Only CSV files are accepted.' }, { status: 400 })
  }

  let parsed
  try {
    parsed = parseAggregatedSalesCsv(await file.text())
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'CSV could not be validated.' },
      { status: 400 },
    )
  }

  if (parsed.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `CSV exceeds the ${MAX_ROWS.toLocaleString('en-US')} accepted-row limit.` },
      { status: 400 },
    )
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({
      accepted: 0,
      rejected: parsed.rejected,
      errors: parsed.errors,
    })
  }

  const admin = createAdminClient()
  const missingMarketplaceAsins = Array.from(new Set(
    parsed.rows.filter(row => !row.marketplaceId).map(row => row.asin),
  ))
  const marketplaceByAsin = new Map<string, string>()

  if (missingMarketplaceAsins.length > 0) {
    const { data: listings } = await admin
      .from('amazon_listing_items')
      .select('asin, marketplace_id')
      .eq('workspace_id', access.workspaceId)
      .in('asin', missingMarketplaceAsins)
      .not('marketplace_id', 'is', null)

    for (const listing of listings ?? []) {
      if (!marketplaceByAsin.has(listing.asin as string)) {
        marketplaceByAsin.set(listing.asin as string, listing.marketplace_id as string)
      }
    }
  }

  const dedupedRows = new Map<string, {
    workspace_id: string
    marketplace_id: string
    asin: string
    sku: string
    sales_date: string
    ordered_units: number
    ordered_revenue: number | null
    source: string
  }>()

  for (const row of parsed.rows) {
    const marketplaceId = row.marketplaceId
      ?? marketplaceByAsin.get(row.asin)
      ?? DEFAULT_MARKETPLACE_ID
    const key = [
      marketplaceId,
      row.asin,
      row.sku,
      row.salesDate,
      'csv_upload',
    ].join('|')
    dedupedRows.set(key, {
      workspace_id: access.workspaceId,
      marketplace_id: marketplaceId,
      asin: row.asin,
      sku: row.sku,
      sales_date: row.salesDate,
      ordered_units: row.orderedUnits,
      ordered_revenue: row.orderedRevenue,
      source: 'csv_upload',
    })
  }

  const rows = [...dedupedRows.values()]

  for (let index = 0; index < rows.length; index += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + UPSERT_CHUNK_SIZE)
    const { error } = await admin
      .from('internal_sku_daily_sales')
      .upsert(chunk, {
        onConflict: 'workspace_id,marketplace_id,asin,sku,sales_date,source',
      })

    if (error) {
      return NextResponse.json(
        { error: 'Validated rows could not be saved. Confirm migration 026 is applied.' },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({
    accepted: rows.length,
    rejected: parsed.rejected,
    errors: parsed.errors,
  })
}
