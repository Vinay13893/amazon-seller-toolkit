import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

function safeError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ success: false, errorCode, message }, { status })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function sanitizeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.replace(/https?:\/\/\S+/g, '[redacted_url]').slice(0, 180)
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
    .select('id, job_type, status, progress_current, progress_total, attempts, max_attempts, result_summary, error_code, error_message, locked_at, started_at, completed_at, created_at, updated_at')
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
    .select('asin, pincode, availability_status, delivery_message_category, delivery_message, price_detected, buy_box_detected, seller_name, checked_at, error_code, error_message')
    .eq('workspace_id', member.workspace_id)
    .eq('job_id', jobId)
    .order('checked_at', { ascending: false })
    .limit(200)

  if (resultsError) {
    return safeError(500, 'results_read_failed', 'Unable to read pincode availability results.')
  }

  return NextResponse.json({
    success: true,
    job: {
      id: job.id,
      jobType: job.job_type,
      status: job.status,
      progressCurrent: job.progress_current ?? 0,
      progressTotal: job.progress_total ?? 0,
      attempts: job.attempts ?? 0,
      maxAttempts: job.max_attempts ?? 0,
      resultSummary: job.result_summary ?? null,
      errorCode: job.error_code,
      errorMessage: sanitizeErrorMessage(job.error_message),
      lockedAtPresent: Boolean(job.locked_at),
      startedAtPresent: Boolean(job.started_at),
      completedAtPresent: Boolean(job.completed_at),
      startedAt: job.started_at,
      completedAt: job.completed_at,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    },
    results: (results ?? []).map(result => ({
      ...result,
      delivery_message: cleanDeliveryMessage(result.delivery_message),
    })),
  })
}

export async function DELETE(
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

  // TODO: replace manual clearing with scheduled retention for pincode results older than 7-30 days.
  const { error: deleteResultsError } = await admin
    .from('pincode_availability_results')
    .delete()
    .eq('workspace_id', member.workspace_id)
    .eq('job_id', jobId)

  if (deleteResultsError) {
    return safeError(500, 'results_clear_failed', 'Unable to clear pincode availability results.')
  }

  const { error: deleteJobError } = await admin
    .from('scraping_jobs')
    .delete()
    .eq('workspace_id', member.workspace_id)
    .eq('id', jobId)

  if (deleteJobError) {
    return safeError(500, 'job_clear_failed', 'Unable to clear pincode availability job.')
  }

  return NextResponse.json({
    success: true,
    jobId,
    cleared: true,
  })
}
