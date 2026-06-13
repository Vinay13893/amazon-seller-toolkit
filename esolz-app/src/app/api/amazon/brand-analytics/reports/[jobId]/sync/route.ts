import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import {
  type BrandAnalyticsReportType,
  downloadAmazonReportDocument,
  getAmazonReportDocument,
  parseBrandAnalyticsReport,
} from '@/lib/amazon/reports'

export const runtime = 'nodejs'
export const maxDuration = 60

function isOwnerOrAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

function pickValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) return null
    const parsed = Number.parseFloat(normalized)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

function toNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) return null
    if (normalized.endsWith('%')) {
      const pct = Number.parseFloat(normalized.slice(0, -1))
      return Number.isFinite(pct) ? pct / 100 : null
    }
    const parsed = Number.parseFloat(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    return await handlePost(params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Unexpected server error: ${message}` }, { status: 500 })
  }
}

async function handlePost(paramsPromise: Promise<{ jobId: string }>) {
  const { jobId } = await paramsPromise
  const supabase = await createClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  if (!isOwnerOrAdmin(member.role)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const admin = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job, error: jobErr } = await (admin as any)
    .from('amazon_report_jobs')
    .select('id, workspace_id, amazon_connection_id, report_type, report_id, report_document_id, marketplace_id, report_period, data_start_time, data_end_time, processing_status, requested_at, raw_summary')
    .eq('id', jobId)
    .maybeSingle()

  if (jobErr) {
    return NextResponse.json({ error: 'Failed to read report job' }, { status: 500 })
  }
  if (!job) {
    return NextResponse.json({ error: 'Report job not found' }, { status: 404 })
  }
  if (job.workspace_id !== member.workspace_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (job.processing_status !== 'DONE' || !job.report_document_id) {
    return NextResponse.json({ error: 'Report is not ready for sync yet' }, { status: 409 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: conn } = await (admin as any)
    .from('amazon_connections')
    .select('id, status, refresh_token_encrypted')
    .eq('id', job.amazon_connection_id)
    .maybeSingle()

  if (!conn || conn.status !== 'active' || !conn.refresh_token_encrypted) {
    return NextResponse.json({ error: 'Amazon connection unavailable' }, { status: 409 })
  }

  let accessToken = ''
  let expiresIn = 0
  try {
    const refreshToken = decryptToken(conn.refresh_token_encrypted as string)
    const refreshed = await refreshAccessToken(refreshToken)
    accessToken = refreshed.access_token
    expiresIn = refreshed.expires_in
  } catch {
    return NextResponse.json({ error: 'Failed to refresh Amazon access token' }, { status: 502 })
  }

  const now = new Date().toISOString()
  try {
    const enc = encryptToken(accessToken)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_connections')
      .update({
        access_token_encrypted: enc,
        access_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        updated_at: now,
      })
      .eq('id', conn.id)
  } catch {
    // non-fatal
  }

  let rawContent = ''
  try {
    const document = await getAmazonReportDocument(accessToken, job.report_document_id as string)
    rawContent = await downloadAmazonReportDocument(document)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_report_documents')
      .upsert({
        workspace_id: member.workspace_id,
        amazon_connection_id: job.amazon_connection_id,
        amazon_report_job_id: jobId,
        report_type: job.report_type,
        report_id: job.report_id,
        report_document_id: document.reportDocumentId,
        marketplace_id: job.marketplace_id,
        report_period: job.report_period,
        data_start_time: job.data_start_time,
        data_end_time: job.data_end_time,
        processing_status: 'DONE',
        requested_at: job.requested_at,
        completed_at: now,
        raw_summary: {
          document_compression: document.compressionAlgorithm ?? null,
          document_encrypted: !!document.encryptionDetails,
        },
        updated_at: now,
      }, { onConflict: 'workspace_id,report_document_id' })
  } catch {
    return NextResponse.json({ error: 'Failed to download report document' }, { status: 502 })
  }

  const parsed = parseBrandAnalyticsReport(
    job.report_type as BrandAnalyticsReportType,
    rawContent,
  )

  const reportType = job.report_type as BrandAnalyticsReportType
  const baseRow = {
    workspace_id: member.workspace_id,
    amazon_connection_id: job.amazon_connection_id,
    marketplace_id: (job.marketplace_id as string) ?? 'A21TJRUUN4KGV',
    report_id: job.report_id,
    report_document_id: job.report_document_id,
    report_period: job.report_period,
    data_start_time: job.data_start_time,
    data_end_time: job.data_end_time,
    updated_at: now,
  }

  let targetTable = ''
  let onConflict = ''
  let rowsToUpsert: Record<string, unknown>[] = []

  if (reportType === 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT') {
    targetTable = 'brand_analytics_search_query_rows'
    onConflict = 'workspace_id,report_id,search_query,asin'
    rowsToUpsert = parsed.rows.map((row) => ({
      ...baseRow,
      asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
      search_query: toText(pickValue(row, ['search_query', 'query', 'customer_search_term', 'search_term'])) ?? '',
      impressions: toInt(pickValue(row, ['impressions', 'search_query_impressions'])),
      clicks: toInt(pickValue(row, ['clicks', 'search_query_clicks'])),
      cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
      purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
      click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
      purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
      top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
      top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
      top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
      raw_row: row,
    }))
  } else if (reportType === 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT') {
    targetTable = 'brand_analytics_search_terms_rows'
    onConflict = 'workspace_id,report_id,search_term,asin'
    rowsToUpsert = parsed.rows.map((row) => ({
      ...baseRow,
      asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
      search_term: toText(pickValue(row, ['search_term', 'search_query', 'query'])) ?? '',
      impressions: toInt(pickValue(row, ['impressions', 'search_term_impressions'])),
      clicks: toInt(pickValue(row, ['clicks', 'search_term_clicks'])),
      cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
      purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
      click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
      purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
      top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
      top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
      top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
      raw_row: row,
    }))
  } else {
    targetTable = 'brand_analytics_search_catalog_rows'
    onConflict = 'workspace_id,report_id,asin,search_query'
    rowsToUpsert = parsed.rows.map((row) => ({
      ...baseRow,
      asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
      search_query: toText(pickValue(row, ['search_query', 'query', 'search_term'])) ?? '',
      impressions: toInt(pickValue(row, ['impressions'])),
      clicks: toInt(pickValue(row, ['clicks'])),
      cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
      purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
      click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
      purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
      top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
      top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
      top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
      raw_row: row,
    }))
  }

  if (rowsToUpsert.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertErr } = await (admin as any)
      .from(targetTable)
      .upsert(rowsToUpsert, { onConflict })

    if (upsertErr) {
      return NextResponse.json({ error: 'Failed to store parsed report rows' }, { status: 500 })
    }
  }

  const mergedSummary = {
    ...(job.raw_summary ?? {}),
    synced_at: now,
    parse_format: parsed.format,
    parsed_row_count: parsed.rows.length,
    parsed_field_names: parsed.fieldNames,
    target_table: targetTable,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_report_jobs')
    .update({
      processing_status: 'DONE',
      completed_at: now,
      raw_summary: mergedSummary,
      updated_at: now,
    })
    .eq('id', jobId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_report_documents')
    .update({
      processing_status: 'DONE',
      completed_at: now,
      raw_summary: mergedSummary,
      updated_at: now,
    })
    .eq('workspace_id', member.workspace_id)
    .eq('report_document_id', job.report_document_id)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_audit_logs')
    .insert({
      workspace_id: member.workspace_id,
      user_id: user.id,
      event_type: 'brand_analytics_report_synced',
      details: {
        job_id: jobId,
        report_id: job.report_id,
        report_type: reportType,
        target_table: targetTable,
        row_count: parsed.rows.length,
      },
    })

  return NextResponse.json({
    ok: true,
    jobId,
    reportId: job.report_id,
    processingStatus: 'DONE',
    rowCount: parsed.rows.length,
    fieldNames: parsed.fieldNames,
    targetTable,
  })
}
