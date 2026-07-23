/**
 * Source-scanning regression tests for structural properties a type-checker
 * alone can't verify. Mirrors
 * esolz-app/src/lib/pincode-monitoring/__tests__/static-checks.test.ts's
 * approach (deliberately a text-scan, not a live-DB integration test).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROUTES_DIR = path.join(__dirname, '..', '..', '..', 'app', 'api', 'sku-performance')
const LIB_DIR = path.join(__dirname, '..')

function collectFiles(dir: string, suffix: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, suffix))
    } else if (entry.endsWith(suffix)) {
      results.push(full)
    }
  }
  return results
}

describe('static safety checks', () => {
  test('exactly 2 route.ts files exist (summary, [sku]/daily) -- P1-B is read-only data-layer only, no UI route', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    assert.equal(routeFiles.length, 2, `expected exactly 2 route.ts files, found ${routeFiles.length}: ${routeFiles.join(', ')}`)
  })

  test('no route.ts file is a client component', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("'use client'"), false, `${file} must never be a client component`)
    }
  })

  test('no lib module is a client component', () => {
    const libFiles = collectFiles(LIB_DIR, '.ts').filter((f) => !f.includes('__tests__'))
    for (const file of libFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("'use client'"), false, `${file} must never be a client component`)
    }
  })

  test('no route exports a write verb (POST/PUT/PATCH/DELETE) -- this is a read-only reporting page (Product Spec sec9)', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      for (const verb of ['export async function POST', 'export async function PUT', 'export async function PATCH', 'export async function DELETE']) {
        assert.equal(content.includes(verb), false, `${file} must not export ${verb} -- no write path of any kind`)
      }
      assert.ok(content.includes('export async function GET'), `${file} must export GET`)
    }
  })

  test('every route calls getInternalAccessContext (no route bypasses the access gate)', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.ok(content.includes('getInternalAccessContext'), `${file} does not appear to call the access gate`)
    }
  })

  test('no route ever reads a client-supplied workspaceId query parameter (workspaceId only ever comes from the access context)', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("get('workspaceId')"), false, `${file} must never read workspaceId from the query string`)
      assert.ok(content.includes('access.workspaceId'), `${file} must source workspaceId from the authorized access context`)
    }
  })

  test('the only two Postgres RPC names called anywhere are the two locked P1-B RPCs (no generic .rpc(name, params) passthrough)', () => {
    const allTsFiles = [...collectFiles(LIB_DIR, '.ts'), ...collectFiles(ROUTES_DIR, 'route.ts')].filter((f) => !f.includes('__tests__'))
    const rpcCallRe = /\.rpc\(\s*(['"])([^'"]+)\1/g
    const calledNames = new Set<string>()
    for (const file of allTsFiles) {
      const content = readFileSync(file, 'utf8')
      for (const match of content.matchAll(rpcCallRe)) {
        calledNames.add(match[2])
      }
    }
    assert.deepEqual(
      [...calledNames].sort(),
      ['get_sku_performance_daily', 'get_sku_performance_summary'],
      'exactly these two hardcoded RPC names must be the only ones called anywhere in this feature',
    )
    // And confirm every such call site is inside rpc.ts specifically.
    for (const file of allTsFiles) {
      if (file.endsWith(`${path.sep}rpc.ts`)) continue
      const content = readFileSync(file, 'utf8')
      assert.equal(rpcCallRe.test(content), false, `${file} calls .rpc(...) directly -- only rpc.ts may do this`)
    }
  })

  test('createAdminClient is only imported by the two data-access modules (summary.ts, daily.ts), never by a route file directly', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("from '@/lib/supabase/admin'"), false, `${file} must not import the admin client directly -- it must go through summary.ts/daily.ts`)
    }
  })
})
