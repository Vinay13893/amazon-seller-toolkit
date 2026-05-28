import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateAlerts } from '@/lib/alerts/generate-alerts'

export const runtime    = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/alerts/generate
 *
 * Generates rule-based alerts from real Supabase data:
 *   - BSR: rank dropped/improved >20%
 *   - Buy Box: status changed / seller changed
 *   - Pincode: >30% unavailability
 *   - Keywords: page_1 entered / dropped
 *
 * Deduplication: skips alerts already open (status='new')
 * with the same (workspace_id, tracked_asin_id, module, title).
 *
 * Response: { created: number }
 */
export async function POST(_req: NextRequest) {
  console.log('[alerts-generate][1] POST /api/alerts/generate called')

  const supabase = await createClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    console.error('[alerts-generate][2] FAIL auth:', authErr?.message ?? 'no user')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log(`[alerts-generate][2] OK   user: ${user.id}`)

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    console.error('[alerts-generate][3] FAIL workspace:', memberErr?.message ?? 'no row')
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  console.log(`[alerts-generate][3] OK   workspace: ${member.workspace_id}`)

  // ── Generate alerts ───────────────────────────────────────────────────────
  let created = 0
  try {
    created = await generateAlerts(member.workspace_id)
    console.log(`[alerts-generate][4] OK   created=${created}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[alerts-generate][4] FAIL generate:', msg)
    return NextResponse.json({ error: 'Alert generation failed' }, { status: 500 })
  }

  return NextResponse.json({ created })
}
