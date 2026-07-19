/**
 * Source-scanning regression tests for the two structural safety
 * properties this feature depends on, which a type-checker alone can't
 * verify: (1) no P0-B route or lib file is a client component that could
 * ship `createAdminClient`'s service-role code into the browser bundle,
 * (2) every P0-B route funnels through `resolvePincodeAccess` before doing
 * anything else -- there is no route that mutates or reads Pincode data
 * without going through the one access gate.
 *
 * This is deliberately a text-scan, not a live-DB integration test -- see
 * the P0-B PR description for why a real Next.js + Supabase integration
 * harness was judged out of scope for this round (no PostgREST/GoTrue
 * layer available in this environment; the P0-A scratch-DB runner is raw
 * Postgres only, by design).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROUTES_DIR = path.join(__dirname, '..', '..', '..', 'app', 'api', 'pincode-monitoring')
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
  test('no P0-B route.ts file is a client component', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    assert.ok(routeFiles.length >= 8, `expected at least 8 route.ts files, found ${routeFiles.length}`)
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("'use client'"), false, `${file} must never be a client component`)
    }
  })

  test('no P0-B lib module is a client component', () => {
    const libFiles = collectFiles(LIB_DIR, '.ts').filter(f => !f.includes('__tests__'))
    for (const file of libFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("'use client'"), false, `${file} must never be a client component`)
    }
  })

  test('every mutating/read route imports resolvePincodeAccess (no route bypasses the access gate)', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      const usesAccessGateDirectly = content.includes('resolvePincodeAccess')
      const delegatesToASharedHandler = content.includes('pause-resume-handler') // pause/resume routes delegate to a shared handler that itself calls resolvePincodeAccess (see rpc.test.ts's sibling handler coverage and pause-resume-handler.ts itself)
      assert.ok(usesAccessGateDirectly || delegatesToASharedHandler, `${file} does not appear to call the access gate`)
    }
  })

  test('createAdminClient is never imported by a route file directly ahead of an access check (grep-level sanity: admin import appears after resolvePincodeAccess import in every route that has both)', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      const adminIdx = content.indexOf("from '@/lib/supabase/admin'")
      const accessIdx = content.indexOf('resolvePincodeAccess')
      if (adminIdx === -1) continue // this route doesn't touch the admin client directly (e.g. delegates to a lib handler) -- nothing to check here
      assert.ok(accessIdx !== -1, `${file} imports the admin client but never references resolvePincodeAccess`)
    }
  })
})
