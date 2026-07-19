import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCatalogLookupError } from '../catalog-lookup'

describe('classifyCatalogLookupError', () => {
  test('catalog_not_found error message -> not_found (Amazon confirmed the ASIN does not exist)', () => {
    assert.equal(classifyCatalogLookupError(new Error('catalog_not_found')), 'not_found')
  })
  test('AbortError -> timeout, distinct from a confirmed not-found', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    assert.equal(classifyCatalogLookupError(err), 'timeout')
  })
  test('any other error -> unavailable (transient, retryable, never treated as confirmed-nonexistent)', () => {
    assert.equal(classifyCatalogLookupError(new Error('catalog_unavailable')), 'unavailable')
    assert.equal(classifyCatalogLookupError(new Error('boom')), 'unavailable')
    assert.equal(classifyCatalogLookupError('not even an Error object'), 'unavailable')
  })
})
