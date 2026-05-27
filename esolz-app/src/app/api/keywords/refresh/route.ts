import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkKeywordRank } from '@/lib/integrations/amazon-keyword-adapter'

export const runtime    = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/keywords/refresh
 *
 * Refreshes all tracked_keywords in the workspace that have a tracked_asin_id.
 * Keywords without an ASIN association are skipped (rank check requires an ASIN).
 *
 * Inserts keyword_rank_snapshots rows for each checked keyword.
 */
export async function POST(_req: NextRequest) {
  const supabase = await createClient()

  // ── Auth ───────────────────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  console.log('[keywords/refresh] auth:', user?.id ?? null, authErr?.message ?? null)
  if (!user) return NextResponse.json({ error: 'Unauthorized', debug: { authErr } }, { status: 401 })

  // ── Workspace ──────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  console.log('[keywords/refresh] workspace:', member?.workspace_id ?? null, memberErr?.message ?? null)
  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found', debug: { memberErr } }, { status: 404 })
  }

  // ── Keywords with ASIN association ────────────────────────────────────────
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, keyword, marketplace, tracked_asin_id, tracked_asins(asin, marketplace)')
    .eq('workspace_id', member.workspace_id)
    .not('tracked_asin_id', 'is', null)

  console.log('[keywords/refresh] keywords with ASINs:', keywords?.length ?? 0, kwErr?.message ?? null)
  if (kwErr) {
    return NextResponse.json({ error: kwErr.message }, { status: 500 })
  }
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({
      results: [],
      message: 'No keywords with ASIN associations found. Track keywords from an ASIN detail page to enable rank refresh.',
    })
  }

  const admin = createAdminClient()
  const results: {
    keyword_id:    string
    keyword:       string
    asin:          string
    organic_rank:  number | null
    sponsored_rank: number | null
    page_status:   string
    scan_status:   string
    checked_at:    string
    error?:        string
  }[] = []

  for (const kw of keywords) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asinRow = Array.isArray(kw.tracked_asins)
      ? kw.tracked_asins[0]
      : kw.tracked_asins as { asin: string; marketplace: string } | null

    const asin       = asinRow?.asin
    const market     = kw.marketplace ?? asinRow?.marketplace ?? 'IN'

    if (!asin) continue

    try {
      console.log(`[keywords/refresh] checking rank for: "${kw.keyword}" / ${asin}`)
      const res = await checkKeywordRank(kw.keyword, asin, market)
      console.log(`[keywords/refresh] rank result:`, { keyword: kw.keyword, asin, organic_rank: res.organic_rank, page_status: res.page_status })

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
        asin,
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
        asin,
        organic_rank:  null,
        sponsored_rank: null,
        page_status:   'not_ranking',
        scan_status:   'error',
        checked_at:    new Date().toISOString(),
        error:         String(err),
      })
    }
  }

  return NextResponse.json({ checked: results.length, results })
}
