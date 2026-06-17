import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const JOB_TYPE = 'BUY_BOX_CHECK'
const MAX_ASINS = 10
const DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'

type RequestBody = {
  marketplaceId?: unknown
  asins?: unknown
}

function safeError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ success: false, errorCode, message }, { status })
}

function normalizeAsins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map(item => typeof item === 'string' ? item.trim().toUpperCase() : '')
      .filter(item => /^[A-Z0-9]{10}$/.test(item)),
  ))
}

export async function POST(req: Request) {
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

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return safeError(400, 'invalid_json', 'Invalid JSON request body.')
  }

  const asins = normalizeAsins(body.asins)
  const marketplaceId = typeof body.marketplaceId === 'string' && body.marketplaceId.trim()
    ? body.marketplaceId.trim()
    : DEFAULT_MARKETPLACE_ID

  if (asins.length === 0) {
    return safeError(400, 'invalid_asins', 'Provide 1 to 10 valid ASINs.')
  }

  if (asins.length > MAX_ASINS) {
    return safeError(400, 'too_many_asins', 'Provide 10 ASINs or fewer.')
  }

  const admin = createAdminClient()
  const { data: job, error: insertError } = await admin
    .from('scraping_jobs')
    .insert({
      workspace_id: member.workspace_id,
      job_type: JOB_TYPE,
      status: 'queued',
      payload: {
        marketplaceId,
        asins,
      },
      progress_current: 0,
      progress_total: asins.length,
      created_by: user.id,
    })
    .select('id, job_type, status, progress_current, progress_total, created_at')
    .single()

  if (insertError || !job) {
    return safeError(500, 'job_create_failed', 'Unable to create Buy Box check job.')
  }

  return NextResponse.json({
    success: true,
    job: {
      id: job.id,
      jobType: job.job_type,
      status: job.status,
      progressCurrent: job.progress_current,
      progressTotal: job.progress_total,
      createdAt: job.created_at,
    },
  }, { status: 201 })
}
