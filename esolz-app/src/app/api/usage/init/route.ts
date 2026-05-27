import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/usage/init
 *
 * Upserts a usage_counters row for the current billing period.
 * Uses the admin (service-role) client to bypass the missing INSERT/UPDATE
 * RLS policies on usage_counters (SELECT-only in current schema).
 *
 * Called by getOrCreateCurrentUsageCounter() when the row is missing.
 */
export async function POST(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as {
    workspace_id?: string
    workspaceId?: string   // legacy — prefer workspace_id
    period_start: string
    period_end: string
    asin_count: number
    keyword_count: number
    pincode_checks_used: number
    reports_generated: number
    competitor_count: number
  }

  // usage.ts sends the UsageCounter shape which uses snake_case workspace_id
  const workspaceId = body.workspace_id ?? body.workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 })
  }

  // ── Verify membership (prevents forged workspaceId) ───────────────────
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!member) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Upsert via admin client ───────────────────────────────────────────
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('usage_counters')
    .upsert(
      {
        workspace_id:        workspaceId,
        period_start:        body.period_start,
        period_end:          body.period_end,
        asin_count:          body.asin_count          ?? 0,
        keyword_count:       body.keyword_count        ?? 0,
        pincode_checks_used: body.pincode_checks_used  ?? 0,
        reports_generated:   body.reports_generated    ?? 0,
        competitor_count:    body.competitor_count      ?? 0,
      },
      { onConflict: 'workspace_id,period_start' }
    )
    .select()
    .single()

  if (error) {
    console.error('[usage/init] upsert failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ counter: data })
}
