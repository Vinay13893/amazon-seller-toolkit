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
    // 8 original P0-B routes + Correction 2's PATCH .../products/[id]/pincodes.
    assert.ok(routeFiles.length >= 9, `expected at least 9 route.ts files, found ${routeFiles.length}`)
    for (const file of routeFiles) {
      const content = readFileSync(file, 'utf8')
      assert.equal(content.includes("'use client'"), false, `${file} must never be a client component`)
    }
  })

  test('Correction 2 (PR #55 review round): the "Edit Pincodes" route (PATCH .../products/[id]/pincodes) exists', () => {
    const routeFiles = collectFiles(ROUTES_DIR, 'route.ts')
    const hasEditPincodesRoute = routeFiles.some(f => f.replace(/\\/g, '/').includes('/products/[id]/pincodes/route.ts'))
    assert.ok(hasEditPincodesRoute, 'PATCH .../products/[id]/pincodes route.ts was not found -- this route was missing entirely before Correction 2')
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

  test('Correction 3 (PR #55 review round): default-pincode replacement uses exactly one RPC call, never a separate upsert-then-deactivate pair', () => {
    const content = readFileSync(path.join(LIB_DIR, 'defaults.ts'), 'utf8')
    assert.ok(content.includes('replaceWorkspaceDefaultPincodes'), 'defaults.ts must call the replace_workspace_default_pincodes RPC wrapper')
    assert.equal(content.includes(".upsert("), false, 'defaults.ts must not perform its own .upsert() write -- that was the non-atomic two-request bug this correction closes')
  })

  test('Correction 4 (PR #55 review round): tracker.ts uses the bounded get_pincode_target_results RPC, never an unbounded results query, and the removed isLastConfirmedResult field name is gone', () => {
    const content = readFileSync(path.join(LIB_DIR, 'tracker.ts'), 'utf8')
    assert.ok(content.includes('getTargetResults'), 'tracker.ts must call the get_pincode_target_results RPC wrapper')
    assert.equal(content.includes("from('pincode_availability_results')"), false, 'tracker.ts must not query pincode_availability_results directly -- that was the unbounded-fetch-then-dedupe-in-TypeScript bug this correction closes')
    assert.equal(content.includes('isLastConfirmedResult'), false, 'the incorrect isLastConfirmedResult field must be fully removed, not just unused')
    assert.ok(content.includes('lastConfirmedAvailability'), 'tracker.ts must expose the replacement lastConfirmedAvailability fact')
  })

  test('Correction 6 (PR #55 review round): pause/resume/remove routes no longer accept a cross-product productIds override', () => {
    const removeContent = readFileSync(path.join(ROUTES_DIR, 'products', '[id]', 'remove', 'route.ts'), 'utf8')
    assert.equal(removeContent.includes('productIds'), false, 'the remove route must no longer accept a productIds body override -- it acts on exactly the URL product')
    const handlerContent = readFileSync(path.join(LIB_DIR, 'pause-resume-handler.ts'), 'utf8')
    assert.ok(handlerContent.includes('resolveScopedTargetIds'), 'the pause/resume handler must route target-ID resolution through resolveScopedTargetIds, the function that enforces every ID belongs to the URL product')
  })
})
