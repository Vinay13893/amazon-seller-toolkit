import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { classifyKeywordFound } from '../keyword-found-status'
import {
  buildKeywordOwnAsinSources,
  filterKeywordCompetitorCandidates,
  hasDuplicateKeywordForTarget,
  keywordSourceFromListing,
  keywordTargetKey,
  keywordTargetType,
  resolveKeywordRefreshTarget,
  snapshotTargetForKeyword,
  type KeywordTrackingRow,
} from './keyword-tracking'

const ownListing = {
  id: 'listing-in',
  asin: 'B0OWNIN001',
  marketplace_id: 'A21TJRUUN4KGV',
  sku: 'OWN-IN',
  item_name: 'Own mat',
}

test('own catalog keyword target resolves from ASIN identity', () => {
  assert.equal(
    keywordTargetType({ own_asin: 'B0OWNIN001', tracked_asin_id: null }),
    'my_product',
  )
})

test('competitor keyword target resolves from tracked_asin_id', () => {
  assert.equal(
    keywordTargetType({ own_asin: null, tracked_asin_id: 'tracked-external' }),
    'competitor_asin',
  )
})

test('keyword target with both product refs is invalid', () => {
  assert.equal(
    keywordTargetType({ own_asin: 'B0OWNIN001', tracked_asin_id: 'tracked-external' }),
    null,
  )
})

test('legacy unassigned keyword remains unbound', () => {
  assert.equal(keywordTargetType({ own_asin: null, tracked_asin_id: null }), null)
})

test('same keyword can exist on two different own products', () => {
  const rows: KeywordTrackingRow[] = [{
    own_asin: 'B0OWNIN001',
    tracked_asin_id: null,
    keyword: 'floor mat',
    marketplace: 'IN',
  }]

  assert.equal(
    hasDuplicateKeywordForTarget(rows, 'my_product', 'B0OWNIN002', 'floor mat', 'IN'),
    false,
  )
})

test('duplicate keyword on same own product is prevented', () => {
  const rows: KeywordTrackingRow[] = [{
    own_asin: 'B0OWNIN001',
    tracked_asin_id: null,
    keyword: 'Floor Mat',
    marketplace: 'IN',
  }]

  assert.equal(
    hasDuplicateKeywordForTarget(rows, 'my_product', 'B0OWNIN001', 'floor mat', 'IN'),
    true,
  )
})

