import { createAdminClient } from '@/lib/supabase/admin'
import { runKeywordRankCheck, toWorkerMarketplace } from '@/lib/checkers/checker-worker-client'
import { marketplaceFromMarketplaceId } from '@/lib/asins/product-separation'
import { keywordTargetKey, resolveKeywordRefreshTarget } from '@/lib/keywords/keyword-tracking'
import { isConfirmedKeywordScan } from '@/lib/internal/keyword-cron-status'

export const runtime = 'nodejs'
export const maxDuration = 120

type Keyword = { id: string; workspace_id: string; keyword: string; marketplace: string; own_asin: string | null; tracked_asin_id: string | null }

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.CHECKER_WORKER_URL || !process.env.CHECKER_WORKER_SECRET)
    return Response.json({ error: 'worker_not_configured' }, { status: 503 })

  const admin = createAdminClient()
  const { data: keywords, error: keywordError } = await admin.from('tracked_keywords')
    .select('id,workspace_id,keyword,marketplace,own_asin,tracked_asin_id')
    .limit(1001)
  if (keywordError || !keywords || keywords.length > 1000)
    return Response.json({ error: 'keyword_scope_unavailable' }, { status: 503 })
  if (!keywords.length) return Response.json({ checked: 0, failed: 0 })

  const { data: snapshots, error: snapshotError } = await admin.from('keyword_rank_snapshots')
    .select('tracked_keyword_id,checked_at')
    .gte('checked_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .order('checked_at', { ascending: false }).limit(1001)
  if (snapshotError || !snapshots || snapshots.length > 1000)
    return Response.json({ error: 'snapshot_scope_unavailable' }, { status: 503 })
  const latest = new Map<string, string>()
  for (const row of snapshots) if (row.tracked_keyword_id && !latest.has(row.tracked_keyword_id))
    latest.set(row.tracked_keyword_id, row.checked_at)
  const dueBefore = Date.now() - 24 * 3600_000
  const due = (keywords as Keyword[])
    .filter(row => !latest.has(row.id) || new Date(latest.get(row.id)!).getTime() < dueBefore)
    .filter(row => row.own_asin || row.tracked_asin_id)
    .sort((a, b) => (latest.get(a.id) ?? '').localeCompare(latest.get(b.id) ?? ''))
    .slice(0, 20)

  let checked = 0
  let failed = 0
  let selected = 0
  for (const keyword of due) {
    if (selected >= 2) break
    const tracked = keyword.tracked_asin_id
      ? await admin.from('tracked_asins').select('id,asin,marketplace,status')
        .eq('id', keyword.tracked_asin_id).eq('workspace_id', keyword.workspace_id).maybeSingle()
      : null
    if (tracked?.error) return Response.json({ error: 'target_read_failed' }, { status: 500 })
    const catalog = keyword.own_asin
      ? await admin.from('amazon_listing_items').select('asin,marketplace_id')
        .eq('workspace_id', keyword.workspace_id).eq('asin', keyword.own_asin)
      : null
    if (catalog?.error) return Response.json({ error: 'ownership_read_failed' }, { status: 500 })
    const ownKeys = new Set((catalog?.data ?? []).filter(row => row.asin && row.marketplace_id)
      .map(row => keywordTargetKey('my_product', row.asin!, marketplaceFromMarketplaceId(row.marketplace_id!))))
    const trackedById = new Map(tracked?.data && tracked.data.status !== 'archived'
      ? [[tracked.data.id, tracked.data]] : [])
    const target = resolveKeywordRefreshTarget(keyword, trackedById, ownKeys)
    if (!target) continue
    selected += 1

    const checkedAt = new Date().toISOString()
    let result: Awaited<ReturnType<typeof runKeywordRankCheck>> | null = null
    try {
      result = await runKeywordRankCheck({
        workspace_id: keyword.workspace_id,
        tracked_keyword_id: keyword.id,
        asin: target.asin,
        keyword: keyword.keyword,
        marketplace: toWorkerMarketplace(target.marketplace),
      })
    } catch { /* Unknown checker state must never become a rank result. */ }
    const success = isConfirmedKeywordScan(result?.status)
    const organicFound = success && result?.organic_found === true
    const sponsoredFound = success && result?.sponsored_found === true
    const { error: insertError } = await admin.from('keyword_rank_snapshots').insert({
      workspace_id: keyword.workspace_id,
      tracked_keyword_id: keyword.id,
      tracked_asin_id: target.trackedAsinId,
      keyword: keyword.keyword,
      organic_rank: success ? result?.organic_rank : null,
      organic_page: success ? result?.organic_page : null,
      organic_slot: success ? result?.organic_slot : null,
      organic_found: organicFound,
      sponsored_rank: success ? result?.sponsored_rank : null,
      sponsored_page: success ? result?.sponsored_page : null,
      sponsored_slot: success ? result?.sponsored_slot : null,
      sponsored_found: sponsoredFound,
      page: success ? result?.organic_page ?? result?.sponsored_page : null,
      position_on_page: success ? result?.organic_slot ?? result?.sponsored_slot : null,
      found: organicFound || sponsoredFound,
      scrape_status: success ? result?.status
        : result?.status === 'failed' || result?.status === 'blocked' ? 'failed' : 'checker_unavailable',
      error_message: success ? null : result ? 'Keyword rank check failed' : 'Keyword rank checker unavailable',
      page_status: organicFound
        ? (result?.organic_page === 1 ? 'page_1' : result?.organic_page === 2 ? 'page_2' : result?.organic_page === 3 ? 'page_3' : 'not_ranking')
        : success ? 'not_ranking' : null,
      checked_at: checkedAt,
    })
    if (insertError) failed += 1
    else if (success) checked += 1
    else failed += 1
  }
  return Response.json({ selected, checked, failed }, { status: failed ? 503 : 200 })
}
