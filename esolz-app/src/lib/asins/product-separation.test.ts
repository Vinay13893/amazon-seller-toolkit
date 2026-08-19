import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAsinCheckerJobCandidates,
  filterCompetitorTrackedAsins,
  type OwnCatalogListingIdentity,
  type TrackedAsinIdentity,
} from './product-separation'
import {
  addOrRestoreCompetitorAsin,
  filterCompetitorProductSnapshots,
  type AddAsinInput,
} from '@/lib/supabase/asins'
import type { ProductSnapshot } from '@/types'

const WORKSPACE_ID = 'workspace-1'
const JOB_TYPE = 'product_page_snapshot'

const ownInListing: OwnCatalogListingIdentity = {
  id: 'listing-own-in',
  asin: 'B0OWNIN001',
  marketplace_id: 'A21TJRUUN4KGV',
}

const externalTracked: TrackedAsinIdentity = {
  id: 'tracked-external',
  asin: 'B0EXTERNAL',
  marketplace: 'IN',
  status: 'active',
}

function buildCandidates(listings: OwnCatalogListingIdentity[], trackedAsins: TrackedAsinIdentity[]) {
  return buildAsinCheckerJobCandidates({
    workspaceId: WORKSPACE_ID,
    jobType: JOB_TYPE,
    listings,
    trackedAsins,
    activeJobs: [],
    remainingMyProducts: 100,
    remainingCompetitors: 100,
    forceRefresh: false,
    nowMs: Date.parse('2026-08-19T00:00:00.000Z'),
    cadenceHours: 24,
    pricingCooldownRetryMinutes: 240,
    rateLimitReasons: new Set(['amazon_pricing_rate_limited']),
    defaultMarketplaceId: 'A21TJRUUN4KGV',
  })
}

test('own catalog ASIN is excluded from competitor list', () => {
  const competitors = filterCompetitorTrackedAsins(
    [{ id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' }],
    [ownInListing],
  )

  assert.deepEqual(competitors, [])
})

test('external tracked ASIN remains a competitor', () => {
  const competitors = filterCompetitorTrackedAsins([externalTracked], [ownInListing])

  assert.equal(competitors.length, 1)
  assert.equal(competitors[0].id, 'tracked-external')
})

test('same ASIN in another marketplace is not falsely excluded', () => {
  const competitors = filterCompetitorTrackedAsins(
    [{ id: 'tracked-own-us', asin: 'B0OWNIN001', marketplace: 'US', status: 'active' }],
    [ownInListing],
  )

  assert.equal(competitors.length, 1)
  assert.equal(competitors[0].id, 'tracked-own-us')
})

test('archived tracked ASIN remains excluded', () => {
  const competitors = filterCompetitorTrackedAsins(
    [{ id: 'tracked-archived', asin: 'B0ARCHIVED', marketplace: 'IN', status: 'archived' }],
    [],
  )

  assert.deepEqual(competitors, [])
})

test('own catalog products remain eligible as my_product background jobs', () => {
  const result = buildCandidates([ownInListing], [])

  assert.equal(result.totalActiveMyProducts, 1)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].target_type, 'my_product')
  assert.equal(result.candidates[0].target_id, 'listing-own-in')
})