test('legacy own tracked_asin overlap never appears as keyword competitor candidate', () => {
  const competitors = filterKeywordCompetitorCandidates(
    [
      { id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' },
      { id: 'tracked-external', asin: 'B0EXTERN1', marketplace: 'IN', status: 'active' },
    ],
    [ownListing],
  )

  assert.deepEqual(competitors.map(row => row.id), ['tracked-external'])
})

test('same ASIN in different marketplace remains distinct', () => {
  const competitors = filterKeywordCompetitorCandidates(
    [{ id: 'tracked-us', asin: 'B0OWNIN001', marketplace: 'US', status: 'active' }],
    [ownListing],
  )

  assert.equal(competitors.length, 1)
  assert.equal(keywordTargetKey('competitor_asin', 'tracked-us', 'US'), 'competitor_asin:US:TRACKED-US')
})

test('keyword source from listing uses ASIN rather than a seller listing id', () => {
  const source = keywordSourceFromListing(ownListing)

  assert.equal(source?.targetType, 'my_product')
  assert.equal(source?.sourceId, 'B0OWNIN001')
  assert.equal(source?.asin, 'B0OWNIN001')
  assert.equal(source?.marketplace, 'IN')
})

test('keyword snapshots keep tracked_keyword_id identity and only store tracked_asin_id for competitors', () => {
  assert.deepEqual(
    snapshotTargetForKeyword({ own_asin: 'B0OWNIN001', tracked_asin_id: null }),
    { tracked_asin_id: null },
  )
  assert.deepEqual(
    snapshotTargetForKeyword({ own_asin: null, tracked_asin_id: 'tracked-external' }),
    { tracked_asin_id: 'tracked-external' },
  )
})

test('multiple seller SKUs produce one own ASIN rank target', () => {
  const sources = buildKeywordOwnAsinSources([
    ownListing,
    { ...ownListing, id: 'listing-in-2', sku: 'OWN-IN-2', item_name: 'Own mat second SKU' },
  ])

  assert.equal(sources.length, 1)
  assert.equal(sources[0].sourceId, 'B0OWNIN001')
})

test('the same ASIN in different marketplaces remains a distinct own target', () => {
  const sources = buildKeywordOwnAsinSources([
    ownListing,
    { ...ownListing, id: 'listing-us', marketplace_id: 'ATVPDKIKX0DER' },
  ])

  assert.equal(sources.length, 2)
  assert.notEqual(
    keywordTargetKey('my_product', sources[0].sourceId, sources[0].marketplace),
    keywordTargetKey('my_product', sources[1].sourceId, sources[1].marketplace),
  )
})

test('migration preserves keyword and snapshot identity without arbitrary listing binding', () => {
  const migration = readFileSync(
    new URL('../../../supabase/migrations/069_keywords_product_separation.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /ADD COLUMN IF NOT EXISTS own_asin text/)
  assert.match(migration, /EXISTS \([\s\S]*FROM public\.amazon_listing_items/)
  assert.doesNotMatch(migration, /amazon_listing_item_id|MIN\s*\(|DELETE FROM public\.tracked_keywords/i)
  assert.doesNotMatch(migration, /UPDATE public\.keyword_rank_snapshots|DELETE FROM public\.keyword_rank_snapshots/i)
})

test('own refresh resolves directly to ASIN with no tracked_asin reference', () => {
  const target = resolveKeywordRefreshTarget(
    { own_asin: 'B0OWNIN001', tracked_asin_id: null, marketplace: 'IN' },
    new Map(),
    new Set([keywordTargetKey('my_product', 'B0OWNIN001', 'IN')]),
  )

  assert.deepEqual(target, { asin: 'B0OWNIN001', marketplace: 'IN', trackedAsinId: null })
})

test('competitor refresh resolves only when the ASIN is outside the own catalog', () => {
  const target = resolveKeywordRefreshTarget(
    { own_asin: null, tracked_asin_id: 'tracked-external', marketplace: 'IN' },
    new Map([['tracked-external', { asin: 'B0EXTERN1', marketplace: 'IN' }]]),
    new Set(),
  )

  assert.deepEqual(target, {
    asin: 'B0EXTERN1', marketplace: 'IN', trackedAsinId: 'tracked-external',
  })
})

test('catalog classification unavailable fails closed for refresh targets', () => {
  const target = resolveKeywordRefreshTarget(
    { own_asin: null, tracked_asin_id: 'tracked-external', marketplace: 'IN' },
    new Map([['tracked-external', { asin: 'B0EXTERN1', marketplace: 'IN' }]]),
    null,
  )

  assert.equal(target, null)
})

test('unmatched legacy tracked_asin reference cannot become a refresh target', () => {
  const target = resolveKeywordRefreshTarget(
    { own_asin: null, tracked_asin_id: 'missing-tracked-row', marketplace: 'IN' },
    new Map(),
    new Set(),
  )

  assert.equal(target, null)
})

test('own-catalog overlap cannot refresh as a competitor', () => {
  const target = resolveKeywordRefreshTarget(
    { own_asin: null, tracked_asin_id: 'tracked-own', marketplace: 'IN' },
    new Map([['tracked-own', { asin: 'B0OWNIN001', marketplace: 'IN' }]]),
    new Set([keywordTargetKey('my_product', 'B0OWNIN001', 'IN')]),
  )

  assert.equal(target, null)
})

test('checker_unavailable is never classified as a legitimate keyword rank result', () => {
  assert.equal(
    classifyKeywordFound({ scrape_status: 'checker_unavailable', found: false }),
    'check_unavailable',
  )
  assert.equal(
    classifyKeywordFound({ scrape_status: 'checker_unavailable', found: true }),
    'check_unavailable',
  )
})
