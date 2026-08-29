import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterKeywordCompetitorCandidates,
  hasDuplicateKeywordForTarget,
  keywordSourceFromListing,
  keywordTargetKey,
  keywordTargetType,
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

test('own catalog keyword target resolves from amazon_listing_item_id', () => {
  assert.equal(
    keywordTargetType({ amazon_listing_item_id: 'listing-in', tracked_asin_id: null }),
    'my_product',
  )
})

test('competitor keyword target resolves from tracked_asin_id', () => {
  assert.equal(
    keywordTargetType({ amazon_listing_item_id: null, tracked_asin_id: 'tracked-external' }),
    'competitor_asin',
  )
})

test('keyword target with both product refs is invalid', () => {
  assert.equal(
    keywordTargetType({ amazon_listing_item_id: 'listing-in', tracked_asin_id: 'tracked-external' }),
    null,
  )
})

test('legacy unassigned keyword remains unbound', () => {
  assert.equal(keywordTargetType({ amazon_listing_item_id: null, tracked_asin_id: null }), null)
})

test('same keyword can exist on two different own products', () => {
  const rows: KeywordTrackingRow[] = [{
    amazon_listing_item_id: 'listing-one',
    tracked_asin_id: null,
    keyword: 'floor mat',
    marketplace: 'IN',
  }]

  assert.equal(
    hasDuplicateKeywordForTarget(rows, 'my_product', 'listing-two', 'floor mat', 'IN'),
    false,
  )
})

test('duplicate keyword on same own product is prevented', () => {
  const rows: KeywordTrackingRow[] = [{
    amazon_listing_item_id: 'listing-one',
    tracked_asin_id: null,
    keyword: 'Floor Mat',
    marketplace: 'IN',
  }]

  assert.equal(
    hasDuplicateKeywordForTarget(rows, 'my_product', 'listing-one', 'floor mat', 'IN'),
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
  assert.equal(keywordTargetKey('competitor_asin', 'tracked-us'), 'competitor_asin:tracked-us')
})

test('keyword source from listing uses stable catalog id', () => {
  const source = keywordSourceFromListing(ownListing)

  assert.equal(source?.targetType, 'my_product')
  assert.equal(source?.sourceId, 'listing-in')
  assert.equal(source?.asin, 'B0OWNIN001')
  assert.equal(source?.marketplace, 'IN')
})

test('keyword snapshots keep tracked_keyword_id identity and only store tracked_asin_id for competitors', () => {
  assert.deepEqual(
    snapshotTargetForKeyword({ amazon_listing_item_id: 'listing-in', tracked_asin_id: null }),
    { tracked_asin_id: null },
  )
  assert.deepEqual(
    snapshotTargetForKeyword({ amazon_listing_item_id: null, tracked_asin_id: 'tracked-external' }),
    { tracked_asin_id: 'tracked-external' },
  )
})
