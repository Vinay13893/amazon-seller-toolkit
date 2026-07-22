/**
 * Correction 1 (PR #55 review round): covers the required P0-B test
 * scenarios "confirmed Other Product enrollment succeeds" and "mixed bulk
 * request rejects completely when one lookup fails" against
 * `confirmAsinsWithLookup`'s pure core, via a fake `lookupAsin` function --
 * no real network/SP-API/database call anywhere in this file.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { confirmAsinsWithLookup, mapWithConcurrency, type AsinLookupOutcome } from '../other-product-confirmation'

describe('confirmAsinsWithLookup', () => {
  test('all ASINs confirmed -> outcome confirmed, with each ASIN\'s Amazon-sourced metadata', async () => {
    const result = await confirmAsinsWithLookup(['B000000001', 'B000000002'], async asin => ({
      ok: true,
      metadata: { title: `Title for ${asin}`, brand: 'Acme', imageUrl: null },
    }))
    assert.equal(result.outcome, 'confirmed')
    if (result.outcome === 'confirmed') {
      assert.equal(result.confirmed.size, 2)
      assert.equal(result.confirmed.get('B000000001')?.title, 'Title for B000000001')
    }
  })

  test('one ASIN unconfirmed among several confirmed -> the WHOLE batch is rejected, never a partial confirmed set', async () => {
    const result = await confirmAsinsWithLookup(['B000000001', 'B000000002', 'B000000003'], async asin => {
      if (asin === 'B000000002') return { ok: false, reason: 'not_found' }
      return { ok: true, metadata: { title: 'ok', brand: null, imageUrl: null } }
    })
    assert.equal(result.outcome, 'rejected')
    if (result.outcome === 'rejected') {
      assert.equal(result.failures.length, 1)
      assert.equal(result.failures[0].asin, 'B000000002')
      assert.equal(result.failures[0].reason, 'not_found')
    }
  })

  test('multiple failures are all reported, not just the first', async () => {
    const result = await confirmAsinsWithLookup(['B000000001', 'B000000002'], async asin =>
      asin === 'B000000001' ? { ok: false, reason: 'timeout' } : { ok: false, reason: 'unavailable' },
    )
    assert.equal(result.outcome, 'rejected')
    if (result.outcome === 'rejected') {
      assert.equal(result.failures.length, 2)
      const reasons = new Set(result.failures.map(f => f.reason))
      assert.ok(reasons.has('timeout') && reasons.has('unavailable'))
    }
  })

  test('an empty ASIN list never calls the lookup function', async () => {
    let calls = 0
    const result = await confirmAsinsWithLookup([], async () => {
      calls += 1
      return { ok: true, metadata: { title: null, brand: null, imageUrl: null } } as AsinLookupOutcome
    })
    assert.equal(calls, 0)
    assert.equal(result.outcome, 'confirmed')
  })
})

describe('mapWithConcurrency', () => {
  test('never runs more than `limit` calls concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrency(items, 3, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
    })
    assert.ok(maxInFlight <= 3, `expected at most 3 concurrent calls, observed ${maxInFlight}`)
  })

  test('processes every item exactly once, preserving result order by input index', async () => {
    const results = await mapWithConcurrency([5, 1, 3], 2, async n => n * 10)
    assert.deepEqual(results, [50, 10, 30])
  })
})
