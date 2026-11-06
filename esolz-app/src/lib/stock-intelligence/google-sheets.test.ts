import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'
import '../../../scripts/stock-sheets-server-marker.mjs'
import { getStockWorkbookMetadata } from './google-sheets'
import { DEFAULT_STOCK_SPREADSHEET_ID } from './config'

test('Google adapter classifies failures and signs read-only requests', async t => {
  // Ephemeral fixture only. All requests below terminate in the fetch mock.
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = String(keys.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  const email = 'reader@example.invalid'
  const envNames = ['GOOGLE_STOCK_SHEETS_CLIENT_EMAIL', 'GOOGLE_STOCK_SHEETS_PRIVATE_KEY',
    'GOOGLE_STOCK_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY']
  const original = envNames.map(key => process.env[key])
  for (const key of envNames) delete process.env[key]
  t.after(() => envNames.forEach((key, i) => {
    const value = original[i]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }))

  let oauthStatus = 400
  let sheetsStatus = 200
  let signed = 0
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST')
      const jwt = (init.body as URLSearchParams).get('assertion')!
      const [header, payload, signature] = jwt.split('.')
      assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256')
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
      assert.equal(claims.iss, email)
      assert.equal(claims.aud, url)
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly')
      assert.equal(claims.exp - claims.iat, 3600)
      assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')))
      signed++
      return Response.json(oauthStatus === 200 ? { access_token: 'fixture' } : { error: 'private upstream detail' }, { status: oauthStatus })
    }
    assert.equal(new URL(url).hostname, 'sheets.googleapis.com')
    assert.equal(init.method ?? 'GET', 'GET')
    reads++
    return Response.json(sheetsStatus === 200
      ? { spreadsheetId: DEFAULT_STOCK_SPREADSHEET_ID, properties: { title: 'Fixture workbook' }, sheets: [] }
      : { error: 'private upstream detail' }, { status: sheetsStatus })
  })

  await assert.rejects(getStockWorkbookMetadata(true), { stage: 'configuration', code: 'configuration_required' })
  process.env.GOOGLE_STOCK_SHEETS_CLIENT_EMAIL = email
  process.env.GOOGLE_STOCK_SHEETS_PRIVATE_KEY = 'truncated test fixture'
  await assert.rejects(getStockWorkbookMetadata(true), { stage: 'jwt_signing', safeCode: 'invalid_private_key' })
  assert.equal(signed, 0)

  for (const encoded of [
    pem,
    pem.replaceAll('\n', '\\n'),
    pem.replaceAll('\n', '\r\n'),
    pem.replaceAll('\n', '\\r\\n'),
    JSON.stringify(pem),
    JSON.stringify({ private_key: pem }),
  ]) {
    process.env.GOOGLE_STOCK_SHEETS_PRIVATE_KEY = encoded
    await assert.rejects(getStockWorkbookMetadata(true), { stage: 'google_token_exchange', code: 'authentication_failed', upstreamStatus: 400 })
  }
  assert.equal(signed, 6)
  assert.equal(reads, 0)
  oauthStatus = 503
  await assert.rejects(getStockWorkbookMetadata(true), { stage: 'google_token_exchange', code: 'upstream_error', upstreamStatus: 503 })
  oauthStatus = 200
  for (const [status, code] of [[401, 'authentication_failed'], [403, 'permission_denied'], [404, 'not_found'], [503, 'upstream_error']] as const) {
    sheetsStatus = status
    await assert.rejects(getStockWorkbookMetadata(true), { stage: 'google_spreadsheet_metadata', code, upstreamStatus: status })
  }
  sheetsStatus = 200
  assert.equal((await getStockWorkbookMetadata(true)).spreadsheetTitle, 'Fixture workbook')
})
