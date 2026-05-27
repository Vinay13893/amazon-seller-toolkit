import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkKeywordRank } from '@/lib/integrations/amazon-keyword-adapter'

export const runtime    = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/asins/[asin]/keywords/refresh
 *
 * For each tracked_keyword linked to this ASIN:
 *   1. Runs rank_check_adapter.py (Playwright scrape)
 *   2. Inserts a keyword_rank_snapshots row
 *
 * Returns the updated keywords with their latest snapshot data.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ asin: string }> },
) {
  const { asin } = await params
  const supabase  = await createClient()

  // ── Auth ───────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  console.log(`[asins/${asin}/keywords/refresh] auth:`, user?.id ?? null, authErr?.message ?? null)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Workspace ──────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  console.log(`[asins/${asin}/keywords/refresh] workspace:`, member?.workspace_id ?? null, memberErr?.message ?? null)
  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  // ── Resolve tracked_asins row ──────────────────────────────────────────────
  const { data: tracked, error: asinErr } = await supabase
    .from('tracked_asins')
    .select('id, marketplace')
    .eq('workspace_id', member.workspace_id)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  console.log(`[asins/${asin}/keywords/refresh] tracked_asin:`, tracked?.id ?? null, asinErr?.message ?? null)
  if (!tracked) {
    return NextResponse.json({ error: 'ASIN not tracked in this workspace' }, { status: 404 })
  }

  // ── Load tracked keywords for this ASIN ───────────────────────────────────
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, keyword, marketplace')
    .eq('workspace_id', member.workspace_id)
    .eq('tracked_asin_id', tracked.id)

  console.log(`[asins/${asin}/keywords/refresh] keywords to refresh:`, keywords?.length ?? 0, kwErr?.message ?? null)
  if (kwErr) {
    return NextResponse.json({ error: kwErr.message }, { status: 500 })
  }
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({ results: [], message: 'No tracked keywords for this ASIN' })
  }

  // ── Run rank checks sequentially (Playwright can't be parallelised easily) ─
  const admin = createAdminClient()
  const results: {
    keyword_id:    string
    keyword:       string
    organic_rank:  number | null
    sponsored_rank: number | null
    page_status:   string
    scan_status:   string
    checked_at:    string
    error?:        string
  }[] = []

  for (const kw of keywords) {
    try {
      console.log(`[asins/${asin}/keywords/refresh] checking rank for: "${kw.keyword}"`)
      const res = await checkKeywordRank(
        kw.keyword,
        asin.toUpperCase(),
        kw.marketplace ?? tracked.marketplace ?? 'IN',
      )
      console.log(`[asins/${asin}/keywords/refresh] rank result:`, { keyword: kw.keyword, organic_rank: res.organic_rank, page_status: res.page_status, scan_status: res.scan_status })

      // Insert snapshot (admin client so INSERT isn't blocked by RLS edge-cases)
      await admin
        .from('keyword_rank_snapshots')
        .insert({
          workspace_id:       member.workspace_id,
          tracked_keyword_id: kw.id,
          organic_rank:       res.organic_rank,
          sponsored_rank:     res.sponsored_rank,
          page_status:        res.page_status,
          checked_at:         res.checked_at,
        })

      results.push({
        keyword_id:    kw.id,
        keyword:       kw.keyword,
        organic_rank:  res.organic_rank,
        sponsored_rank: res.sponsored_rank,
        page_status:   res.page_status,
        scan_status:   res.scan_status,
        checked_at:    res.checked_at,
      })
    } catch (err) {
      results.push({
        keyword_id:    kw.id,
        keyword:       kw.keyword,
        organic_rank:  null,
        sponsored_rank: null,
        page_status:   'not_ranking',
        scan_status:   'error',
        checked_at:    new Date().toISOString(),
        error:         String(err),
      })
    }
  }

  return NextResponse.json({
    asin,
    checked: results.length,
    results,
  })
}
