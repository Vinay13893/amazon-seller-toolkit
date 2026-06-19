import { NextResponse } from 'next/server'
import { decryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import {
  createAmazonReport,
  downloadAmazonReportDocument,
  getAmazonReport,
  getAmazonReportDocument,
  parseAmazonReportDocument,
} from '@/lib/amazon/reports'
import { getInternalAccessContext } from '@/lib/internal-access'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const REPORT_TYPE = 'GET_LEDGER_DETAIL_VIEW_DATA'
const MAX_LOOKBACK_DAYS = 365
const DEFAULT_LOOKBACK_DAYS = 30
const INSERT_CHUNK_SIZE = 500

type RequestBody = {
  action?: unknown
  jobId?: unknown
  days?: unknown
}

function pickValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function toText(value: unknown, maxLength = 300): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text ? text.slice(0, maxLength) : null
}

function toInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/,/g, '').trim())
      : Number.NaN
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

function toDate(value: unknown): string | null {
  const text = toText(value, 40)
  if (!text) return null
  const parsed = new Date(text)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null
}

async function freshAccessToken(encryptedRefreshToken: string): Promise<string> {
  const refreshed = await refreshAccessToken(decryptToken(encryptedRefreshToken))
  return refreshed.access_token
}

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({})) as RequestBody
  const action = body.action === 'continue' ? 'continue' : 'start'
  const admin = createAdminClient()

  const { data: connection } = await admin
    .from('amazon_connections')
    .select('id, status, marketplace_id, refresh_token_encrypted')
    .eq('workspace_id', access.workspaceId)
    .maybeSingle()

  if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
    return NextResponse.json({ error: 'An active Amazon connection is required.' }, { status: 409 })
  }

  let accessToken: string
  try {
    accessToken = await freshAccessToken(connection.refresh_token_encrypted)
  } catch {
    return NextResponse.json({ error: 'Amazon connection could not be refreshed.' }, { status: 502 })
  }

  const marketplaceId = connection.marketplace_id ?? 'A21TJRUUN4KGV'
  const now = new Date().toISOString()

  if (action === 'start') {
    const requestedDays = Math.trunc(Number(body.days ?? DEFAULT_LOOKBACK_DAYS))
    const days = Math.min(
      MAX_LOOKBACK_DAYS,
      Math.max(1, Number.isFinite(requestedDays) ? requestedDays : DEFAULT_LOOKBACK_DAYS),
    )
    const endTime = new Date()
    const startTime = new Date(endTime)
    startTime.setUTCDate(startTime.getUTCDate() - days)

    let reportId: string
    try {
      const result = await createAmazonReport(accessToken, {
        reportType: REPORT_TYPE,
        marketplaceIds: [marketplaceId],
        dataStartTime: startTime.toISOString(),
        dataEndTime: endTime.toISOString(),
      })
      reportId = result.reportId
    } catch {
      return NextResponse.json({ error: 'Amazon fulfillment report request failed.' }, { status: 502 })
    }

    const { data: job, error } = await admin
      .from('internal_fba_report_jobs')
      .insert({
        workspace_id: access.workspaceId,
        amazon_connection_id: connection.id,
        report_type: REPORT_TYPE,
        report_id: reportId,
        marketplace_id: marketplaceId,
        data_start_time: startTime.toISOString(),
        data_end_time: endTime.toISOString(),
        processing_status: 'IN_QUEUE',
        requested_at: now,
      })
      .select('id')
      .single()

    if (error || !job) {
      return NextResponse.json({ error: 'Fulfillment report job could not be stored.' }, { status: 500 })
    }

    return NextResponse.json({
      jobId: job.id,
      reportType: REPORT_TYPE,
      processingStatus: 'IN_QUEUE',
      storedRows: 0,
      fcFieldAvailable: null,
    })
  }

  if (typeof body.jobId !== 'string' || !body.jobId) {
    return NextResponse.json({ error: 'Fulfillment report job is required.' }, { status: 400 })
  }

  const { data: job } = await admin
    .from('internal_fba_report_jobs')
    .select('id, report_id, report_document_id, report_type, marketplace_id, processing_status, completed_at, stored_row_count, fc_field_available')
    .eq('id', body.jobId)
    .eq('workspace_id', access.workspaceId)
    .maybeSingle()

  if (!job || !job.report_id) {
    return NextResponse.json({ error: 'Fulfillment report job was not found.' }, { status: 404 })
  }

  if (job.processing_status === 'DONE' && job.report_document_id) {
    return NextResponse.json({
      jobId: job.id,
      reportType: job.report_type,
      processingStatus: 'DONE',
      storedRows: job.stored_row_count ?? 0,
      fcFieldAvailable: job.fc_field_available ?? false,
      completedAt: job.completed_at,
    })
  }

  let polled
  try {
    polled = await getAmazonReport(accessToken, job.report_id)
  } catch {
    return NextResponse.json({ error: 'Amazon fulfillment report status is unavailable.' }, { status: 502 })
  }

  if (polled.processingStatus !== 'DONE' || !polled.reportDocumentId) {
    const terminalFailure = polled.processingStatus === 'FATAL' || polled.processingStatus === 'CANCELLED'
    await admin
      .from('internal_fba_report_jobs')
      .update({
        processing_status: polled.processingStatus,
        report_document_id: polled.reportDocumentId ?? null,
        completed_at: terminalFailure ? now : null,
        error_code: terminalFailure ? polled.processingStatus : null,
        error_message: terminalFailure ? 'Amazon could not generate the fulfillment report.' : null,
      })
      .eq('id', job.id)

    return NextResponse.json({
      jobId: job.id,
      reportType: job.report_type,
      processingStatus: polled.processingStatus,
      storedRows: 0,
      fcFieldAvailable: null,
    })
  }

  let parsed
  try {
    const document = await getAmazonReportDocument(accessToken, polled.reportDocumentId)
    const content = await downloadAmazonReportDocument(document)
    parsed = parseAmazonReportDocument(content)
  } catch {
    return NextResponse.json({ error: 'Fulfillment report document could not be processed.' }, { status: 502 })
  }

  const normalizedRows = parsed.rows.map(row => {
    const fulfillmentCenterId = toText(pickValue(row, [
      'fulfillment_center',
      'fulfillment_center_id',
      'fulfillment_center_code',
      'location',
      'warehouse',
    ]), 100)

    return {
      workspace_id: access.workspaceId,
      report_job_id: job.id,
      marketplace_id: job.marketplace_id,
      asin: toText(pickValue(row, ['asin']), 20),
      sku: toText(pickValue(row, ['msku', 'sku', 'seller_sku']), 200),
      fnsku: toText(pickValue(row, ['fnsku', 'fulfillment_network_sku']), 100),
      fulfillment_center_id: fulfillmentCenterId,
      disposition: toText(pickValue(row, ['disposition']), 100),
      event_type: toText(pickValue(row, ['event_type', 'event']), 100),
      quantity: toInt(pickValue(row, ['quantity', 'quantity_units'])),
      running_balance: toInt(pickValue(row, ['running_balance', 'ending_balance', 'balance'])),
      report_date: toDate(pickValue(row, ['date', 'report_date', 'snapshot_date'])),
      report_type: job.report_type,
      report_document_id: polled.reportDocumentId,
      source: 'fulfillment_report',
    }
  }).filter(row => row.asin || row.sku || row.fnsku)
  const dedupedRows = new Map<string, (typeof normalizedRows)[number]>()
  for (const row of normalizedRows) {
    const rowKey = [
      row.asin ?? '',
      row.sku ?? '',
      row.fnsku ?? '',
      row.fulfillment_center_id ?? '',
      row.disposition ?? '',
      row.event_type ?? '',
      row.report_date ?? '',
      row.quantity ?? 0,
      row.running_balance ?? 0,
    ].join('|')
    dedupedRows.set(rowKey, row)
  }
  const structuredRows = [...dedupedRows.values()]

  const fcFieldAvailable = structuredRows.some(row => Boolean(row.fulfillment_center_id))

  // Each sync requests a brand-new Amazon report, so it always gets a brand-new
  // report_document_id — deleting only that id is a no-op and previously stored
  // rows from earlier syncs would otherwise accumulate forever. internal_fba_report_rows
  // represents the latest synced snapshot for this report type, so replace it in full.
  await admin
    .from('internal_fba_report_rows')
    .delete()
    .eq('workspace_id', access.workspaceId)
    .eq('marketplace_id', job.marketplace_id)
    .eq('report_type', job.report_type)

  for (let index = 0; index < structuredRows.length; index += INSERT_CHUNK_SIZE) {
    const { error } = await admin
      .from('internal_fba_report_rows')
      .insert(structuredRows.slice(index, index + INSERT_CHUNK_SIZE))
    if (error) {
      return NextResponse.json({ error: 'Structured fulfillment rows could not be stored.' }, { status: 500 })
    }
  }

  await admin
    .from('internal_fba_report_jobs')
    .update({
      report_document_id: polled.reportDocumentId,
      processing_status: 'DONE',
      completed_at: now,
      stored_row_count: structuredRows.length,
      fc_field_available: fcFieldAvailable,
      error_code: null,
      error_message: null,
    })
    .eq('id', job.id)

  return NextResponse.json({
    jobId: job.id,
    reportType: job.report_type,
    processingStatus: 'DONE',
    storedRows: structuredRows.length,
    fcFieldAvailable,
    completedAt: now,
  })
}
