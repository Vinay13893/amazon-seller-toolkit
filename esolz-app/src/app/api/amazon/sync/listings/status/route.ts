import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime     = 'nodejs'
export const maxDuration = 10

/**
 * GET /api/amazon/sync/listings/status?job_id=...
 *
 * Returns safe progress fields only — no tokens, no raw data.
 */
export async function GET(req: NextRequest) {
  try {
    return await handleGet(req)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function handleGet(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const jobId = req.nextUrl.searchParams.get('job_id')
  if (!jobId) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job } = await (admin as any)
    .from('amazon_sync_jobs')
    .select('id, workspace_id, status, error_message, started_at, finished_at, metadata')
    .eq('id', jobId)
    .maybeSingle()

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  if (job.workspace_id !== member.workspace_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const meta = (job.metadata ?? {}) as Record<string, unknown>

  return NextResponse.json({
    job_id:         jobId,
    status:         job.status          as string,
    pages:          (meta.pages         ?? 0) as number,
    items_fetched:  (meta.items_fetched ?? 0) as number,
    items_upserted: (meta.items_upserted ?? 0) as number,
    has_more:       (meta.has_more      ?? true) as boolean,
    error_message:  job.error_message   as string | null,
    started_at:     job.started_at      as string | null,
    finished_at:    job.finished_at     as string | null,
  })
}
