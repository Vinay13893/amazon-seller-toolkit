import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapWorkerResult } from '../scheduler-result'

test('only a successful boolean confirmation establishes availability', () => {
  assert.equal(mapWorkerResult(200, { ok: true, status: 'success', available: true }).p_availability_status, 'available')
  assert.equal(mapWorkerResult(200, { ok: true, status: 'success', available: false }).p_availability_status, 'unavailable')
  for (const value of [{}, { status: 'success', available: null }, { status: 'failed', available: false }]) {
    assert.equal(mapWorkerResult(200, value).p_availability_status, null)
  }
})
test('blocked and infrastructure failures are distinct from unavailable', () => {
  assert.equal(mapWorkerResult(429, {}).p_check_status, 'blocked')
  assert.equal(mapWorkerResult(503, {}).p_check_status, 'failed')
  assert.equal(mapWorkerResult(503, { ok: true, status: 'success', available: false }).p_availability_status, null)
})
