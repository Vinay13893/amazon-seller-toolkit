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
})
