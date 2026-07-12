/**
 * Targeted tests for the Buy Box status masking fix (BRAHMASTRA_MASTER_TRACKER.md
 * sec19): src/app/api/asins/jobs/process-next/route.ts's
 * resolveBuyBoxStatusToStore() (write path) and
 * src/app/api/asins/listings/route.ts's findConfirmedBuyBoxSnapshot() /
 * buyBoxStatusLabel() / findPriceSnapshot() / findBsrSnapshot() (read path).
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-buy-box-status-fix.ts
 */
import assert from 'node:assert/strict'
import { resolveBuyBoxStatusToStore } from '../src/lib/amazon/buy-box-status'
import {
  findConfirmedBuyBoxSnapshot,
  findPriceSnapshot,
  findBsrSnapshot,
  findPricingSnapshot,
  buyBoxStatusLabel,
  type ListingSnapshotRow,
} from '../src/app/api/asins/listings/route'

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

function row(overrides: Partial<ListingSnapshotRow> & { checked_at: string }): ListingSnapshotRow {
  return {
    amazon_listing_item_id: 'listing-1',
    price: null,
    bsr: null,
    buy_box_owner: null,
    buy_box_status: null,
    availability_score: null,
    scrape_status: null,
    ...overrides,
  }
}

// ── Write path: resolveBuyBoxStatusToStore ───────────────────────────────────

test('rate-limited/unavailable pricing (no offers result) stores null, not "unknown"', () => {
  assert.equal(resolveBuyBoxStatusToStore(undefined), null)
  assert.equal(resolveBuyBoxStatusToStore(null), null)
})

test('won/lost from a real Pricing call still store correctly', () => {
  assert.equal(resolveBuyBoxStatusToStore('won'), 'won')
  assert.equal(resolveBuyBoxStatusToStore('lost'), 'lost')
})

test('a genuine ambiguous result from a successful call is preserved as-is (not over-nulled)', () => {
  // This is the narrow distinction the fix makes: only "no call happened at
  // all" (undefined) becomes null. A real call that itself classified as
  // 'unknown' or 'no_buybox' is still real data and is stored unchanged.
  assert.equal(resolveBuyBoxStatusToStore('unknown'), 'unknown')
  assert.equal(resolveBuyBoxStatusToStore('no_buybox'), 'no_buybox')
  assert.equal(resolveBuyBoxStatusToStore('partial_success'), 'partial_success')
})

// ── Read path: findConfirmedBuyBoxSnapshot ───────────────────────────────────

test('a newer null/unknown snapshot does not mask an older confirmed won/lost snapshot', () => {
  // Newest-first, matching how listings/route.ts sorts before calling these finders.
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: null, scrape_status: 'partial_pricing_rate_limited' }),
    row({ checked_at: '2026-07-10T00:00:00Z', buy_box_status: 'unknown', scrape_status: 'success' }),
    row({ checked_at: '2026-07-01T00:00:00Z', buy_box_status: 'won', buy_box_owner: 'A2SELLERID', scrape_status: 'success' }),
  ]
  const confirmed = findConfirmedBuyBoxSnapshot(snapshots)
  assert.ok(confirmed, 'must find the older confirmed snapshot')
  assert.equal(confirmed!.buy_box_status, 'won')
  assert.equal(confirmed!.checked_at, '2026-07-01T00:00:00Z', 'must return the confirmed snapshot, not the newer null/unknown one')
  assert.equal(confirmed!.buy_box_owner, 'A2SELLERID')
})

test('no_buybox and partial_success are not treated as confirmed (only won/lost count)', () => {
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: 'no_buybox' }),
    row({ checked_at: '2026-07-11T00:00:00Z', buy_box_status: 'partial_success' }),
  ]
  assert.equal(findConfirmedBuyBoxSnapshot(snapshots), null)
})

