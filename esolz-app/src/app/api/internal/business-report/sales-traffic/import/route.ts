import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseBusinessReportSalesTrafficCsv } from '@/lib/internal/business-report-sales-traffic-parser'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB
const TABLE = 'internal_business_report_sales_traffic_daily'
const BATCH_TABLE = 'internal_business_report_upload_batches'
const WRITE_CHUNK_SIZE = 500
const REJECTED_SAMPLE_LIMIT = 20

export async function POST(request: Request): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 5 MB limit.' }, { status: 400 })
  }
  if (!/\.csv$/i.test(file.name)) {
    return NextResponse.json({ error: 'Only .csv files are accepted.' }, { status: 400 })
  }

  const marketplaceId = (formData.get('marketplaceId') as string | null)?.trim() || 'unknown'

  let text: string
  try {
    text = await file.text()
  } catch {
    return NextResponse.json({ error: 'Could not read file.' }, { status: 400 })
  }

  const parsed = parseBusinessReportSalesTrafficCsv(text)
  const admin = createAdminClient()

  if (parsed.rows.length === 0) {
    await admin.from(BATCH_TABLE).insert({
      workspace_id: workspaceId,
      marketplace_id: marketplaceId,
      filename: file.name,
      status: 'failed',
      accepted_rows: 0,
      rejected_rows: parsed.rejected.length,
      error_summary: parsed.rejected[0]?.reason ?? 'No usable rows found.',
      completed_at: new Date().toISOString(),
    })
    return NextResponse.json({
      error: 'No usable rows found in this CSV.',
      rejectedRows: parsed.rejected.length,
      rejectedSample: parsed.rejected.slice(0, REJECTED_SAMPLE_LIMIT),
    }, { status: 400 })
  }

  const { data: batch, error: batchError } = await admin
    .from(BATCH_TABLE)
    .insert({
      workspace_id: workspaceId,
      marketplace_id: marketplaceId,
      filename: file.name,
      status: 'completed',
      accepted_rows: parsed.rows.length,
      rejected_rows: parsed.rejected.length,
      min_report_date: parsed.minReportDate,
      max_report_date: parsed.maxReportDate,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return NextResponse.json({ error: 'Failed to create upload batch.' }, { status: 500 })
  }

  const upsertRows = parsed.rows.map(row => ({
    workspace_id: workspaceId,
    marketplace_id: marketplaceId,
    report_date: row.reportDate,
    ordered_product_sales: row.orderedProductSales,
    ordered_product_sales_b2b: row.orderedProductSalesB2b,
    units_ordered: row.unitsOrdered,
    units_ordered_b2b: row.unitsOrderedB2b,
    total_order_items: row.totalOrderItems,
    total_order_items_b2b: row.totalOrderItemsB2b,
    average_sales_per_order_item: row.averageSalesPerOrderItem,
    average_sales_per_order_item_b2b: row.averageSalesPerOrderItemB2b,
    average_units_per_order_item: row.averageUnitsPerOrderItem,
    sessions: row.sessions,
    page_views: row.pageViews,
    buy_box_percentage: row.buyBoxPercentage,
    unit_session_percentage: row.unitSessionPercentage,
    source_filename: file.name,
    upload_batch_id: batch.id,
  }))

  // Re-uploading a corrected export for the same date(s) must update the
  // existing row, not create a duplicate or abort — upsert on the
  // (workspace_id, marketplace_id, report_date) unique key.
  for (let offset = 0; offset < upsertRows.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = upsertRows.slice(offset, offset + WRITE_CHUNK_SIZE)
    const { error: upsertError } = await admin
      .from(TABLE)
      .upsert(chunk, { onConflict: 'workspace_id,marketplace_id,report_date' })
    if (upsertError) {
      await admin.from(BATCH_TABLE).update({
        status: 'failed',
        error_summary: upsertError.message,
        completed_at: new Date().toISOString(),
      }).eq('id', batch.id)
      return NextResponse.json({ error: 'Failed to store rows.', detail: upsertError.message }, { status: 500 })
    }
  }

  await admin.from(BATCH_TABLE).update({ completed_at: new Date().toISOString() }).eq('id', batch.id)

  return NextResponse.json({
    batchId: batch.id,
    acceptedRows: parsed.rows.length,
    rejectedRows: parsed.rejected.length,
    minReportDate: parsed.minReportDate,
    maxReportDate: parsed.maxReportDate,
    latestReportDate: parsed.maxReportDate,
    rejectedSample: parsed.rejected.slice(0, REJECTED_SAMPLE_LIMIT),
  })
}