test('own catalog overlap does not also create a competitor_asin job', () => {
  const result = buildCandidates(
    [ownInListing],
    [{ id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' }],
  )

  assert.equal(result.totalActiveCompetitors, 0)
  assert.equal(result.candidates.filter(candidate => candidate.target_type === 'competitor_asin').length, 0)
})

test('external competitor creates a competitor_asin job', () => {
  const result = buildCandidates([ownInListing], [externalTracked])
  const competitorJobs = result.candidates.filter(candidate => candidate.target_type === 'competitor_asin')

  assert.equal(result.totalActiveCompetitors, 1)
  assert.equal(competitorJobs.length, 1)
  assert.equal(competitorJobs[0].target_id, 'tracked-external')
  assert.equal(competitorJobs[0].marketplace_id, 'A21TJRUUN4KGV')
})

type FakeRow = {
  id: string
  workspace_id: string
  asin: string
  marketplace?: string
  marketplace_id?: string
  product_title?: string | null
  brand?: string | null
  category?: string | null
  image_url?: string | null
  status?: string
  created_at?: string
}

function makeFakeSupabase(rowsByTable: Record<string, FakeRow[]>) {
  return {
    from(table: string) {
      let mode: 'select' | 'update' | 'insert' = 'select'
      let patch: Partial<FakeRow> = {}
      const filters: Array<[string, unknown]> = []
      const rows = rowsByTable[table] ?? []

      const builder = {
        select(cols: string) {
          void cols
          return builder
        },
        eq(col: string, val: unknown) {
          filters.push([col, val])
          return builder
        },
        limit(count: number) {
          void count
          return builder
        },
        update(nextPatch: Partial<FakeRow>) {
          mode = 'update'
          patch = nextPatch
          return builder
        },
        insert(nextPatch: Partial<FakeRow>) {
          mode = 'insert'
          patch = nextPatch
          return builder
        },
        async maybeSingle() {
          const match = rows.find(row => filters.every(([col, val]) => row[col as keyof FakeRow] === val))
          return { data: match ?? null, error: null }
        },
        async single() {
          if (mode === 'update') {
            const match = rows.find(row => filters.every(([col, val]) => row[col as keyof FakeRow] === val))
            if (!match) return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
            Object.assign(match, patch)
            return { data: match, error: null }
          }

          if (mode === 'insert') {
            const row: FakeRow = {
              id: `tracked-${rows.length + 1}`,
              workspace_id: String(patch.workspace_id),
              asin: String(patch.asin),
              marketplace: String(patch.marketplace),
              product_title: String(patch.product_title),
              brand: (patch.brand as string | null) ?? null,
              category: (patch.category as string | null) ?? null,
              image_url: (patch.image_url as string | null) ?? null,
              status: 'active',
              created_at: '2026-08-19T00:00:00.000Z',
            }
            rows.push(row)
            return { data: row, error: null }
          }

          return { data: null, error: { code: 'UNSUPPORTED', message: 'single() called in select mode' } }
        },
      }

      return builder
    },
  } as never
}

const addInput: AddAsinInput = {
  asin: 'B0OWNIN001',
  productTitle: 'Own product',
  marketplace: 'IN',
  brand: '',
  category: '',
  imageUrl: '',
}

test('add-competitor path refuses an own catalog ASIN', async () => {
  const supabase = makeFakeSupabase({
    amazon_listing_items: [{
      id: 'listing-own-in',
      workspace_id: WORKSPACE_ID,
      asin: 'B0OWNIN001',
      marketplace_id: 'A21TJRUUN4KGV',
    }],
    tracked_asins: [],
  })

  const result = await addOrRestoreCompetitorAsin(WORKSPACE_ID, addInput, supabase)

  assert.equal(result.outcome, 'own_product')
  assert.match(result.message, /belongs to My Products/)
})

test('add-competitor path refuses an ASIN when multiple own SKUs share the same ASIN', async () => {
  const supabase = makeFakeSupabase({
    amazon_listing_items: [
      {
        id: 'listing-own-in-1',
        workspace_id: WORKSPACE_ID,
        asin: 'B0OWNIN001',
        marketplace_id: 'A21TJRUUN4KGV',
      },
      {
        id: 'listing-own-in-2',
        workspace_id: WORKSPACE_ID,
        asin: 'B0OWNIN001',
        marketplace_id: 'A21TJRUUN4KGV',
      },
    ],
    tracked_asins: [],
  })

  const result = await addOrRestoreCompetitorAsin(WORKSPACE_ID, addInput, supabase)

  assert.equal(result.outcome, 'own_product')
})

test('catalog classification unavailable fails closed and returns no confirmed competitors', () => {
  const competitors = filterCompetitorProductSnapshots(
    [
      productSnapshot({ id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN' }),
      productSnapshot({ id: 'tracked-external', asin: 'B0EXTERNAL', marketplace: 'IN' }),
    ],
    null,
  )

  assert.deepEqual(competitors, [])
})

test('competitor quota/count uses competitors only', () => {
  const competitors = filterCompetitorTrackedAsins(
    [
      { id: 'tracked-own', asin: 'B0OWNIN001', marketplace: 'IN', status: 'active' },
      externalTracked,
      { id: 'tracked-archived', asin: 'B0ARCHIVED', marketplace: 'IN', status: 'archived' },
    ],
    [ownInListing],
  )

  assert.equal(competitors.length, 1)
  assert.equal(competitors[0].id, 'tracked-external')
})

function productSnapshot(overrides: Partial<ProductSnapshot>): ProductSnapshot {
  return {
    id: 'tracked-default',
    asin: 'B0DEFAULT',
    label: 'Default product',
    marketplace: 'IN',
    is_active: true,
    created_at: '2026-08-19T00:00:00.000Z',
    bsr_rank: null,
    bsr_rank_prev: null,
    category: null,
    sub_rank: null,
    sub_category: null,
    price: null,
    price_currency: 'INR',
    rating: null,
    review_count: null,
    buybox_winner: null,
    buybox_is_self: null,
    availability: null,
    availability_score: null,
    scrape_status: null,
    captured_at: null,
    ...overrides,
  }
}