test('no confirmed history anywhere returns null, and the label is "Not confirmed" (never inferred as Lost)', () => {
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: null }),
    row({ checked_at: '2026-07-11T00:00:00Z', buy_box_status: 'unknown' }),
  ]
  const confirmed = findConfirmedBuyBoxSnapshot(snapshots)
  assert.equal(confirmed, null)
  const latest = snapshots[0]
  assert.equal(buyBoxStatusLabel(latest, confirmed), 'Not confirmed')
})

test('no snapshot at all ("Not checked yet") is distinct from "Not confirmed"', () => {
  assert.equal(buyBoxStatusLabel(null, null), 'Not checked yet')
})

// ── Display behavior: fresh vs stale confirmed result ─────────────────────────

test('a fresh confirmed result (latest check) shows plain Won/Lost', () => {
  const wonRow = row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: 'won' })
  assert.equal(buyBoxStatusLabel(wonRow, wonRow), 'Won')

  const lostRow = row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: 'lost' })
  assert.equal(buyBoxStatusLabel(lostRow, lostRow), 'Lost')
})

test('an older confirmed result (not the latest check) shows "last confirmed ... ago"', () => {
  const latest = row({ checked_at: new Date().toISOString(), buy_box_status: null })
  const confirmed = row({ checked_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), buy_box_status: 'won' })
  const label = buyBoxStatusLabel(latest, confirmed)
  assert.ok(label.startsWith('Won'), `expected label to start with "Won", got: ${label}`)
  assert.ok(label.includes('last confirmed'), `expected "last confirmed" phrasing, got: ${label}`)
})

// ── Timestamp matches the confirmed snapshot selected ─────────────────────────

test('the returned confirmed snapshot\'s checked_at exactly matches the row that was actually selected', () => {
  const targetTimestamp = '2026-06-15T09:30:00Z'
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', buy_box_status: null }),
    row({ checked_at: targetTimestamp, buy_box_status: 'lost', buy_box_owner: 'A3OTHERSELLER' }),
    row({ checked_at: '2026-06-01T00:00:00Z', buy_box_status: 'won' }), // older still-confirmed row, must NOT be selected
  ]
  const confirmed = findConfirmedBuyBoxSnapshot(snapshots)
  assert.equal(confirmed!.checked_at, targetTimestamp, 'must select the MOST RECENT confirmed snapshot, not just any confirmed one')
})

// ── Price and BSR coalescing unchanged ────────────────────────────────────────

test('Price coalescing is unaffected by buy_box_status changes', () => {
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', price: null, buy_box_status: null }),
    row({ checked_at: '2026-07-05T00:00:00Z', price: 499, buy_box_status: 'unknown' }),
  ]
  const priceSnapshot = findPriceSnapshot(snapshots)
  assert.equal(priceSnapshot?.price, 499)
  assert.equal(priceSnapshot?.checked_at, '2026-07-05T00:00:00Z')
})

test('BSR coalescing is unaffected by buy_box_status changes', () => {
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', bsr: null }),
    row({ checked_at: '2026-07-11T00:00:00Z', bsr: 12345 }),
  ]
  const bsrSnapshot = findBsrSnapshot(snapshots)
  assert.equal(bsrSnapshot?.bsr, 12345)
})

test('Availability\'s broader pricingSnapshot lookup is unchanged (still matches on availability_score alone)', () => {
  const snapshots: ListingSnapshotRow[] = [
    row({ checked_at: '2026-07-12T00:00:00Z', availability_score: 50, buy_box_status: null }),
  ]
  // This is the pre-existing, untouched behavior this fix must not alter:
  // pricingSnapshot still matches a row with only availability_score set.
  const pricingSnapshot = findPricingSnapshot(snapshots)
  assert.ok(pricingSnapshot, 'availability lookup must remain unchanged by this fix')
  assert.equal(pricingSnapshot?.availability_score, 50)
})

async function main() {
  let failures = 0
  for (const [name, fn] of tests) {
    try {
      fn()
      console.log(`PASS  ${name}`)
    } catch (err) {
      failures += 1
      console.error(`FAIL  ${name}`)
      console.error(err instanceof Error ? err.message : err)
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`)
  if (failures > 0) process.exit(1)
}

void main()
