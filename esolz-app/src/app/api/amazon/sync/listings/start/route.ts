import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime     = 'nodejs'
export const maxDuration = 15

/**
 * POST /api/amazon/sync/listings/start
 *
 * Creates a new amazon_sync_jobs row and returns immediately.
 * The frontend then calls /process repeatedly to do the actual work
 * one page at a time, preventing Vercel 504 timeouts.
 */
export async function POST() {
  try {
    return await handlePost()
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function handlePost() {
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Workspace + role ────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  if (member.role !== 'owner' && member.role !== 'admin') {
    return NextResponse.json({ error: 'Owner or admin required' }, { status: 403 })
  }

  const admin = createAdminClient()

  // ── 3. Confirm active amazon_connections row ───────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: conn } = await (admin as any)
    .from('amazon_connections')
    .select('id, status, selling_partner_id')
    .eq('workspace_id', member.workspace_id)
    .maybeSingle()

  if (!conn) {
    return NextResponse.json({ error: 'No Amazon connection found. Connect first.' }, { status: 404 })
  }
  if (conn.status === 'revoked') {
    return NextResponse.json({ error: 'Connection revoked. Please reconnect.' }, { status: 409 })
  }
  if (!conn.selling_partner_id) {
    return NextResponse.json({ error: 'Seller ID not found. Run Sync Now first.' }, { status: 409 })
  }

  // ── 4. Cancel any in-flight job for this workspace (prevent duplicates) ────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from('amazon_sync_jobs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('workspace_id', member.workspace_id)
      .eq('job_type', 'listings_sync')
      .eq('status', 'running')
  } catch { /* non-fatal */ }

  // ── 5. Create fresh job row ────────────────────────────────────────────────
  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job, error: jobErr } = await (admin as any)
    .from('amazon_sync_jobs')
    .insert({
      workspace_id:  member.workspace_id,
      connection_id: conn.id,
      job_type:      'listings_sync',
      status:        'running',
      started_at:    now,
      metadata: {
        page_token:       null,
        pages:            0,
        items_fetched:    0,
        items_upserted:   0,
        has_more:         true,
        last_processed_at: null,
      },
    })
    .select('id')
    .single()

  if (jobErr || !job?.id) {
    return NextResponse.json({ error: 'Failed to create sync job' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, job_id: job.id as string })
}
