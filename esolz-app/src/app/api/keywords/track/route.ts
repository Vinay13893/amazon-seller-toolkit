import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/keywords/track
 *
 * Saves a keyword to tracked_keywords for the user's workspace.
 * tracked_asin_id is LEFT NULL — use /api/asins/[asin]/keywords/track to link to an ASIN.
 *
 * Uses ignoreDuplicates: true so it never overwrites an existing ASIN association.
 *
 * Body: { keyword, marketplace, search_volume?, cpc_estimate?, difficulty? }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  console.log('[keywords/track] auth:', user?.id ?? null, authErr?.message ?? null)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    keyword:        string
    marketplace?:   string
    search_volume?: number | null
    cpc_estimate?:  number | null
    difficulty?:    number | null
  }
  console.log('[keywords/track] body:', body)

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

  console.log('[keywords/track] workspace:', member?.workspace_id ?? null, memberErr?.message ?? null)
  if (!member?.workspace_id) {
    return NextResponse.json(
      { error: 'No workspace found' },
      { status: 404 },
    )
  }

  const marketplace = (body.marketplace ?? 'IN').toUpperCase().replace('AMAZON.', '')

  // ── 3. Check if already exists (to decide whether to increment keyword_count) ─
  const { data: existing } = await supabase
    .from('tracked_keywords')
    .select('id')
    .eq('workspace_id', member.workspace_id)
    .eq('keyword', body.keyword.trim())
    .eq('marketplace', marketplace)
    .maybeSingle()

  // ── 4. Upsert — ignoreDuplicates:true so we never overwrite tracked_asin_id ─
  const { data, error } = await supabase
    .from('tracked_keywords')
    .upsert(
      {
        workspace_id:    member.workspace_id,
        keyword:         body.keyword.trim(),
        marketplace,
        search_volume:   body.search_volume  ?? null,
        cpc_estimate:    body.cpc_estimate   ?? null,
        difficulty:      body.difficulty     ?? null,
        tracked_asin_id: null,
      },
      { onConflict: 'workspace_id,keyword,marketplace', ignoreDuplicates: true },
    )
    .select()
    .maybeSingle()

  console.log('[keywords/track] upsert result:', {
    rowId:   data?.id ?? null,
    error:   error?.message ?? null,
    code:    error?.code ?? null,
    details: error?.details ?? null,
  })

  if (error) {
    return NextResponse.json(
      { error: 'Failed to save keyword' },
      { status: 500 },
    )
  }

  // ignoreDuplicates: true → data is null on conflict. Return the existing row.
  const savedRow = data ?? existing

  // ── 5. Increment keyword_count only if this was a new keyword ─────────────
  if (!existing) {
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
        console.log('[keywords/track] keyword_count incremented to', counter.keyword_count + 1)
      }
    } catch (counterErr) {
      console.warn('[keywords/track] keyword_count increment failed (non-fatal):', counterErr)
    }
  }

  return NextResponse.json({ keyword: savedRow, isNew: !existing })
}
