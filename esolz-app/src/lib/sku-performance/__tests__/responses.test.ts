import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { jsonError, jsonOk, mapInvalidParameters } from '../responses'

describe('jsonError', () => {
  test('sets the status and body shape', async () => {
    const res = jsonError(400, 'invalid_parameters', 'bad request', { reason: 'date_from_after_date_to' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'bad request')
    assert.equal(body.errorCode, 'invalid_parameters')
    assert.equal(body.reason, 'date_from_after_date_to')
  })
})

describe('jsonOk', () => {
  test('defaults to 200', async () => {
    const res = jsonOk({ result: 'success' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'success')
  })
  test('accepts an explicit status', () => {
    const res = jsonOk({}, 201)
    assert.equal(res.status, 201)
  })
})

describe('mapInvalidParameters', () => {
  test('maps an RPC invalid_parameters result to a 400 with the reason preserved', async () => {
    const res = mapInvalidParameters({ reason: 'invalid_limit' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.errorCode, 'invalid_parameters')
    assert.equal(body.reason, 'invalid_limit')
  })
})
