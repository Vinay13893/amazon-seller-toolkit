import assert from 'node:assert/strict'
import test from 'node:test'
import { atStockSheetsStage, classifyStockSheetsError, StockSheetsError, stockSheetsFailure } from './errors'

test('signing errors expose only an allowlisted code and classify as configuration failures', () => {
  const error = Object.assign(new Error('private key and assertion must never be logged'), { code: 'ERR_OSSL_UNSUPPORTED' })
  const classified = classifyStockSheetsError(error, 'jwt_signing')
  assert.equal(classified.code, 'configuration_required')
  assert.equal(classified.safeCode, 'ERR_OSSL_UNSUPPORTED')
  assert.doesNotMatch(classified.message, /assertion/)
})

test('network and parsing errors are distinct from Google authorization failures', async () => {
  const network = classifyStockSheetsError(new TypeError('fetch failed'), 'google_token_exchange')
  assert.equal(network.code, 'upstream_error')
  assert.equal(network.safeCode, 'network_failure')
  await assert.rejects(atStockSheetsStage('response_processing', () => JSON.parse('{')), error => {
    assert.equal((error as StockSheetsError).safeCode, 'invalid_json')
    return true
  })
  const denied = new StockSheetsError('permission_denied', 'Workbook access denied.', 503,
    'google_spreadsheet_metadata', 'google_access_denied', 403)
  assert.equal(classifyStockSheetsError(denied, 'response_processing'), denied)
})

test('API failure classification and diagnostics never serialize raw errors or unknown codes', t => {
  const output: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => output.push(args))
  const result = stockSheetsFailure(Object.assign(new Error('SECRET'), { code: 'SECRET', cause: 'SECRET' }))
  assert.equal(result.status, 500)
  assert.equal(result.body.code, 'internal_error')
  assert.equal(result.body.status, 'unavailable')
  assert.doesNotMatch(JSON.stringify([result, output]), /SECRET/)
  assert.doesNotMatch(JSON.stringify(result.body), /stage|safeCode|stack/)
})
