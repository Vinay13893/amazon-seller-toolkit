import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterKeywordRowsByAsin,
  getEffectiveKeywordAsinFilter,
  getKeywordRefreshState,
  refreshKeywordIds,
  type KeywordRefreshRow,
} from './keyword-refresh'

const rows: KeywordRefreshRow[] = [
  {
    id: 'own-a',
    target_type: 'my_product',
    source_id: 'B0OWN00001',
    marketplace: 'IN',
  },
  {
    id: 'own-b',
    target_type: 'my_product',
    source_id: 'B0OWN00002',
    marketplace: 'IN',
  },
]

test('refresh stays disabled until workspace and visible keywords are ready', () => {
  assert.deepEqual(
    getKeywordRefreshState({ loading: true, workspaceId: null, keywordCount: 0, refreshing: false }),
    { canRefresh: false, reason: 'loading' },
  )
  assert.deepEqual(
    getKeywordRefreshState({ loading: false, workspaceId: null, keywordCount: 1, refreshing: false }),
    { canRefresh: false, reason: 'workspace_unavailable' },
  )
  assert.deepEqual(
    getKeywordRefreshState({ loading: false, workspaceId: 'workspace-1', keywordCount: 0, refreshing: false }),
    { canRefresh: false, reason: 'no_keywords' },
  )
  assert.deepEqual(
    getKeywordRefreshState({ loading: false, workspaceId: 'workspace-1', keywordCount: 1, refreshing: false }),
    { canRefresh: true, reason: null },
  )
})

test('selected ASIN filter sends only that ASIN keyword to refresh', async () => {
  const selected = filterKeywordRowsByAsin(rows, 'my_product:IN:B0OWN00002')
  const requests: Array<{ input: string; init: RequestInit }> = []

  const result = await refreshKeywordIds(selected.map(row => row.id), async (input, init) => {
    requests.push({ input, init })
    return {
      ok: true,
      async json() {
        return { checked: 1 }
      },
    }
  })

  assert.deepEqual(selected.map(row => row.id), ['own-b'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].input, '/api/keywords/refresh')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.body, JSON.stringify({ keywordIds: ['own-b'] }))
  assert.deepEqual(result, { completed: 1, partial: 0 })
})

test('stale ASIN filter safely falls back to the domain keyword rows', () => {
  assert.equal(getEffectiveKeywordAsinFilter(rows, 'my_product:IN:B0MISSING1'), 'all')
  assert.deepEqual(
    filterKeywordRowsByAsin(rows, 'my_product:IN:B0MISSING1').map(row => row.id),
    ['own-a', 'own-b'],
  )
})

test('failed refresh responses are counted as partial while progress remains accurate', async () => {
  const progress: Array<[number, number]> = []
  const result = await refreshKeywordIds(
    ['own-a', 'own-b'],
    async (_input, init) => ({
      ok: JSON.parse(String(init.body)).keywordIds[0] === 'own-a',
      async json() {
        return JSON.parse(String(init.body)).keywordIds[0] === 'own-a'
          ? { checked: 1 }
          : { checked: 0, status: 'failed' }
      },
    }),
    (processed, total) => progress.push([processed, total]),
  )

  assert.deepEqual(result, { completed: 1, partial: 1 })
  assert.deepEqual(progress, [[1, 2], [2, 2]])
})
