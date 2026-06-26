import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseSellerCentralSalesCsv } from '@/lib/internal/seller-central-sales-csv'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB
const MAX_ACCEPTED_ROWS = 5000

function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export async function POST(request: Request): Promise<Response> {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

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
    return NextResponse.json({ error: 'File exceeds 2 MB limit.' }, { status: 400 })
  }

  // Optional: report period from form data
  const reportStartDateRaw = (formData.get('reportStartDate') as string | null)?.trim() ?? null
  const reportEndDateRaw = (formData.get('reportEndDate') as string | null)?.trim() ?? null
  const periodLabelRaw = (formData.get('periodLabel') as string | null)?.trim() ?? null
  const marketplaceId = (formData.get('marketplaceId') as string | null)?.trim() ?? null

  const reportStartDate = reportStartDateRaw && isValidDateString(reportStartDateRaw)
    ? reportStartDateRaw
    : null
  const reportEndDate = reportEndDateRaw && isValidDateString(reportEndDateRaw)
    ? reportEndDateRaw
    : null

  let text: string
  try {
    text = await file.text()
  } catch {
    return NextResponse.json({ error: 'Could not read file.' }, { status: 400 })
  }

  let parsed: Awaited<ReturnType<typeof parseSellerCentralSalesCsv>>
  try {
    parsed = parseSellerCentralSalesCsv(text)
  } catch (parseError) {
    return NextResponse.json(
      { error: parseError instanceof Error ? parseError.message : 'CSV parse error.' },
      { status: 400 },
    )
  }

  if (parsed.rows.length === 0 && parsed.rejected === 0) {
    return NextResponse.json({ error: 'CSV contains no data rows.' }, { status: 400 })
  }

  const acceptedRows = parsed.rows.slice(0, MAX_ACCEPTED_ROWS)
  const rejectedDueToLimit = parsed.rows.length - acceptedRows.length

  const supabase = createAdminClient()

  // Mark all existing batches as inactive
  await supabase
    .from('seller_central_sales_upload_batches')
    .update({ is_active: false })
    .eq('workspace_id', access.workspaceId)

  const { data: batch, error: batchError } = await supabase
    .from('seller_central_sales_upload_batches')
    .insert({
      workspace_id: access.workspaceId,
      marketplace_id: marketplaceId,
      uploaded_by: null, // internal tool; no per-user tracking needed
      original_filename: file.name,
      report_start_date: reportStartDate,
      report_end_date: reportEndDate,
      period_label: periodLabelRaw ?? (reportStartDate && reportEndDate ? `${reportStartDate} to ${reportEndDate}` : null),
      row_count: parsed.rows.length,
      accepted_count: acceptedRows.length,
      rejected_count: parsed.rejected + rejectedDueToLimit,
      is_active: true,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return NextResponse.json({ error: 'Failed to create upload batch.' }, { status: 500 })
  }

  if (acceptedRows.length > 0) {
    const insertRows = acceptedRows.map(row => ({
      batch_id: batch.id,
      workspace_id: access.workspaceId,
      marketplace_id: marketplaceId,
      amazon_sku: row.amazonSku,
      amazon_sku_norm: row.amazonSkuNorm,
      asin: row.asin,
      title: row.title,
      units_sold: row.unitsSold,
    }))

    const CHUNK = 500
    for (let offset = 0; offset < insertRows.length; offset += CHUNK) {
      const { error: insertError } = await supabase
        .from('seller_central_sales_rows')
        .insert(insertRows.slice(offset, offset + CHUNK))
      if (insertError) {
        return NextResponse.json({ error: 'Failed to store upload rows.' }, { status: 500 })
      }
    }
  }

  return NextResponse.json({
    accepted: acceptedRows.length,
    rejected: parsed.rejected + rejectedDueToLimit,
    batchId: batch.id,
    reportStartDate,
    reportEndDate,
    errors: parsed.errors,
  })
}
