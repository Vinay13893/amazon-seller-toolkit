import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const CSV_COLUMNS = [
  'ASIN',
  'Pincode',
  'Availability Status',
  'Delivery Message',
  'Price Detected',
  'Buy Box Detected',
  'Seller Name',
  'Reason / Error Code',
  'Checked At',
]

function safeError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ success: false, errorCode, message }, { status })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function cleanDeliveryMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return null

  const segments = compact
    .replace(/\{[^{}]*\}/g, ' | ')
    .split(/\s+\|\s+| • | \u2022 |(?<=\.)\s+(?=[A-Z])/)
    .map(segment => segment.trim())
    .filter(Boolean)
    .filter(segment => !segment.startsWith('{') && !segment.startsWith('['))
    .filter(segment => !/"?[A-Za-z0-9_]+"?\s*:/.test(segment))
    .filter(segment => !segment.includes('isInternal') && !segment.includes('showInsightsHub'))

  const unique = Array.from(new Set(segments))
  const cleaned = unique.join(' | ').replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, 240) : null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params

  if (!isUuid(jobId)) {
    return safeError(400, 'invalid_job_id', 'Invalid scraping job id.')
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
    .maybeSingle()

  if (jobError) {
    return safeError(500, 'job_read_failed', 'Unable to read pincode availability job.')
  }

  if (!job) {
    return safeError(404, 'job_not_found', 'Pincode availability job was not found.')
  }

  const { data: results, error: resultsError } = await admin
    .from('pincode_availability_results')
    .select('asin, pincode, availability_status, delivery_message, price_detected, buy_box_detected, seller_name, checked_at, error_code')
    .eq('workspace_id', member.workspace_id)
    .eq('job_id', jobId)
    .order('checked_at', { ascending: false })
    .limit(5000)

  if (resultsError) {
    return safeError(500, 'results_read_failed', 'Unable to export pincode availability results.')
  }

  const rows = (results ?? []).map(result => [
    result.asin,
    result.pincode,
    result.availability_status,
    cleanDeliveryMessage(result.delivery_message),
    result.price_detected ? 'Yes' : 'No',
    result.buy_box_detected ? 'Yes' : 'No',
    result.seller_name,
    result.error_code,
    result.checked_at,
  ].map(csvCell).join(','))

  const csv = [
    CSV_COLUMNS.map(csvCell).join(','),
    ...rows,
  ].join('\n')

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="pincode-availability-${jobId.slice(0, 8)}.csv"`,
    },
  })
}
