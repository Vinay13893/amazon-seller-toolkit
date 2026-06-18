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
    return NextResponse.json({ error: 'Failed to load tracked keywords' }, { status: 500 })
  }
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({ results: [], message: 'No tracked keywords for this ASIN' })
  }

  // ── Run rank checks sequentially (Playwright can't be parallelised easily) ─
  const admin = createAdminClient()
  let runtimeUnavailableDetected = false
  const results: {
    keyword_id:    string
    organic_rank:  number | null
    organic_page:  number | null
    organic_slot:  number | null
    organic_found: boolean
    sponsored_rank: number | null
    sponsored_page: number | null
    sponsored_slot: number | null
    sponsored_found: boolean
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
        organic_page:       null,
        organic_slot:       null,
        organic_found:      false,
        sponsored_rank:     null,
        sponsored_page:     null,
        sponsored_slot:     null,
        sponsored_found:    false,
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
        organic_rank: null,
        organic_page: null,
        organic_slot: null,
        organic_found: false,
        sponsored_rank: null,
        sponsored_page: null,
        sponsored_slot: null,
        sponsored_found: false,
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
          organic_page:   workerRes.organic_page,
          organic_slot:   workerRes.organic_slot,
          organic_found:  workerRes.organic_found,
          sponsored_rank: workerRes.sponsored_rank,
          sponsored_page: workerRes.sponsored_page,
          sponsored_slot: workerRes.sponsored_slot,
          sponsored_found: workerRes.sponsored_found,
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
      const found = res.organic_found || res.sponsored_found
      const { error: snapshotError } = await admin
        .from('keyword_rank_snapshots')
        .insert({
          workspace_id:       workspaceId,
          tracked_keyword_id: kw.id,
          tracked_asin_id:    trackedAsinId,
          keyword:            kw.keyword,
          organic_rank:       res.organic_rank,
          organic_page:       res.organic_page,
          organic_slot:       res.organic_slot,
          organic_found:      res.organic_found,
          sponsored_rank:     res.sponsored_rank,
          sponsored_page:     res.sponsored_page,
          sponsored_slot:     res.sponsored_slot,
          sponsored_found:    res.sponsored_found,
          page:               res.organic_page ?? res.sponsored_page,
          position_on_page:   res.organic_slot ?? res.sponsored_slot,
          found,
          scrape_status:      res.scan_status || 'success',
          error_message:      null,
          page_status:        res.organic_found
            ? (res.organic_page === 1 ? 'page_1' : res.organic_page === 2 ? 'page_2' : res.organic_page === 3 ? 'page_3' : 'not_ranking')
            : 'not_ranking',
          checked_at:         res.checked_at,
        })
      if (snapshotError) {
        throw new Error('snapshot_insert_failed')
      }

      results.push({
        keyword_id:    kw.id,
        organic_rank:  res.organic_rank,
        organic_page:  res.organic_page,
        organic_slot:  res.organic_slot,
        organic_found: res.organic_found,
        sponsored_rank: res.sponsored_rank,
        sponsored_page: res.sponsored_page,
        sponsored_slot: res.sponsored_slot,
        sponsored_found: res.sponsored_found,
        scan_status:   res.scan_status,
        checked_at:    res.checked_at,
      })
    } catch (err) {
      const checkedAt = new Date().toISOString()
      const runtimeUnavailable = isKeywordRuntimeUnavailableError(err) || err instanceof CheckerWorkerUnavailableError
      const safeError = runtimeUnavailable
        ? KEYWORD_RUNTIME_UNAVAILABLE_ERROR
        : 'Keyword rank check failed'
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
        organic_rank:  null,
        organic_page:  null,
        organic_slot:  null,
        organic_found: false,
        sponsored_rank: null,
        sponsored_page: null,
        sponsored_slot: null,
        sponsored_found: false,
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
      checked: results.length,
      results,
    })
  }

  return NextResponse.json({
    checked: results.length,
    results,
  })
}
