import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { parseXhzuStockCsv } from '@/lib/internal/xhzu-stock-csv'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 5000
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'
const SOURCE = 'xhzu_manual_upload'
const TABLE = 'internal_inventory_by_location'
const WRITE_CHUNK_SIZE = 500

type NormalizedStockRow = {
  workspace_id: string
  marketplace_id: string
  asin: null
  sku: string
  location_code: string
  source: string
  available_quantity: number
  inbound_quantity: number
  reserved_quantity: number
  unsellable_quantity: number
  snapshot_at: string
}

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

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
    parsed = parseXhzuStockCsv(await file.text())
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'CSV could not be validated.' },
      { status: 400 },
    )
  }

  const parsedRowCount = parsed.rows.length + parsed.rejected

  if (parsed.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `CSV exceeds the ${MAX_ROWS.toLocaleString('en-US')} accepted-row limit.` },
      { status: 400 },
    )
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({
      written: false,
      parsedRows: parsedRowCount,
      acceptedRows: 0,
      rejectedRows: parsed.rejected,
      errors: parsed.errors,
      insertedCount: 0,
      updatedCount: 0,
    })
  }

  const snapshotAt = new Date().toISOString()
  const dedupedRows = new Map<string, NormalizedStockRow>()
  for (const row of parsed.rows) {
    const key = `${row.locationCode}|${row.skuNorm}`
    dedupedRows.set(key, {
      workspace_id: workspaceId,
      marketplace_id: DEFAULT_MARKETPLACE_ID,
      asin: null,
      sku: row.skuNorm,
      location_code: row.locationCode,
      source: SOURCE,
      available_quantity: row.availableQuantity,
      inbound_quantity: row.inboundQuantity,
      reserved_quantity: row.reservedQuantity,
      unsellable_quantity: 0,
      snapshot_at: snapshotAt,
    })
  }
  const rows = [...dedupedRows.values()]

  const admin = createAdminClient()

  // Existing rows from a prior XHZU upload are matched by (location_code, sku) and updated
  // in place by id, rather than relying on the table's snapshot-scoped unique index. This
  // avoids accumulating duplicate stock rows across re-uploads without requiring a migration.
  const { data: existingRows, error: existingError } = await admin
    .from(TABLE)
    .select('id, sku, location_code')
    .eq('workspace_id', workspaceId)
    .eq('marketplace_id', DEFAULT_MARKETPLACE_ID)
    .eq('source', SOURCE)

  if (existingError) {
    return NextResponse.json(
      { error: 'Existing XHZU stock rows could not be read.' },
      { status: 503 },
    )
  }

  const existingIdByKey = new Map<string, string>()
  for (const row of existingRows ?? []) {
    existingIdByKey.set(`${(row.location_code as string | null) ?? ''}|${(row.sku as string | null) ?? ''}`, row.id as string)
  }

  const insertRows: NormalizedStockRow[] = []
  const updateRows: (NormalizedStockRow & { id: string })[] = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(`${row.location_code}|${row.sku}`)
    if (existingId) {
      updateRows.push({ ...row, id: existingId })
    } else {
      insertRows.push(row)
    }
  }

  for (let index = 0; index < insertRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = insertRows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).insert(chunk)
    if (error) {
      return NextResponse.json({ error: 'New XHZU stock rows could not be saved.' }, { status: 503 })
    }
  }
  for (let index = 0; index < updateRows.length; index += WRITE_CHUNK_SIZE) {
    const chunk = updateRows.slice(index, index + WRITE_CHUNK_SIZE)
    const { error } = await admin.from(TABLE).upsert(chunk, { onConflict: 'id' })
    if (error) {
      return NextResponse.json({ error: 'Existing XHZU stock rows could not be updated.' }, { status: 503 })
    }
  }

  const { count: activeRowsAfterImport } = await admin
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source', SOURCE)

  const { data: distinctRowsData, error: distinctError } = await admin
    .from(TABLE)
    .select('sku, location_code')
    .eq('workspace_id', workspaceId)
    .eq('source', SOURCE)

  if (distinctError) {
    return NextResponse.json({ error: 'Updated XHZU stock rows could not be summarized.' }, { status: 503 })
  }

  const distinctSkus = new Set((distinctRowsData ?? []).map(row => row.sku as string)).size
  const distinctLocationCodes = new Set((distinctRowsData ?? []).map(row => row.location_code as string)).size

  return NextResponse.json({
    written: true,
    parsedRows: parsedRowCount,
    acceptedRows: rows.length,
    rejectedRows: parsed.rejected,
    errors: parsed.errors,
    insertedCount: insertRows.length,
    updatedCount: updateRows.length,
    activeRowsAfterImport: activeRowsAfterImport ?? 0,
    distinctSkus,
    distinctLocationCodes,
  })
}
