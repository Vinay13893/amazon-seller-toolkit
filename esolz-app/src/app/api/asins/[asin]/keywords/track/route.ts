import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/asins/[asin]/keywords/track
 *
 * Saves a keyword to tracked_keywords linked to the specified tracked ASIN.
 * On conflict (same workspace+keyword+marketplace) it UPDATE-merges so the
 * tracked_asin_id is set/updated rather than left null.
 *
 * Body: { keyword, marketplace?, search_volume?, cpc_estimate?, difficulty? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ asin: string }> },
) {
  const { asin } = await params
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  console.log(`[asins/${asin}/keywords/track] auth:`, user?.id ?? null, authErr?.message ?? null)
  if (!user) return NextResponse.json({ error: 'Unauthorized', debug: { authErr } }, { status: 401 })

  const body = await req.json() as {
    keyword:        string
    marketplace?:   string
    search_volume?: number | null
    cpc_estimate?:  number | null
    difficulty?:    number | null
  }
  console.log(`[asins/${asin}/keywords/track] body:`, body)

  if (!body.keyword?.trim()) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 })
  }

  // ── 2. Workspace ───────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  console.log(`[asins/${asin}/keywords/track] workspace:`, member?.workspace_id ?? null, memberErr?.message ?? null)
  if (!member?.workspace_id) {
    return NextResponse.json(
      { error: 'No workspace found', debug: { user: user.id, memberErr } },
      { status: 404 },
    )
  }

  // ── 3. Resolve tracked_asin_id ────────────────────────────────────────────
  const marketplace = (body.marketplace ?? 'IN').toUpperCase().replace('AMAZON.', '')

  const { data: tracked, error: asinErr } = await supabase
    .from('tracked_asins')
    .select('id')
    .eq('workspace_id', member.workspace_id)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  console.log(`[asins/${asin}/keywords/track] tracked_asin:`, tracked?.id ?? null, asinErr?.message ?? null)

  // ASIN must be tracked — we cannot link a keyword to an untracked ASIN
  if (!tracked?.id) {
    return NextResponse.json(
      { error: `ASIN ${asin} is not tracked in this workspace. Add it to ASIN tracking first.`, debug: { asinErr } },
      { status: 404 },
    )
  }

  // ── 4. Upsert — update tracked_asin_id on conflict ────────────────────────
  const { data, error } = await supabase
    .from('tracked_keywords')
    .upsert(
      {
        workspace_id:    member.workspace_id,
        tracked_asin_id: tracked.id,
        keyword:         body.keyword.trim(),
        marketplace,
        search_volume:   body.search_volume ?? null,
        cpc_estimate:    body.cpc_estimate  ?? null,
        difficulty:      body.difficulty    ?? null,
      },
      { onConflict: 'workspace_id,keyword,marketplace', ignoreDuplicates: false },
    )
    .select()
    .single()

  console.log(`[asins/${asin}/keywords/track] upsert result:`, {
    rowId:       data?.id ?? null,
    asinLinked:  data?.tracked_asin_id ?? null,
    error:       error?.message ?? null,
    code:        error?.code ?? null,
    details:     error?.details ?? null,
  })

  if (error) {
    return NextResponse.json(
      { error: error.message, debug: { code: error.code, details: error.details } },
      { status: 500 },
    )
  }

  // ── 5. Increment keyword_count ─────────────────────────────────────────────
  try {
    const admin = createAdminClient()
    const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
    const { data: counter } = await admin
      .from('usage_counters')
      .select('id, keyword_count')
      .eq('workspace_id', member.workspace_id)
      .gte('period_start', periodStart)
      .limit(1)
      .maybeSingle()
    if (counter) {
      await admin
        .from('usage_counters')
        .update({ keyword_count: counter.keyword_count + 1, updated_at: new Date().toISOString() })
        .eq('id', counter.id)
      console.log(`[asins/${asin}/keywords/track] keyword_count incremented to`, counter.keyword_count + 1)
    }
  } catch (counterErr) {
    console.warn(`[asins/${asin}/keywords/track] keyword_count increment failed (non-fatal):`, counterErr)
  }

  return NextResponse.json({ keyword: data })
}
