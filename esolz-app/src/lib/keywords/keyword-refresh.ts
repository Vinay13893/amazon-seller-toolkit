import { keywordTargetKey, type KeywordTargetType } from './keyword-tracking'

export type KeywordRefreshRow = {
  id: string
  target_type: KeywordTargetType | 'research'
  source_id: string | null
  marketplace: string
}

export type KeywordRefreshState = {
  canRefresh: boolean
  reason: 'loading' | 'workspace_unavailable' | 'no_keywords' | 'refreshing' | null
}

type RefreshResponse = {
  ok: boolean
  json(): Promise<unknown>
}

type RefreshFetcher = (input: string, init: RequestInit) => Promise<RefreshResponse>

type RefreshResponseBody = {
  checked?: number
  status?: string
}

export function filterKeywordRowsByAsin<T extends KeywordRefreshRow>(
  rows: T[],
  asinFilter: string,
): T[] {
  const effectiveFilter = getEffectiveKeywordAsinFilter(rows, asinFilter)
  if (effectiveFilter === 'all') return rows

  return rows.filter(row => (
    row.source_id
    && row.target_type !== 'research'
    && keywordTargetKey(row.target_type, row.source_id, row.marketplace) === effectiveFilter
  ))
}

export function getEffectiveKeywordAsinFilter<T extends KeywordRefreshRow>(
  rows: T[],
  asinFilter: string,
): string {
  if (asinFilter === 'all') return 'all'

  const filterExists = rows.some(row => (
    row.source_id
    && row.target_type !== 'research'
    && keywordTargetKey(row.target_type, row.source_id, row.marketplace) === asinFilter
  ))

  return filterExists ? asinFilter : 'all'
}

export function getKeywordRefreshState(params: {
  loading: boolean
  workspaceId: string | null
  keywordCount: number
  refreshing: boolean
}): KeywordRefreshState {
  if (params.refreshing) return { canRefresh: false, reason: 'refreshing' }
  if (params.loading) return { canRefresh: false, reason: 'loading' }
  if (!params.workspaceId) return { canRefresh: false, reason: 'workspace_unavailable' }
  if (params.keywordCount === 0) return { canRefresh: false, reason: 'no_keywords' }
  return { canRefresh: true, reason: null }
}

export async function refreshKeywordIds(
  keywordIds: string[],
  fetcher: RefreshFetcher,
  onProgress?: (processed: number, total: number) => void,
): Promise<{ completed: number; partial: number }> {
  let completed = 0
  let partial = 0

  for (const keywordId of keywordIds) {
    const response = await fetcher('/api/keywords/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywordIds: [keywordId] }),
    })

    let body: RefreshResponseBody | null = null
    try {
      body = await response.json() as RefreshResponseBody
    } catch {
      body = null
    }

    if (
      response.ok
      && body?.status !== 'failed'
      && body?.status !== 'checker_unavailable'
      && body?.checked === 1
    ) {
      completed += 1
    } else {
      partial += 1
    }

    onProgress?.(completed + partial, keywordIds.length)
  }

  return { completed, partial }
}
