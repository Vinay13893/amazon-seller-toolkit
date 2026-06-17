import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 90

function safeError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ success: false, errorCode, message }, { status })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function safeWorkerStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const status = (value as { status?: unknown }).status
  return typeof status === 'string' ? status : null
}

export async function POST(
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
    .select('id, status')
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

  const workerUrl = process.env.CHECKER_WORKER_URL?.replace(/\/$/, '')
  const workerSecret = process.env.CHECKER_WORKER_SECRET

  if (!workerUrl || !workerSecret) {
    return safeError(503, 'worker_trigger_not_configured', 'Job queued. Worker trigger is not configured yet.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 80_000)

  try {
    const response = await fetch(`${workerUrl}/scraping/run-next`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-checker-secret': workerSecret,
      },
      body: JSON.stringify({ jobId }),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null)

    if (!response.ok) {
      return safeError(502, 'worker_trigger_failed', 'Buy Box worker trigger failed safely.')
    }

    return NextResponse.json({
      success: true,
      jobId,
      jobStatusBeforeTrigger: job.status,
      workerStatus: safeWorkerStatus(body),
      message: 'Worker trigger accepted.',
    })
  } catch {
    return safeError(502, 'worker_trigger_failed', 'Buy Box worker trigger failed safely.')
  } finally {
    clearTimeout(timer)
  }
}
