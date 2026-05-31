import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  checkKeywordRank,
  isKeywordRuntimeUnavailableError,
  KEYWORD_RUNTIME_UNAVAILABLE_ERROR,
} from '@/lib/integrations/amazon-keyword-adapter'
import {
  isWorkerConfigured,
  runKeywordRankCheck,
  CheckerWorkerUnavailableError,
  toWorkerMarketplace,
} from '@/lib/checkers/checker-worker-client'

export const runtime    = 'nodejs'
export const maxDuration = 120

const RUNTIME_UNAVAILABLE_RESPONSE_MESSAGE = 'Keyword rank checker runtime is not available. Please try again later.'

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
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Workspace ──────────────────────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  console.log('[keywords/refresh] workspace:', member?.workspace_id ?? null, memberErr?.message ?? null)
  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id

  // ── Keywords with ASIN association ────────────────────────────────────────
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, keyword, marketplace, tracked_asin_id, tracked_asins(asin, marketplace)')
    .eq('workspace_id', workspaceId)
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
  let runtimeUnavailableDetected = false
  const results: {
    keyword_id:    string
    keyword:       string
    asin:          string
    organic_rank:  number | null
    sponsored_rank: number | null
    page_status:   string | null
    scan_status:   string
    checked_at:    string
    error?:        string
  }[] = []

  async function insertFailedSnapshot(params: {
    trackedKeywordId: string
    trackedAsinId: string
    keyword: string
    checkedAt: string
    errorMessage: string
  }) {
    await admin
      .from('keyword_rank_snapshots')
      .insert({
        workspace_id:       workspaceId,
        tracked_keyword_id: params.trackedKeywordId,
        tracked_asin_id:    params.trackedAsinId,
        keyword:            params.keyword,
        organic_rank:       null,
        sponsored_rank:     null,
        page:               null,
        position_on_page:   null,
        found:              false,
        scrape_status:      'checker_unavailable',
        error_message:      params.errorMessage,
        page_status:        null,
        checked_at:         params.checkedAt,
      })
  }

  for (const kw of keywords) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asinRow = Array.isArray(kw.tracked_asins)
      ? kw.tracked_asins[0]
      : kw.tracked_asins as { asin: string; marketplace: string } | null

    const asin       = asinRow?.asin
    const market     = kw.marketplace ?? asinRow?.marketplace ?? 'IN'
    const workerMarket = toWorkerMarketplace(market)
    const trackedAsinId = kw.tracked_asin_id as string

    if (!asin) continue

    if (runtimeUnavailableDetected) {
      const checkedAt = new Date().toISOString()
      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        trackedAsinId,
        keyword: kw.keyword,
        checkedAt,
        errorMessage: KEYWORD_RUNTIME_UNAVAILABLE_ERROR,
      })
      results.push({
        keyword_id: kw.id,
        keyword: kw.keyword,
        asin,
        organic_rank: null,
        sponsored_rank: null,
        page_status: null,
        scan_status: 'checker_unavailable',
        checked_at: checkedAt,
        error: KEYWORD_RUNTIME_UNAVAILABLE_ERROR,
      })
      continue
    }

    try {
      console.log(`[keywords/refresh] checking rank for: "${kw.keyword}" / ${asin}`)

      let res
      if (isWorkerConfigured()) {
        const workerRes = await runKeywordRankCheck({
          workspace_id:       workspaceId,
          tracked_keyword_id: kw.id,
          asin,
          keyword:            kw.keyword,
          marketplace:        workerMarket,
        })
        res = {
          organic_rank:   workerRes.organic_rank,
          sponsored_rank: workerRes.sponsored_rank,
          page_number:    workerRes.page,
          pos_on_page:    workerRes.position_on_page,
          page_status:    workerRes.found ? (workerRes.page === 1 ? 'page_1' : workerRes.page === 2 ? 'page_2' : 'page_3') : 'not_ranking' as string,
          scan_status:    workerRes.status,
          checked_at:     new Date().toISOString(),
        }
      } else {
        res = await checkKeywordRank(kw.keyword, asin, market)
      }

      console.log(`[keywords/refresh] rank result:`, { keyword: kw.keyword, asin, organic_rank: res.organic_rank, page_status: res.page_status })

      const found = res.organic_rank !== null
      await admin
        .from('keyword_rank_snapshots')
        .insert({
          workspace_id:       workspaceId,
          tracked_keyword_id: kw.id,
          tracked_asin_id:    trackedAsinId,
          keyword:            kw.keyword,
          organic_rank:       res.organic_rank,
          sponsored_rank:     res.sponsored_rank,
          page:               res.page_number,
          position_on_page:   res.pos_on_page,
          found,
          scrape_status:      res.scan_status || 'success',
          error_message:      null,
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
      const checkedAt = new Date().toISOString()
      const runtimeUnavailable = isKeywordRuntimeUnavailableError(err) || err instanceof CheckerWorkerUnavailableError
      const safeError = runtimeUnavailable
        ? KEYWORD_RUNTIME_UNAVAILABLE_ERROR
        : (err instanceof Error ? err.message : 'Keyword rank check failed')

      if (runtimeUnavailable) {
        runtimeUnavailableDetected = true
        console.warn('[keywords/refresh] runtime unavailable while refreshing', {
          keyword: kw.keyword,
          asin,
        })
      }

      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        trackedAsinId,
        keyword: kw.keyword,
        checkedAt,
        errorMessage: safeError,
      })

      results.push({
        keyword_id:    kw.id,
        keyword:       kw.keyword,
        asin,
        organic_rank:  null,
        sponsored_rank: null,
        page_status:   null,
        scan_status:   'checker_unavailable',
        checked_at:    checkedAt,
        error:         safeError,
      })
    }
  }

  if (runtimeUnavailableDetected) {
    return NextResponse.json({
      ok: false,
      status: 'checker_unavailable',
      message: RUNTIME_UNAVAILABLE_RESPONSE_MESSAGE,
      checked: results.length,
      results,
    })
  }

  return NextResponse.json({ checked: results.length, results })
}
