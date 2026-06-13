import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decryptToken, encryptToken } from '@/lib/amazon/crypto'
import { refreshAccessToken } from '@/lib/amazon/lwa'
import {
  BRAND_ANALYTICS_REPORT_TYPES,
  type BrandAnalyticsReportType,
  createAmazonReport,
} from '@/lib/amazon/reports'

export const runtime = 'nodejs'
export const maxDuration = 30

const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

interface RequestBody {
  reportType?: BrandAnalyticsReportType
  marketplaceId?: string
  reportPeriod?: string
  dataStartTime?: string
  dataEndTime?: string
  asin?: string
}

function completedWeekWindowUtc(): { start: string; end: string } {
  const now = new Date()
  const day = now.getUTCDay() // 0 Sunday
  const daysSinceWeekStart = (day + 6) % 7

  const currentWeekStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceWeekStart,
    0, 0, 0, 0,
  ))

  const prevWeekStart = new Date(currentWeekStart)
  prevWeekStart.setUTCDate(currentWeekStart.getUTCDate() - 7)

  const prevWeekEnd = new Date(currentWeekStart)
  prevWeekEnd.setUTCSeconds(prevWeekEnd.getUTCSeconds() - 1)

  return {
    start: prevWeekStart.toISOString(),
    end: prevWeekEnd.toISOString(),
  }
}

function isOwnerOrAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Unexpected server error: ${message}` }, { status: 500 })
  }
}

async function handlePost(req: NextRequest) {
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

  let body: RequestBody = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const reportType = body.reportType
  if (!reportType || !BRAND_ANALYTICS_REPORT_TYPES.includes(reportType)) {
    return NextResponse.json({ error: 'Invalid reportType' }, { status: 400 })
  }

  const marketplaceId = body.marketplaceId?.trim() || DEFAULT_MARKETPLACE_ID
  const reportPeriod = body.reportPeriod?.trim() || 'WEEK'
  const asin = body.asin?.trim().toUpperCase()
  const weekWindow = completedWeekWindowUtc()
  const dataStartTime = body.dataStartTime ?? weekWindow.start
  const dataEndTime = body.dataEndTime ?? weekWindow.end

  const admin = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: conn, error: connErr } = await (admin as any)
    .from('amazon_connections')
    .select('id, workspace_id, status, marketplace_id, refresh_token_encrypted')
    .eq('workspace_id', member.workspace_id)
    .maybeSingle()

  if (connErr) {
    return NextResponse.json({ error: 'Database error while loading Amazon connection' }, { status: 500 })
  }
  if (!conn || conn.status !== 'active' || !conn.refresh_token_encrypted) {
    return NextResponse.json({ error: 'Active Amazon seller connection required' }, { status: 409 })
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

  let reportId = ''
  try {
    const reportOptions = asin ? { asin } : undefined
    const response = await createAmazonReport(accessToken, {
      reportType,
      marketplaceIds: [marketplaceId],
      dataStartTime,
      dataEndTime,
      reportOptions,
    })
    reportId = response.reportId
  } catch (err) {
    const message = err instanceof Error ? err.message : 'sp_api_create_report_failed'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('amazon_audit_logs').insert({
      workspace_id: member.workspace_id,
      user_id: user.id,
      event_type: 'brand_analytics_report_request_failed',
      details: {
        report_type: reportType,
        marketplace_id: marketplaceId,
        reason: message,
      },
    })
    return NextResponse.json({ error: 'Amazon report request failed' }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job, error: jobErr } = await (admin as any)
    .from('amazon_report_jobs')
    .insert({
      workspace_id: member.workspace_id,
      amazon_connection_id: conn.id,
      report_type: reportType,
      report_id: reportId,
      marketplace_id: marketplaceId,
      report_period: reportPeriod,
      data_start_time: dataStartTime,
      data_end_time: dataEndTime,
      processing_status: 'IN_QUEUE',
      requested_at: now,
      raw_summary: {
        source: 'spapi_create_report',
        asin: asin ?? null,
      },
      updated_at: now,
    })
    .select('id')
    .single()

  if (jobErr || !job?.id) {
    return NextResponse.json({ error: 'Failed to create report job row' }, { status: 500 })
  }

  // Mark BA capability as available once createReport is accepted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('amazon_connections')
    .update({
      brand_analytics_eligible: true,
      last_sync_at: now,
      updated_at: now,
      error_message: null,
    })
    .eq('id', conn.id)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('amazon_audit_logs').insert({
    workspace_id: member.workspace_id,
    user_id: user.id,
    event_type: 'brand_analytics_report_requested',
    details: {
      job_id: job.id,
      report_id: reportId,
      report_type: reportType,
      marketplace_id: marketplaceId,
      report_period: reportPeriod,
      data_start_time: dataStartTime,
      data_end_time: dataEndTime,
    },
  })

  return NextResponse.json({
    ok: true,
    jobId: job.id as string,
    reportId,
    processingStatus: 'IN_QUEUE',
  })
}
