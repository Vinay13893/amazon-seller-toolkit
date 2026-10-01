import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as listings from './catalog-refresh-listings'

// Execute the real route with isolated dependencies; no credentials or network.
const routeCode = ts.transpileModule(
  readFileSync(path.resolve('src/app/api/cron/catalog/refresh-listings/route.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

type Query = {
  table: string
  operation: string
  values?: Record<string, unknown>
  filters: Record<string, unknown>
}
type Result = { data: unknown; error: unknown }

async function runCron(override: (query: Query) => Result | undefined = () => undefined) {
  const queries: Query[] = []
  const events: string[] = []
  const logs: unknown[][] = []
  const admin = {
    from(table: string) {
      const query: Query = { table, operation: 'select', filters: {} }
      const builder = {
        select() { return builder },
        neq() { return builder },
        order() { return builder },
        limit() { return builder },
        maybeSingle() { return builder },
        single() { return builder },
        eq(key: string, value: unknown) { query.filters[key] = value; return builder },
        insert(values: Record<string, unknown>) {
          query.operation = 'insert'; query.values = values; return builder
        },
        update(values: Record<string, unknown>) {
          query.operation = 'update'; query.values = values; return builder
        },
        upsert(values: Record<string, unknown>) {
          query.operation = 'upsert'; query.values = values; return builder
        },
        then(resolve: (result: Result) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            queries.push(query)
            events.push(`${table}:${query.operation}:${query.values?.status ?? Object.keys(query.values ?? {})[0] ?? query.filters.status ?? ''}`)
            const overridden = override(query)
            if (overridden) return overridden
            if (query.operation === 'insert') return { data: { id: 'job', metadata: {} }, error: null }
            if (query.operation !== 'select') return { data: null, error: null }
            if (table === 'amazon_connections') {
              return { data: [{
                id: 'connection', workspace_id: 'workspace', selling_partner_id: 'seller',
                marketplace_id: 'marketplace', status: 'active', refresh_token_encrypted: 'encrypted',
              }], error: null }
            }
            return { data: query.filters.status === 'running' ? [] : null, error: null }
          }).then(resolve, reject)
        },
      }
      return builder
    },
  }
  const dependencies: Record<string, unknown> = {
    'next/server': { NextResponse: { json: (value: unknown) => Response.json(value) } },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/lib/amazon/crypto': { decryptToken: () => 'test-token', encryptToken: () => 'encrypted' },
    '@/lib/amazon/lwa': { refreshAccessToken: async () => {
      events.push('token-refresh')
      return { access_token: 'test-token', expires_in: 3600 }
    } },
    '@/lib/amazon/spapi-client': {
      searchListingsItems: async () => {
        events.push('listings-read')
        return { items: [{ sku: 'test-sku' }] }
      },
      extractNextPageToken: () => undefined,
    },
    '@/lib/amazon/catalog-refresh-listings': listings,
  }
  const exports: { GET?: (request: { headers: Headers }) => Promise<Response> } = {}
  vm.runInNewContext(routeCode, {
    exports,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    process: { env: { CRON_SECRET: 'test-cron-secret' } },
    console: { error: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
  })
  assert.ok(exports.GET)
  const response = await exports.GET({ headers: new Headers({ authorization: 'Bearer test-cron-secret' }) })
  const body = await response.json()
  return { result: body.results.workspace, queries, events, logs }
}

for (const [status, reason] of [
  ['running', 'running_job_query_failed'],
  ['completed', 'completed_job_query_failed'],
] as const) {
  test(`${status} job read failure cannot create a cycle or call Amazon`, async () => {
    const run = await runCron(query => query.operation === 'select' && query.filters.status === status
      ? { data: null, error: { message: 'private database details' } } : undefined)
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.reason, reason)
    assert.ok(run.queries.every(query => query.operation === 'select'))
    assert.ok(!run.events.includes('token-refresh'))
    assert.ok(!run.events.includes('listings-read'))
    assert.deepEqual(run.logs, [])
  })
}

test('final progress and authoritative completion precede the freshness marker', async () => {
  const run = await runCron()
  const progress = run.events.indexOf('amazon_sync_jobs:update:metadata')
  const completion = run.events.indexOf('amazon_sync_jobs:update:completed')
  const freshness = run.events.indexOf('amazon_connections:update:last_sync_at')
  assert.ok(progress >= 0 && progress < completion && completion < freshness)
  const finishedAt = run.queries.find(q => q.values?.status === 'completed')?.values?.finished_at
  assert.equal(run.queries.find(q => q.values?.last_sync_at)?.values?.last_sync_at, finishedAt)
  assert.equal(run.result.status, 'completed')
  assert.equal(run.result.job_completed, true)
  assert.equal(run.result.items_upserted_this_run, 1)
})

for (const failure of ['returned', 'thrown'] as const) {
  test(`${failure} freshness marker failure preserves successful job completion`, async () => {
    const run = await runCron(query => {
      if (query.values?.last_sync_at) {
        if (failure === 'thrown') throw new Error('private database details')
        return { data: null, error: { message: 'private database details' } }
      }
    })
    assert.equal(run.result.status, 'completed')
    assert.equal(run.result.job_completed, true)
    assert.equal(run.result.reason, 'connection_freshness_persist_failed')
    assert.ok(run.queries.some(q => q.values?.status === 'completed'))
    assert.ok(!run.queries.some(q => q.values?.status === 'failed'))
    assert.equal(run.logs.length, 1)
    assert.ok(!JSON.stringify(run.logs).includes('private database details'))
  })
}

for (const [field, reason] of [
  ['metadata', 'page_progress_persist_failed'],
  ['status', 'job_complete_state_update_failed'],
] as const) {
  test(`${reason} cannot publish a freshness marker`, async () => {
    const run = await runCron(query => query.operation === 'update' &&
      (field === 'metadata' ? !!query.values?.metadata : query.values?.status === 'completed')
      ? { data: null, error: { message: 'private database details' } } : undefined)
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.reason, reason)
    assert.equal(run.result.job_completed, false)
    assert.ok(!run.queries.some(q => q.values?.last_sync_at))
    assert.ok(run.queries.some(q => q.values?.status === 'failed'))
    if (field === 'metadata') assert.ok(!run.queries.some(q => q.values?.status === 'completed'))
  })
}

test('unexpected exceptions expose only a generic failure reason', async () => {
  const run = await runCron(query => {
    if (query.filters.status === 'running') throw new Error('private database details')
    return undefined
  })
  assert.equal(run.result.reason, 'workspace_refresh_failed')
  assert.ok(!JSON.stringify(run).includes('private database details'))
  assert.ok(run.queries.every(query => query.operation === 'select'))
})

test('cron logs only sanitized database diagnostics on an upsert failure', async () => {
  const run = await runCron(query => query.table === 'amazon_listing_items' && query.operation === 'upsert'
    ? { data: null, error: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "amazon_listing_items_asin_marketplace_uidx"',
      details: 'PRIVATE-SKU PRIVATE-ASIN',
      hint: 'PRIVATE-SELLER',
    } } : undefined)
  assert.equal(run.result.status, 'failed')
  assert.equal(run.result.reason, 'listing_upsert_failed')
  assert.equal(run.result.items_upserted_this_run, 0)
  assert.ok(!run.queries.some(query => query.values?.status === 'completed'))
  assert.ok(!run.queries.some(query => query.values?.last_sync_at))
  assert.ok(JSON.stringify(run.logs).includes('asin_unique_index_conflict'))
  assert.ok(!JSON.stringify(run.logs).includes('PRIVATE'))
})
