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
const KEYWORD_CHECK_TIMEOUT_MS = 25_000
const MAX_KEYWORDS_PER_REQUEST = 5

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(error => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

/**
 * POST /api/keywords/refresh
 *
 * Refreshes a caller-selected small batch of tracked keywords in the workspace.
 * Keywords without an ASIN association are skipped (rank check requires an ASIN).
 *
 * Inserts keyword_rank_snapshots rows for each checked keyword.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

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

  const body = await req.json().catch(() => null) as { keywordIds?: unknown } | null
  const keywordIds = Array.isArray(body?.keywordIds)
    ? body.keywordIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []

  if (keywordIds.length === 0 || keywordIds.length > MAX_KEYWORDS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Select between 1 and ${MAX_KEYWORDS_PER_REQUEST} keywords to refresh.` },
      { status: 400 },
    )
  }

  // ── Keywords with ASIN association ────────────────────────────────────────
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, keyword, marketplace, tracked_asin_id, tracked_asins(asin, marketplace)')
    .eq('workspace_id', workspaceId)
    .in('id', keywordIds)
    .not('tracked_asin_id', 'is', null)

  if (kwErr) {
    return NextResponse.json({ error: 'Failed to load tracked keywords' }, { status: 500 })
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
    trackedAsinId: string
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
        tracked_asin_id:    params.trackedAsinId,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asinRow = Array.isArray(kw.tracked_asins)
      ? kw.tracked_asins[0]
      : kw.tracked_asins as { asin: string; marketplace: string } | null

    const asin       = asinRow?.asin
    const market     = kw.marketplace ?? asinRow?.marketplace ?? 'IN'
    const workerMarket = toWorkerMarketplace(market)
    const trackedAsinId = kw.tracked_asin_id as string
    const workerConfigured = isWorkerConfigured()
    if (!asin) continue

    if (runtimeUnavailableDetected) {
      const checkedAt = new Date().toISOString()
      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        trackedAsinId,
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
      let res
      if (workerConfigured) {
        const workerRes = await withTimeout(
          runKeywordRankCheck({
            workspace_id:       workspaceId,
            tracked_keyword_id: kw.id,
            asin,
            keyword:            kw.keyword,
            marketplace:        workerMarket,
          }),
          KEYWORD_CHECK_TIMEOUT_MS,
          'keyword rank check timed out',
        )
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
        res = await withTimeout(
          checkKeywordRank(kw.keyword, asin, market),
          KEYWORD_CHECK_TIMEOUT_MS,
          'keyword rank check timed out',
        )
      }

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
        console.warn('[keywords.refresh.checker_unavailable]')
      }

      await insertFailedSnapshot({
        trackedKeywordId: kw.id,
        trackedAsinId,
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

  return NextResponse.json({ checked: results.length, results })
}
