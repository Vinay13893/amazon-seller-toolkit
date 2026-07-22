import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapEnrollResult, mapSetTrackingStateResult, mapRemoveResult, mapQueueManualCheckResult,
  mapReplaceProductTargetsResult, mapReplaceDefaultsResult,
} from '../responses'

async function bodyOf(response: Response) {
  return await response.json()
}

describe('mapEnrollResult', () => {
  test('quota_exceeded maps to the DATA_MODEL.md sec2b-locked 409 shape exactly', async () => {
    const response = mapEnrollResult({ result: 'quota_exceeded', currentActiveTargets: 48, requestedAdditionalTargets: 5, limit: 50 })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'pincode_tracking_quota_exceeded')
    assert.equal(body.currentActiveTargets, 48)
    assert.equal(body.requestedAdditionalTargets, 5)
    assert.equal(body.limit, 50)
  })

  test('success maps to 200', async () => {
    const response = mapEnrollResult({ result: 'success', currentActiveTargets: 10, requestedAdditionalTargets: 2 })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.result, 'success')
  })

  test('invalid_parameters maps to 400', async () => {
    const response = mapEnrollResult({ result: 'invalid_parameters', reason: 'invalid_asin', asin: 'BAD' })
    assert.equal(response.status, 400)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'invalid_parameters')
    assert.equal(body.reason, 'invalid_asin')
  })

  test('listing_verification_failed maps to 422', async () => {
    const response = mapEnrollResult({ result: 'listing_verification_failed', asin: 'B0D9QXVWLL' })
    assert.equal(response.status, 422)
  })
})

describe('mapSetTrackingStateResult', () => {
  test('check_in_progress maps to 409, per the explicit P0-B requirement', async () => {
    const response = mapSetTrackingStateResult({ result: 'check_in_progress', targetIds: ['a0000000-0000-0000-0000-000000000001'] })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'check_in_progress')
    assert.deepEqual(body.targetIds, ['a0000000-0000-0000-0000-000000000001'])
  })

  test('not_found_or_scope_mismatch maps to 404', async () => {
    const response = mapSetTrackingStateResult({ result: 'not_found_or_scope_mismatch', requestedCount: 3, validCount: 2 })
    assert.equal(response.status, 404)
  })

  test('resume quota_exceeded maps to the same locked 409 shape as enrollment', async () => {
    const response = mapSetTrackingStateResult({ result: 'quota_exceeded', currentActiveTargets: 50, requestedAdditionalTargets: 1, limit: 50 })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'pincode_tracking_quota_exceeded')
  })

  test('success (pause) maps to 200 with the action echoed back', async () => {
    const response = mapSetTrackingStateResult({ result: 'success', action: 'pause', targetCount: 4 })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.action, 'pause')
    assert.equal(body.targetCount, 4)
  })
})

describe('mapRemoveResult', () => {
  test('success maps to 200 with productCount', async () => {
    const response = mapRemoveResult({ result: 'success', productCount: 2 })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.productCount, 2)
  })

  test('not_found_or_scope_mismatch maps to 404', async () => {
    const response = mapRemoveResult({ result: 'not_found_or_scope_mismatch', requestedCount: 2, validCount: 1 })
    assert.equal(response.status, 404)
  })
})

describe('mapReplaceProductTargetsResult (Correction 2, PR #55 review round)', () => {
  test('success maps to 200 with all four counts', async () => {
    const response = mapReplaceProductTargetsResult({ result: 'success', addedCount: 2, reconfiguredCount: 1, unconfiguredCount: 3, targetCount: 5 })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.addedCount, 2)
    assert.equal(body.reconfiguredCount, 1)
    assert.equal(body.unconfiguredCount, 3)
    assert.equal(body.targetCount, 5)
  })

  test('empty-pincodes rejection maps to 400 invalid_parameters', async () => {
    const response = mapReplaceProductTargetsResult({ result: 'invalid_parameters', reason: 'empty_pincodes_use_remove_tracking' })
    assert.equal(response.status, 400)
    const body = await bodyOf(response)
    assert.equal(body.reason, 'empty_pincodes_use_remove_tracking')
  })

  test('quota_exceeded reuses the same locked errorCode as enrollment/resume', async () => {
    const response = mapReplaceProductTargetsResult({ result: 'quota_exceeded', currentActiveTargets: 50, requestedAdditionalTargets: 1, limit: 50 })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'pincode_tracking_quota_exceeded')
  })

  test('not_found_or_scope_mismatch maps to 404', async () => {
    const response = mapReplaceProductTargetsResult({ result: 'not_found_or_scope_mismatch' })
    assert.equal(response.status, 404)
  })

  test('invalid_status (parent not active) maps to 409', async () => {
    const response = mapReplaceProductTargetsResult({ result: 'invalid_status', reason: 'parent_not_active' })
    assert.equal(response.status, 409)
  })
})

