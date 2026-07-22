import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCatalogLookupError, resolveCatalogLookup, type CatalogLookupDeps, type CatalogConnectionRow } from '../catalog-lookup'

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

const ACTIVE_CONNECTION: CatalogConnectionRow = { status: 'active', refresh_token_encrypted: 'ciphertext' }

function baseDeps(overrides: Partial<CatalogLookupDeps> = {}): CatalogLookupDeps {
  return {
    queryConnection: async () => ({ data: ACTIVE_CONNECTION, error: null }),
    decryptToken: () => 'refresh-token',
    refreshAccessToken: async () => ({ access_token: 'access-token' }),
    getCatalogItem: async () => ({ asin: 'B000000000', title: 't', brand: 'b', image_url: null, category: null, bsr: null, bsr_category: null, bsr_ranks: [] }),
    ...overrides,
  }
}

describe('resolveCatalogLookup (final review round)', () => {
  test('connection query error -> connection_query_failed, never connection_unavailable', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ queryConnection: async () => ({ data: null, error: { message: 'db timeout' } }) }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'connection_query_failed')
    assert.notEqual(result.outcome, 'connection_unavailable')
  })

  test('no active connection row (no query error) -> connection_unavailable', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ queryConnection: async () => ({ data: null, error: null }) }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'connection_unavailable')
  })

  test('connection row present but inactive/no token -> connection_unavailable', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ queryConnection: async () => ({ data: { status: 'revoked', refresh_token_encrypted: null }, error: null }) }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'connection_unavailable')
  })

  test('decryptToken throws -> token_refresh_failed, controlled, never an uncaught exception', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ decryptToken: () => { throw new Error('bad ciphertext') } }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'token_refresh_failed')
  })

  test('refreshAccessToken rejects -> token_refresh_failed, controlled, never an uncaught exception', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ refreshAccessToken: async () => { throw new Error('LWA outage') } }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'token_refresh_failed')
  })

  test('catalog not-found remains its own distinct outcome, not folded into token_refresh_failed or unavailable', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ getCatalogItem: async () => { throw new Error('catalog_not_found') } }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'not_found')
  })

  test('catalog timeout (AbortError) remains its own distinct outcome', async () => {
    const result = await resolveCatalogLookup(
      baseDeps({ getCatalogItem: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e } }),
      'A1', 'B000000000',
    )
    assert.equal(result.outcome, 'timeout')
  })

  test('happy path -> found, with the confirmed item', async () => {
    const result = await resolveCatalogLookup(baseDeps(), 'A1', 'B000000000')
    assert.equal(result.outcome, 'found')
    assert.equal(result.outcome === 'found' && result.item.asin, 'B000000000')
  })
})
