import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFailedPageMetadata,
  buildSuccessfulPageMetadata,
  upsertCatalogListingsPage,
  type CatalogListingUpsert,
} from './catalog-refresh-listings'

const marketplaceId = 'A21TJRUUN4KGV'

function listing(sku: string, asin: string) {
  return {
    sku,
    summaries: [
      {
        marketplaceId,
        asin,
        itemName: `Item ${sku}`,
        productType: 'HOME',
        status: ['BUYABLE'],
        mainImage: { link: `https://example.test/${sku}.jpg` },
      },
    ],
    attributes: {
      brand: [{ value: 'EasyHOME' }],
    },
  }
}

test('successful page counts confirmed writes and advances the page token', async () => {
  const writtenRows: Record<string, unknown>[] = []
  const upsertListing: CatalogListingUpsert = async row => {
    writtenRows.push(row)
    return { error: null }
  }

  const result = await upsertCatalogListingsPage({
    items: [listing('SKU-1', 'B000000001'), listing('SKU-2', 'B000000002')],
    marketplaceId,
    workspaceId: 'workspace-1',
    connectionId: 'connection-1',
    syncedAt: '2026-09-11T00:00:00.000Z',
    upsertListing,
  })
  const metadata = buildSuccessfulPageMetadata(
    { pages: 0, itemsFetched: 2, itemsUpserted: result.confirmedUpserts },
    'NEXT-PAGE',
  )

  assert.deepEqual(result, { ok: true, confirmedUpserts: 2 })
  assert.equal(writtenRows.length, 2)
  assert.equal(metadata.page_token, 'NEXT-PAGE')
  assert.equal(metadata.pages, 1)
  assert.equal(metadata.items_upserted, 2)
})

test('failed listing upsert counts only confirmed writes and keeps the current page token', async () => {
  let calls = 0
  const upsertListing: CatalogListingUpsert = async () => {
    calls++
    return calls === 2 ? { error: { message: 'database unavailable' } } : { error: null }
  }

  const result = await upsertCatalogListingsPage({
    items: [listing('SKU-1', 'B000000001'), listing('SKU-2', 'B000000002')],
    marketplaceId,
    workspaceId: 'workspace-1',
    connectionId: 'connection-1',
    syncedAt: '2026-09-11T00:00:00.000Z',
    upsertListing,
  })
  const metadata = buildFailedPageMetadata(
    { pages: 3, itemsFetched: 60, itemsUpserted: 60 },
    'CURRENT-PAGE',
  )

  assert.deepEqual(result, {
    ok: false,
    confirmedUpserts: 1,
    reason: 'listing_upsert_failed',
  })
  assert.equal(metadata.page_token, 'CURRENT-PAGE')
  assert.equal(metadata.pages, 3)
  assert.equal(metadata.items_fetched, 60)
  assert.equal(metadata.items_upserted, 60)
})

test('failed first listing can retry from the same saved page token', async () => {
  const failed = await upsertCatalogListingsPage({
    items: [listing('SKU-1', 'B000000001')],
    marketplaceId,
    workspaceId: 'workspace-1',
    connectionId: 'connection-1',
    syncedAt: '2026-09-11T00:00:00.000Z',
    upsertListing: async () => ({ error: { message: 'temporary write failure' } }),
  })
  const retryMetadata = buildFailedPageMetadata(
    { pages: 4, itemsFetched: 80, itemsUpserted: 80 },
    'RETRY-ME',
  )

  assert.deepEqual(failed, {
    ok: false,
    confirmedUpserts: 0,
    reason: 'listing_upsert_failed',
  })
  assert.equal(retryMetadata.page_token, 'RETRY-ME')
  assert.equal(retryMetadata.pages, 4)
})

test('completion metadata is only produced from a successful page', () => {
  const success = buildSuccessfulPageMetadata(
    { pages: 1, itemsFetched: 40, itemsUpserted: 40 },
    undefined,
  )
  const failure = buildFailedPageMetadata(
    { pages: 1, itemsFetched: 40, itemsUpserted: 40 },
    'CURRENT-PAGE',
  )

  assert.equal(success.page_token, null)
  assert.equal(success.pages, 2)
  assert.equal(failure.page_token, 'CURRENT-PAGE')
  assert.equal(failure.pages, 1)
})
