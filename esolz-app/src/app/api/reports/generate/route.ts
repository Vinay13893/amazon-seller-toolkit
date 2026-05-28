import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  generateReportData,
  toCsv,
  type ReportType,
} from '@/lib/reports/generate-report-data'

export const runtime     = 'nodejs'
export const maxDuration = 30

const REPORT_NAMES: Record<ReportType, string> = {
  'asin-performance':    'ASIN Performance',
  'bsr-movement':        'BSR Movement',
  'pincode-availability': 'Pincode Availability',
  'buybox-health':       'Buy Box Health',
  'keyword-ranking':     'Keyword Ranking',
  'alerts-summary':      'Alerts Summary',
}

const VALID_TYPES = new Set<ReportType>([
  'asin-performance', 'bsr-movement', 'pincode-availability',
  'buybox-health', 'keyword-ranking', 'alerts-summary',
])

/**
 * POST /api/reports/generate
 *
 * Body: { reportType: ReportType, fileType?: 'csv' }
 *
 * Generates a CSV report from real Supabase data, saves metadata to
 * the `reports` table, increments `usage_counters.reports_generated`,
 * and returns the CSV as a downloadable file.
 */
export async function POST(req: NextRequest) {
  console.log('[reports-generate][1] POST /api/reports/generate called')

  const supabase = await createClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    console.error('[reports-generate][2] FAIL auth:', authErr?.message ?? 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[reports-generate][2] OK   user: ${user.id}`)

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    console.error('[reports-generate][3] FAIL workspace:', memberErr?.message ?? 'no row')
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id
  console.log(`[reports-generate][3] OK   workspace: ${workspaceId}`)

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { reportType?: string; fileType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const reportType = body.reportType as ReportType | undefined
  if (!reportType || !VALID_TYPES.has(reportType)) {
    return NextResponse.json(
      { error: `Invalid reportType. Valid values: ${[...VALID_TYPES].join(', ')}` },
      { status: 400 },
    )
  }
  console.log(`[reports-generate][4] reportType=${reportType}`)

  // ── Generate data ─────────────────────────────────────────────────────────
  let csv = ''
  let reportName = REPORT_NAMES[reportType]
  try {
    const data = await generateReportData(workspaceId, reportType)
    reportName = data.reportName
    csv = toCsv(data.headers, data.rows)
    console.log(`[reports-generate][5] OK   rows=${data.rows.length}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[reports-generate][5] FAIL generate:', msg)
    return NextResponse.json({ error: 'Report generation failed' }, { status: 500 })
  }

  // ── Save report metadata ──────────────────────────────────────────────────
  const admin = createAdminClient()
  const dateStr = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
  })
  const fullReportName = `${reportName} — ${dateStr}`

  const { error: insertErr } = await admin.from('reports').insert({
    workspace_id: workspaceId,
    report_name:  fullReportName,
    report_type:  reportType,
    status:       'ready',
    file_type:    'csv',
    file_url:     null,
    created_by:   user.id,
  })

  if (insertErr) {
    console.error('[reports-generate][6] WARN save metadata:', insertErr.message)
    // Non-fatal: still return CSV
  } else {
    console.log('[reports-generate][6] OK   metadata saved')
  }

  // ── Increment reports_generated ───────────────────────────────────────────
  try {
    const { data: uc } = await admin
      .from('usage_counters')
      .select('id, reports_generated')
      .eq('workspace_id', workspaceId)
      .order('period_start', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (uc?.id) {
      await admin
        .from('usage_counters')
        .update({ reports_generated: (uc.reports_generated ?? 0) + 1 })
        .eq('id', uc.id)
      console.log('[reports-generate][7] OK   usage incremented')
    }
  } catch (e) {
    console.error('[reports-generate][7] WARN usage increment failed:', e)
  }

  // ── Return CSV ────────────────────────────────────────────────────────────
  const safeFilename = `${reportType}-${new Date().toISOString().slice(0, 10)}.csv`
  console.log(`[reports-generate][8] OK   returning CSV filename=${safeFilename}`)

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
    },
  })
}
