/**
 * Correction 6 (PR #55 review round): "a product-scoped URL cannot mutate
 * another product." `resolveScopedTargetIds` is the exact pure function
 * `handlePauseResume` (the real PATCH .../products/[id]/pause|resume
 * handler) delegates this decision to.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveScopedTargetIds } from '../pause-resume-handler'

describe('resolveScopedTargetIds', () => {
  test('no targetIds supplied -> resolves to every target of the URL product', () => {
    const result = resolveScopedTargetIds(new Set(['t-1', 't-2', 't-3']), null)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual([...result.targetIds].sort(), ['t-1', 't-2', 't-3'])
  })

  test('a requested subset that is entirely within the URL product is accepted', () => {
    const result = resolveScopedTargetIds(new Set(['t-1', 't-2', 't-3']), ['t-1', 't-3'])
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.targetIds, ['t-1', 't-3'])
  })

  test('a product-scoped URL cannot mutate another product: a targetId belonging to a DIFFERENT product is rejected, naming it', () => {
    // productA owns t-1/t-2; the request also asks for t-99, which belongs
    // to some other product -- the whole call must be rejected, not
    // silently narrowed to just t-1/t-2.
    const result = resolveScopedTargetIds(new Set(['t-1', 't-2']), ['t-1', 't-99'])
    assert.equal(result.ok, false)
    if (!result.ok) assert.deepEqual(result.foreignTargetIds, ['t-99'])
  })

  test('every requested ID belonging to a different product is rejected, all of them named', () => {
    const result = resolveScopedTargetIds(new Set(['t-1']), ['t-50', 't-60'])
    assert.equal(result.ok, false)
    if (!result.ok) assert.deepEqual(result.foreignTargetIds, ['t-50', 't-60'])
  })
})
