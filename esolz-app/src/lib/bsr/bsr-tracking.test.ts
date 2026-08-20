import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBsrTargetView,
  filterBsrCompetitorCandidates,
  hasDuplicateBsrTarget,
  rankMetricsForTarget,
  resolveBsrCandidateRows,
  resolveBsrSnapshotRows,
  snapshotsForTarget,
  summarizeBsrTargets,
  targetKey,
  trackingTargetType,
  untrackBsrTargetPatch,
  type BsrSnapshotRow,
  type BsrSourceProduct,
  type BsrTrackingTargetRow,
  type BsrTargetView,
} from './bsr-tracking'

const ownListing = {
  id: 'listing-in',
  asin: 'B0OWNIN001',
  marketplace_id: 'A21TJRUUN4KGV',
}

const ownSource: BsrSourceProduct = {
  targetType: 'my_product',
  sourceId: 'listing-in',
  asin: 'B0OWNIN001',
  marketplace: 'IN',
  label: 'Own mat',
  sku: 'OWN-IN',
}

const competitorSource: BsrSourceProduct = {
  targetType: 'competitor_asin',
  sourceId: 'tracked-external',
  asin: 'B0EXTERN1',
  marketplace: 'IN',
  label: 'External competitor',
}

function snapshot(overrides: Partial<BsrSnapshotRow>): BsrSnapshotRow {
  return {
    amazon_listing_item_id: null,
    tracked_asin_id: null,
    bsr: null,
    bsr_category: null,
    bsr_ranks: null,
    scrape_status: 'success',
    checked_at: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

function target(overrides: Partial<BsrTrackingTargetRow>): BsrTrackingTargetRow {
  return {
    id: 'target-1',
    workspace_id: 'workspace-1',
    amazon_listing_item_id: null,
    tracked_asin_id: null,
    status: 'active',
    ...overrides,
  }
}

function view(overrides: Partial<BsrTargetView>): BsrTargetView {
  return {
    ...ownSource,
    trackingTargetId: 'target-1',
    currentRank: null,
    previousRank: null,
    movement: null,
    category: null,
    subcategory: null,
    subcategoryRank: null,
    lastCheckedAt: null,
    rankCapturedAt: null,
    latestStatus: null,
    ...overrides,
  }
}

test('My Product BSR target resolves history using amazon_listing_item_id', () => {
  const rows = snapshotsForTarget(
    [
      snapshot({ amazon_listing_item_id: 'listing-in', bsr: 100 }),
      snapshot({ tracked_asin_id: 'listing-in', bsr: 999 }),
    ],
    'my_product',
    'listing-in',
  )

  assert.equal(rows.length, 1)
  assert.equal(rows[0].bsr, 100)
})

test('competitor BSR target resolves history using tracked_asin_id', () => {
  const rows = snapshotsForTarget(
    [
      snapshot({ tracked_asin_id: 'tracked-external', bsr: 220 }),
      snapshot({ amazon_listing_item_id: 'tracked-external', bsr: 999 }),
    ],
    'competitor_asin',
    'tracked-external',
  )

  assert.equal(rows.length, 1)
  assert.equal(rows[0].bsr, 220)
})

test('own product never becomes a competitor BSR candidate through legacy tracked_asins overlap', () => {
  const competitors = filterBsrCompetitorCandidates(
    [
      { id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' },
      { id: 'tracked-external', asin: 'B0EXTERN1', marketplace: 'IN', status: 'active' },
    ],
    [ownListing],
  )

  assert.deepEqual(competitors.map(row => row.id), ['tracked-external'])
})

test('catalog read unavailable fails closed and returns no competitor candidates', () => {
  const result = resolveBsrCandidateRows({
    listings: [],
    trackedAsins: [
      { id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' },
      { id: 'tracked-external', asin: 'B0EXTERN1', marketplace: 'IN', status: 'active' },
    ],
    catalogUnavailable: true,
    trackedUnavailable: false,
  })

  assert.equal(result.catalogUnavailable, true)
  assert.deepEqual(result.myRows, [])
  assert.deepEqual(result.competitorRows, [])
})

test('tracked-ASIN read unavailable fails closed and returns no competitor candidates', () => {
  const result = resolveBsrCandidateRows({
    listings: [ownListing],
    trackedAsins: [],
    catalogUnavailable: false,
    trackedUnavailable: true,
  })

  assert.equal(result.trackedUnavailable, true)
  assert.deepEqual(result.myRows, [ownListing])
  assert.deepEqual(result.competitorRows, [])
})

test('successful catalog and tracked reads preserve normal competitor filtering', () => {
  const result = resolveBsrCandidateRows({
    listings: [ownListing],
    trackedAsins: [
      { id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' },
      { id: 'tracked-external', asin: 'B0EXTERN1', marketplace: 'IN', status: 'active' },
    ],
    catalogUnavailable: false,
    trackedUnavailable: false,
  })

  assert.deepEqual(result.myRows, [ownListing])
  assert.deepEqual(result.competitorRows.map(row => row.id), ['tracked-external'])
})

test('snapshot read unavailable is distinct from a successful empty snapshot result', () => {
  const unavailable = resolveBsrSnapshotRows({
    snapshots: [snapshot({ amazon_listing_item_id: 'listing-in', bsr: 100 })],
    unavailable: true,
  })
  const empty = resolveBsrSnapshotRows({
    snapshots: [],
    unavailable: false,
  })

  assert.equal(unavailable.unavailable, true)
  assert.deepEqual(unavailable.snapshots, [])
  assert.equal(empty.unavailable, false)
  assert.deepEqual(empty.snapshots, [])
})

test('same ASIN in a different marketplace remains distinct', () => {
  const competitors = filterBsrCompetitorCandidates(
    [
      { id: 'tracked-us', asin: 'B0OWNIN001', marketplace: 'US', status: 'active' },
    ],
    [ownListing],
  )

  assert.equal(competitors.length, 1)
  assert.equal(targetKey('competitor_asin', 'tracked-us'), 'competitor_asin:tracked-us')
})

test('duplicate active BSR tracking target is prevented by source identity', () => {
  assert.equal(
    hasDuplicateBsrTarget(
      [target({ amazon_listing_item_id: 'listing-in' })],
      'my_product',
      'listing-in',
    ),
    true,
  )
})

test('removed BSR tracking target does not block re-tracking', () => {
  assert.equal(
    hasDuplicateBsrTarget(
      [target({ amazon_listing_item_id: 'listing-in', status: 'removed' })],
      'my_product',
      'listing-in',
    ),
    false,
  )
})

test('untracking BSR only creates a configuration patch and does not archive/delete source ASINs', () => {
  const patch = untrackBsrTargetPatch('2026-08-19T00:00:00.000Z')

  assert.deepEqual(Object.keys(patch).sort(), ['removed_at', 'status'])
  assert.equal(patch.status, 'removed')
})

test('current rank is the latest non-null BSR, preserving rank across a newer null check', () => {
  const metrics = rankMetricsForTarget(
    [
      snapshot({ amazon_listing_item_id: 'listing-in', bsr: null, scrape_status: 'partial_catalog_unavailable', checked_at: '2026-08-19T00:00:00.000Z' }),
      snapshot({ amazon_listing_item_id: 'listing-in', bsr: 250, checked_at: '2026-08-18T00:00:00.000Z' }),
    ],
    'my_product',
    'listing-in',
  )

  assert.equal(metrics.currentRank, 250)
  assert.equal(metrics.lastCheckedAt, '2026-08-19T00:00:00.000Z')
  assert.equal(metrics.rankCapturedAt, '2026-08-18T00:00:00.000Z')
})

test('previous rank is the second latest non-null BSR', () => {
  const metrics = rankMetricsForTarget(
    [
      snapshot({ tracked_asin_id: 'tracked-external', bsr: 300, checked_at: '2026-08-19T00:00:00.000Z' }),
      snapshot({ tracked_asin_id: 'tracked-external', bsr: null, checked_at: '2026-08-18T12:00:00.000Z' }),
      snapshot({ tracked_asin_id: 'tracked-external', bsr: 450, checked_at: '2026-08-18T00:00:00.000Z' }),
    ],
    'competitor_asin',
    'tracked-external',
  )

  assert.equal(metrics.currentRank, 300)
  assert.equal(metrics.previousRank, 450)
})

test('movement sign is positive when the current rank is lower and therefore improved', () => {
  const metrics = rankMetricsForTarget(
    [
      snapshot({ amazon_listing_item_id: 'listing-in', bsr: 178, checked_at: '2026-08-19T00:00:00.000Z' }),
      snapshot({ amazon_listing_item_id: 'listing-in', bsr: 250, checked_at: '2026-08-18T00:00:00.000Z' }),
    ],
    'my_product',
    'listing-in',
  )

  assert.equal(metrics.movement, 72)
})

test('BSR category uses snapshot bsr_category, not listing product type', () => {
  const targetView = buildBsrTargetView(
    { ...ownSource, label: 'Catalog product type should not win' },
    'target-1',
    [
      snapshot({
        amazon_listing_item_id: 'listing-in',
        bsr: 27673,
        bsr_category: 'Home & Kitchen',
      }),
    ],
  )

  assert.equal(targetView.category, 'Home & Kitchen')
})

test('classification sub-rank uses bsr_ranks when available', () => {
  const metrics = rankMetricsForTarget(
    [
      snapshot({
        amazon_listing_item_id: 'listing-in',
        bsr: 27673,
        bsr_category: 'Home & Kitchen',
        bsr_ranks: [
          { category: 'Home & Kitchen', rank: 27673, rank_type: 'display_group' },
          { category: 'Place Mats', rank: 178, rank_type: 'classification' },
        ],
      }),
    ],
    'my_product',
    'listing-in',
  )

  assert.equal(metrics.subcategory, 'Place Mats')
  assert.equal(metrics.subcategoryRank, 178)
})

test('My/Competitor KPI aggregation remains isolated by caller-provided domain', () => {
  const mySummary = summarizeBsrTargets([
    view({ targetType: 'my_product', sourceId: 'listing-in', currentRank: 100, previousRank: 120, movement: 20 }),
  ])
  const competitorSummary = summarizeBsrTargets([
    view({ ...competitorSource, trackingTargetId: 'target-2', currentRank: 900, previousRank: 800, movement: -100 }),
  ])

  assert.equal(mySummary.totalTargets, 1)
  assert.equal(mySummary.improvingCount, 1)
  assert.equal(mySummary.decliningCount, 0)
  assert.equal(competitorSummary.totalTargets, 1)
  assert.equal(competitorSummary.improvingCount, 0)
  assert.equal(competitorSummary.decliningCount, 1)
})

test('tracking target identity accepts exactly one source reference', () => {
  assert.equal(trackingTargetType(target({ amazon_listing_item_id: 'listing-in' })), 'my_product')
  assert.equal(trackingTargetType(target({ tracked_asin_id: 'tracked-external' })), 'competitor_asin')
  assert.equal(trackingTargetType(target({ amazon_listing_item_id: 'listing-in', tracked_asin_id: 'tracked-external' })), null)
  assert.equal(trackingTargetType(target({})), null)
})
