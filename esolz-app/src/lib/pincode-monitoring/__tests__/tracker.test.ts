/**
 * Covers PRODUCT_SPEC.md sec8's five-state availability vocabulary and
 * sec7's derived product-tracker-state table -- the "unknown/failed/blocked
 * status preservation" requirement: unknown must never collapse into
 * unavailable, failed must never collapse into unavailable, blocked must
 * render distinctly from check_failed.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAvailabilityState, deriveProductTrackerState, deriveFreshnessState } from '../tracker'

describe('deriveAvailabilityState', () => {
  test('success + available -> available', () => {
    assert.equal(deriveAvailabilityState('success', 'available'), 'available')
  })
  test('success + unavailable -> unavailable', () => {
    assert.equal(deriveAvailabilityState('success', 'unavailable'), 'unavailable')
  })
  test('success + unknown -> not_confirmed, never unavailable (data-truth rule: unknown is not unavailable)', () => {
    assert.equal(deriveAvailabilityState('success', 'unknown'), 'not_confirmed')
    assert.notEqual(deriveAvailabilityState('success', 'unknown'), 'unavailable')
  })
  test('failed -> check_failed, never unavailable (data-truth rule: failed is not unavailable)', () => {
    assert.equal(deriveAvailabilityState('failed', null), 'check_failed')
    assert.notEqual(deriveAvailabilityState('failed', null), 'unavailable')
  })
  test('blocked -> blocked, rendered distinctly from check_failed', () => {
    assert.equal(deriveAvailabilityState('blocked', null), 'blocked')
    assert.notEqual(deriveAvailabilityState('blocked', null), 'check_failed')
  })
  test('no row yet (checkStatus null) -> not_confirmed, never a negative result', () => {
    assert.equal(deriveAvailabilityState(null, null), 'not_confirmed')
  })
})

describe('deriveProductTrackerState', () => {
  test('archived parent -> archived, regardless of child target statuses', () => {
    assert.equal(deriveProductTrackerState('archived', ['active', 'failed']), 'archived')
  })
  test('removed parent -> removed, regardless of child target statuses', () => {
    assert.equal(deriveProductTrackerState('removed', ['paused']), 'removed')
  })
  test('active parent, every target active/checking -> active', () => {
    assert.equal(deriveProductTrackerState('active', ['active', 'checking', 'active']), 'active')
  })
  test('active parent, every non-checking target paused -> paused', () => {
    assert.equal(deriveProductTrackerState('active', ['paused', 'paused']), 'paused')
    assert.equal(deriveProductTrackerState('active', ['paused', 'checking']), 'paused')
  })
  test('active parent, every non-paused target failed -> failed', () => {
    assert.equal(deriveProductTrackerState('active', ['failed', 'failed']), 'failed')
    assert.equal(deriveProductTrackerState('active', ['paused', 'failed']), 'failed')
  })
  test('active parent, genuine mix of active/paused/failed -> partially_active, never collapsed into active or paused', () => {
    const state = deriveProductTrackerState('active', ['active', 'paused', 'failed'])
    assert.equal(state, 'partially_active')
    assert.notEqual(state, 'active')
    assert.notEqual(state, 'paused')
  })
})

describe('deriveFreshnessState (Correction 4, PR #55 review round)', () => {
  const NOW = '2026-07-20T12:00:00.000Z'

  test('checking status always wins, regardless of lastCheckedAt/nextCheckAt', () => {
    assert.equal(deriveFreshnessState('checking', null, null, NOW), 'checking')
    assert.equal(deriveFreshnessState('checking', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', NOW), 'checking')
  })

  test('never checked -> never_checked', () => {
    assert.equal(deriveFreshnessState('active', null, '2026-07-21T00:00:00.000Z', NOW), 'never_checked')
  })

  test('nextCheckAt IS NULL is never rendered as "fresh" -- it is unscheduled', () => {
    const state = deriveFreshnessState('paused', '2026-07-19T00:00:00.000Z', null, NOW)
    assert.equal(state, 'unscheduled')
    assert.notEqual(state, 'current')
  })

  test('nextCheckAt in the future -> current', () => {
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-21T00:00:00.000Z', NOW), 'current')
  })

  test('nextCheckAt in the past -> overdue', () => {
    assert.equal(deriveFreshnessState('active', '2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z', NOW), 'overdue')
  })

  test('nextCheckAt exactly equal to now -> overdue (due now counts as due, not current)', () => {
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', NOW, NOW), 'overdue')
  })

  test('Z timezone: future -> current, past -> overdue', () => {
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-21T00:00:00.000Z', NOW), 'current')
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', NOW), 'overdue')
  })

  test('+00:00 offset is chronologically equivalent to Z (final review round: numeric comparison, not string comparison)', () => {
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-20T12:00:00.000+00:00', NOW), 'overdue')
  })

  test('non-zero offset (-05:30): chronologically-future instant -> current, even though a naive string compare would wrongly say overdue', () => {
    // "2026-07-20T11:00:00.000-05:30" == 2026-07-20T16:30:00Z, which is
    // AFTER NOW (12:00:00Z) -- correctly 'current'. A naive string compare
    // (`nextCheckAt <= nowIso`) would compare "11:00:00.000-05:30" against
    // "12:00:00.000Z" and, since "11" < "12" lexically, wrongly conclude
    // nextCheckAt <= now and return 'overdue'.
    const nextCheckAt = '2026-07-20T11:00:00.000-05:30'
    assert.ok(nextCheckAt <= NOW, 'sanity: this pair is chosen so the naive string comparison disagrees with the correct chronological one')
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', nextCheckAt, NOW), 'current')
  })

  test('non-zero offset (+05:30): chronologically-past instant -> overdue, even though a naive string compare would wrongly say current', () => {
    // "2026-07-20T13:00:00.000+05:30" == 2026-07-20T07:30:00Z, which is
    // BEFORE NOW (12:00:00Z) -- correctly 'overdue'. A naive string compare
    // would see "13" > "12" lexically and wrongly return 'current'.
    const nextCheckAt = '2026-07-20T13:00:00.000+05:30'
    assert.ok(nextCheckAt > NOW, 'sanity: this pair is chosen so the naive string comparison disagrees with the correct chronological one')
    assert.equal(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', nextCheckAt, NOW), 'overdue')
  })

  test('malformed nextCheckAt -> unscheduled, never current', () => {
    const state = deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', 'not-a-timestamp', NOW)
    assert.equal(state, 'unscheduled')
    assert.notEqual(state, 'current')
  })

  test('malformed nowIso -> unscheduled, never current', () => {
    const state = deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 'also-not-a-timestamp')
    assert.equal(state, 'unscheduled')
    assert.notEqual(state, 'current')
  })

  test('malformed timestamps never produce current, across several garbage inputs', () => {
    const garbageValues = ['', 'NaN', 'tomorrow', '   ']
    for (const garbage of garbageValues) {
      assert.notEqual(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', garbage, NOW), 'current')
      assert.notEqual(deriveFreshnessState('active', '2026-07-19T00:00:00.000Z', '2026-07-21T00:00:00.000Z', garbage), 'current')
    }
  })
})