describe('mapReplaceDefaultsResult (Correction 3, PR #55 review round)', () => {
  test('success maps to 200 with the final active default list', async () => {
    const response = mapReplaceDefaultsResult({ result: 'success', defaults: [{ id: 'd-1', pincode: '110001', displayOrder: 0 }] })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.defaults.length, 1)
  })

  test('invalid_parameters maps to 400', async () => {
    const response = mapReplaceDefaultsResult({ result: 'invalid_parameters', reason: 'duplicate_pincode', pincode: '110001' })
    assert.equal(response.status, 400)
    const body = await bodyOf(response)
    assert.equal(body.reason, 'duplicate_pincode')
  })
})

describe('mapQueueManualCheckResult', () => {
  test('queued maps to 202 Accepted, never a synchronous-looking 200', async () => {
    const response = mapQueueManualCheckResult({ result: 'queued', manual_request_token: 'a0000000-0000-0000-0000-000000000001' })
    assert.equal(response.status, 202)
    const body = await bodyOf(response)
    assert.equal(body.result, 'queued')
    assert.equal(body.manualRequestToken, 'a0000000-0000-0000-0000-000000000001')
  })

  test('already_queued and checking both coalesce to 200, not an error (duplicate requests are coalesced, per PRODUCT_SPEC.md sec12 #8)', async () => {
    const already = mapQueueManualCheckResult({ result: 'already_queued', manual_request_token: 'tok' })
    assert.equal(already.status, 200)
    const checking = mapQueueManualCheckResult({ result: 'checking' })
    assert.equal(checking.status, 200)
  })

  test('cooldown maps to 429 with a Retry-After header and does not use the enrollment quota errorCode', async () => {
    const response = mapQueueManualCheckResult({ result: 'cooldown', retry_after_seconds: 42 })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '42')
    const body = await bodyOf(response)
    assert.notEqual(body.errorCode, 'pincode_tracking_quota_exceeded')
  })

  test('manual quota_exceeded uses the DATA_MODEL.md sec2c-locked errorCode, deliberately different from the enrollment quota errorCode', async () => {
    const response = mapQueueManualCheckResult({ result: 'quota_exceeded', currentOutstanding: 10, limit: 10 })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'pincode_manual_queue_limit_reached')
    assert.notEqual(body.errorCode, 'pincode_tracking_quota_exceeded')
  })

  test('manual-quota-independence: manual queue_exceeded and enrollment quota_exceeded never share an errorCode', async () => {
    const manual = await bodyOf(mapQueueManualCheckResult({ result: 'quota_exceeded', currentOutstanding: 5, limit: 5 }))
    const enrollment = await bodyOf(mapEnrollResult({ result: 'quota_exceeded', currentActiveTargets: 5, requestedAdditionalTargets: 1, limit: 5 }))
    assert.notEqual(manual.errorCode, enrollment.errorCode)
  })

  test('invalid_status with a not-found-shaped reason maps to 404', async () => {
    const response = mapQueueManualCheckResult({ result: 'invalid_status', reason: 'not_found_or_wrong_workspace' })
    assert.equal(response.status, 404)
  })

  test('invalid_status with a conflict-shaped reason (e.g. product archived) maps to 409, distinct from a not-found', async () => {
    const response = mapQueueManualCheckResult({ result: 'invalid_status', reason: 'product_archived_or_removed' })
    assert.equal(response.status, 409)
  })

  test('invalid_status with a genuine parameter-validation reason maps to 400', async () => {
    const response = mapQueueManualCheckResult({ result: 'invalid_status', reason: 'invalid_cooldown_seconds' })
    assert.equal(response.status, 400)
  })

  test('invalid_status with reason target_unconfigured maps to 409 invalid_status, never 400 invalid_parameters (final review round)', async () => {
    const response = mapQueueManualCheckResult({ result: 'invalid_status', reason: 'target_unconfigured' })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.errorCode, 'invalid_status')
    assert.equal(body.reason, 'target_unconfigured')
    assert.notEqual(response.status, 400)
    assert.notEqual(body.errorCode, 'invalid_parameters')
  })
})
