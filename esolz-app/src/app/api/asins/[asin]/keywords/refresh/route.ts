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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Workspace ──────────────────────────────────────────────────────────────
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.workspace_id) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }
  const workspaceId = member.workspace_id

  // ── Resolve tracked_asins row ──────────────────────────────────────────────
  const { data: tracked } = await supabase
    .from('tracked_asins')
    .select('id, marketplace')
    .eq('workspace_id', workspaceId)
    .eq('asin', asin.toUpperCase())
    .neq('status', 'archived')
    .maybeSingle()

  if (!tracked) {
    return NextResponse.json({ error: 'ASIN not tracked in this workspace' }, { status: 404 })
  }
  const trackedAsinId = tracked.id
  const trackedMarketplace = tracked.marketplace

  // ── Load tracked keywords for this ASIN ───────────────────────────────────
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, keyword, marketplace')
    .eq('workspace_id', workspaceId)
    .eq('tracked_asin_id', trackedAsinId)

  if (kwErr) {
    return NextResponse.json({ error: kwErr.message }, { status: 500 })
  }
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({ results: [], message: 'No tracked keywords for this ASIN' })
  }

  // ── Run rank checks sequentially (Playwright can't be parallelised easily) ─
  const admin = createAdminClient()
  let runtimeUnavailableDetected = false
  const results: {
    keyword_id:    string
    keyword:       string
    organic_rank:  number | null
    sponsored_rank: number | null
    page_status:   string | null
    scan_status:   string
    checked_at:    string
    error?:        string
  }[] = []

  async function insertFailedSnapshot(params: {
    trackedKeywordId: string
    keyword: string
    checkedAt: string
    scrapeStatus: 'failed' | 'checker_unavailable'
    errorMessage: string
  }) {
    await admin
      .from('keyword_rank_snapshots')
      .insert({
        workspace_id:       workspaceId,
        tracked_keyword_id: params.trackedKeywordId,
        tracked_asin_id:    trackedAsinId,
        keyword:            params.keyword,
        organic_rank:       null,
        sponsored_rank:     null,
        page:               null,
        position_on_page:   null,
        found:              false,
        scrape_status:      params.scrapeStatus,
        error_message:      params.errorMessage,
        page_status:        null,
        checked_at:         params.checkedAt,
      })
  }

  for (const kw of keywords) {
    const workerConfigured = isWorkerConfigured()
    if (runtimeUnavailableDetected) {
      const checkedAt = new Date().toISOString()
      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        keyword: kw.keyword,
        checkedAt,
        scrapeStatus: 'checker_unavailable',
        errorMessage: KEYWORD_RUNTIME_UNAVAILABLE_ERROR,
      })
      results.push({
        keyword_id: kw.id,
        keyword: kw.keyword,
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
      const workerMarket = toWorkerMarketplace(kw.marketplace ?? trackedMarketplace ?? 'IN')

      let res
      if (workerConfigured) {
        const workerRes = await runKeywordRankCheck({
          workspace_id:       workspaceId,
          tracked_keyword_id: kw.id,
          asin:               asin.toUpperCase(),
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
        res = await checkKeywordRank(
          kw.keyword,
          asin.toUpperCase(),
          kw.marketplace ?? trackedMarketplace ?? 'IN',
        )
      }

      // Insert snapshot (admin client so INSERT isn't blocked by RLS edge-cases)
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
      const failedStatus: 'failed' | 'checker_unavailable' = runtimeUnavailable
        ? 'checker_unavailable'
        : 'failed'

      if (runtimeUnavailable) {
        runtimeUnavailableDetected = true
        console.warn('[asin_keywords.refresh.checker_unavailable]')
      }

      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        keyword: kw.keyword,
        checkedAt,
        scrapeStatus: failedStatus,
        errorMessage: safeError,
      })

      results.push({
        keyword_id:    kw.id,
        keyword:       kw.keyword,
        organic_rank:  null,
        sponsored_rank: null,
        page_status:   null,
        scan_status:   failedStatus,
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
      asin,
      checked: results.length,
      results,
    })
  }

  return NextResponse.json({
    asin,
    checked: results.length,
    results,
  })
}
