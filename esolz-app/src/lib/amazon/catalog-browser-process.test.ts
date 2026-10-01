import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as listings from './catalog-refresh-listings'

const routeCode = ts.transpileModule(
  readFileSync(path.resolve('src/app/api/amazon/sync/listings/process/route.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

type Write = { table: string; action: string; values: Record<string, unknown>; options?: Record<string, unknown> }

async function runBrowserProcess(upsertError: unknown) {
  const writes: Write[] = []
  const logs: unknown[][] = []
  function table(tableName: string) {
    const filters: Record<string, unknown> = {}
    let action = 'select'
    let values: Record<string, unknown> = {}
    let options: Record<string, unknown> | undefined
    const builder = {
      select() { return builder },
      limit() { return builder },
      eq(key: string, value: unknown) { filters[key] = value; return builder },
      maybeSingle() { return builder },
      upsert(row: Record<string, unknown>, opts: Record<string, unknown>) {
        action = 'upsert'; values = row; options = opts; return builder
      },
      update(row: Record<string, unknown>) { action = 'update'; values = row; return builder },
      insert(row: Record<string, unknown>) { action = 'insert'; values = row; return builder },
      then(resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve().then(() => {
          if (action !== 'select') writes.push({ table: tableName, action, values, options })
          if (tableName === 'workspace_members') return { data: { workspace_id: 'workspace', role: 'owner' }, error: null }
          if (tableName === 'amazon_sync_jobs' && action === 'select') {
            return { data: { id: 'job', workspace_id: 'workspace', connection_id: 'connection', status: 'running', metadata: {} }, error: null }
          }
          if (tableName === 'amazon_connections' && action === 'select') {
            return { data: { id: 'connection', status: 'active', selling_partner_id: 'seller', marketplace_id: 'marketplace', refresh_token_encrypted: 'encrypted' }, error: null }
          }
          if (tableName === 'amazon_listing_items') return { data: null, error: upsertError }
          return { data: null, error: null }
        }).then(resolve, reject)
      },
    }
    return builder
  }
  const authClient = { auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) }, from: table }
  const dependencies: Record<string, unknown> = {
    'next/server': { NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) } },
    '@/lib/supabase/server': { createClient: async () => authClient },
    '@/lib/supabase/admin': { createAdminClient: () => ({ from: table }) },
    '@/lib/amazon/crypto': { decryptToken: () => 'test-token', encryptToken: () => 'encrypted' },
    '@/lib/amazon/lwa': { refreshAccessToken: async () => ({ access_token: 'test-token', expires_in: 3600 }) },
    '@/lib/amazon/spapi-client': {
      searchListingsItems: async () => ({ items: [{ sku: 'PRIVATE-SKU', summaries: [{ marketplaceId: 'marketplace', asin: 'PRIVATE-ASIN' }] }] }),
      extractNextPageToken: () => 'NEXT-PAGE',
    },
    '@/lib/amazon/catalog-refresh-listings': listings,
  }
  const exports: { POST?: (request: { json: () => Promise<{ job_id: string }> }) => Promise<Response> } = {}
  vm.runInNewContext(routeCode, {
    exports,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    console: { error: (...args: unknown[]) => logs.push(args) },
  })
  assert.ok(exports.POST)
  const response = await exports.POST({ json: async () => ({ job_id: 'job' }) })
  return { status: response.status, body: await response.json(), writes, logs }
}

test('browser sync counts only confirmed writes and retains the same conflict target', async () => {
  const result = await runBrowserProcess(null)
  assert.equal(result.status, 200)
  assert.equal(result.body.items_upserted, 1)
  assert.equal(result.body.status, 'running')
  assert.equal(result.writes.find(write => write.table === 'amazon_listing_items')?.options?.onConflict,
    'workspace_id,sku,marketplace_id')
})

test('browser sync fails on returned DB error without advancing page progress or logging identifiers', async () => {
  const result = await runBrowserProcess({
    code: '23505',
    message: 'duplicate key value violates unique constraint "amazon_listing_items_asin_marketplace_uidx"',
    details: 'PRIVATE-SKU PRIVATE-ASIN',
  })
  assert.equal(result.status, 500)
  assert.equal(result.body.error, 'listing_upsert_failed')
  assert.ok(result.writes.some(write => write.table === 'amazon_sync_jobs' && write.values.status === 'failed'))
  assert.ok(!result.writes.some(write => write.table === 'amazon_sync_jobs' && 'metadata' in write.values))
  assert.ok(!result.writes.some(write => write.table === 'amazon_connections' && 'last_sync_at' in write.values))
  assert.ok(!JSON.stringify(result.logs).includes('PRIVATE'))
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE'))
})
