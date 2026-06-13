import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import { getAmazonReport } from '@/lib/amazon/reports'

export const runtime = 'nodejs'
export const maxDuration = 25

function doneStatus(status: string): boolean {
  return status === 'DONE' || status === 'CANCELLED' || status === 'FATAL'
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    return await handleGet(params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Unexpected server error: ${message}` }, { status: 500 })
  }
}

async function handleGet(paramsPromise: Promise<{ jobId: string }>) {
  const { jobId } = await paramsPromise
  const supabase = await createClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job, error: jobErr } = await (admin as any)
    .from('amazon_report_jobs')
    .select('id, workspace_id, amazon_connection_id, report_type, report_id, report_document_id, marketplace_id, processing_status, report_period, data_start_time, data_end_time, requested_at, completed_at, error_code, error_message, raw_summary')
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

  if (!job.report_id) {
    return NextResponse.json({
      jobId,
      reportId: null,
      reportType: job.report_type,
      processingStatus: job.processing_status,
      reportDocumentId: job.report_document_id,
      canSync: false,
      errorCode: job.error_code,
      errorMessage: job.error_message,
      completedAt: job.completed_at,
    })
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

  let polled: Awaited<ReturnType<typeof getAmazonReport>>
  try {
    polled = await getAmazonReport(accessToken, job.report_id as string)
  } catch {
    return NextResponse.json({ error: 'Failed to poll Amazon report status' }, { status: 502 })
  }

  const mergedSummary = {
    ...(job.raw_summary ?? {}),
    latest_poll_at: now,
    report_type: polled.reportType,
    created_time: polled.createdTime ?? null,
    processing_start_time: polled.processingStartTime ?? null,
    processing_end_time: polled.processingEndTime ?? null,
  }

  const completedAt = doneStatus(polled.processingStatus)
    ? (polled.processingEndTime ?? now)
    : null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_report_jobs')
    .update({
      processing_status: polled.processingStatus,
      report_document_id: polled.reportDocumentId ?? job.report_document_id,
      data_start_time: polled.dataStartTime ?? job.data_start_time,
      data_end_time: polled.dataEndTime ?? job.data_end_time,
      completed_at: completedAt,
      error_code: polled.processingStatus === 'FATAL' ? 'FATAL' : null,
      error_message: polled.processingStatus === 'FATAL' ? 'Amazon reported FATAL processing status' : null,
      raw_summary: mergedSummary,
      updated_at: now,
    })
    .eq('id', jobId)

  if (polled.reportDocumentId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_report_documents')
      .upsert({
        workspace_id: member.workspace_id,
        amazon_connection_id: job.amazon_connection_id,
        amazon_report_job_id: jobId,
        report_type: polled.reportType,
        report_id: polled.reportId,
        report_document_id: polled.reportDocumentId,
        marketplace_id: job.marketplace_id ?? 'A21TJRUUN4KGV',
        report_period: job.report_period,
        data_start_time: polled.dataStartTime ?? job.data_start_time,
        data_end_time: polled.dataEndTime ?? job.data_end_time,
        processing_status: polled.processingStatus,
        requested_at: job.requested_at,
        completed_at: completedAt,
        error_code: polled.processingStatus === 'FATAL' ? 'FATAL' : null,
        error_message: polled.processingStatus === 'FATAL' ? 'Amazon reported FATAL processing status' : null,
        raw_summary: mergedSummary,
        updated_at: now,
      }, { onConflict: 'workspace_id,report_document_id' })
  }

  return NextResponse.json({
    jobId,
    reportId: polled.reportId,
    reportType: polled.reportType,
    processingStatus: polled.processingStatus,
    reportDocumentId: polled.reportDocumentId ?? null,
    dataStartTime: polled.dataStartTime ?? job.data_start_time,
    dataEndTime: polled.dataEndTime ?? job.data_end_time,
    canSync: polled.processingStatus === 'DONE' && !!polled.reportDocumentId,
    completedAt,
  })
}
