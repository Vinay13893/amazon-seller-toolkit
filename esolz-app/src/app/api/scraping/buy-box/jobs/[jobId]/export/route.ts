import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const CSV_COLUMNS = [
  'ASIN',
  'Buy Box Detected',
  'Price',
  'Seller',
  'Availability',
  'Reason',
  'Checked At',
]

function safeError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ success: false, errorCode, message }, { status })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function cleanPipeSeparatedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = Array.from(new Set(
    value
      .split('|')
      .map(part => part.trim())
      .filter(Boolean),
  )).join(' | ')
  return cleaned || null
}

function formatPrice(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/[₹$€£]/.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return `₹${Number(trimmed).toLocaleString('en-IN')}`
  }
  return trimmed
}

function reasonLabel(errorCode: string | null, pageStatus: string | null): string {
  if (errorCode) return errorCode
  if (pageStatus === 'blocked') return 'blocked_or_captcha'
  return 'No issue reported'
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params

  if (!isUuid(jobId)) {
    return safeError(400, 'invalid_job_id', 'Invalid Buy Box job id.')
  }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return safeError(401, 'unauthorized', 'Unauthorized')
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberError || !member?.workspace_id) {
    return safeError(404, 'workspace_not_found', 'No workspace found for authenticated user.')
  }

  const admin = createAdminClient()
  const { data: job, error: jobError } = await admin
    .from('scraping_jobs')
    .select('id')
    .eq('id', jobId)
    .eq('workspace_id', member.workspace_id)
    .eq('job_type', 'BUY_BOX_CHECK')
    .maybeSingle()

  if (jobError) {
    return safeError(500, 'job_read_failed', 'Unable to read Buy Box job.')
  }

  if (!job) {
    return safeError(404, 'job_not_found', 'Buy Box job was not found.')
  }

  const { data: results, error: resultsError } = await admin
    .from('buy_box_results')
    .select('asin, buy_box_detected, price_text, seller_name, availability_status, page_status, error_code, checked_at')
    .eq('workspace_id', member.workspace_id)
    .eq('job_id', jobId)
    .order('checked_at', { ascending: false })
    .limit(5000)

  if (resultsError) {
    return safeError(500, 'results_read_failed', 'Unable to export Buy Box results.')
  }

  const rows = (results ?? []).map(result => [
    result.asin,
    result.buy_box_detected ? 'Yes' : 'No',
    formatPrice(result.price_text),
    cleanPipeSeparatedText(result.seller_name),
    result.availability_status,
    reasonLabel(result.error_code, result.page_status),
    result.checked_at,
  ].map(csvCell).join(','))

  const csv = [
    CSV_COLUMNS.map(csvCell).join(','),
    ...rows,
  ].join('\n')

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="buy-box-${jobId.slice(0, 8)}.csv"`,
    },
  })
}
