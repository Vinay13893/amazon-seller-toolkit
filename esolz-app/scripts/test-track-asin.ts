/**
 * Targeted tests for the Track ASIN archive/reinsert fix
 * (src/lib/supabase/asins.ts: addOrRestoreTrackedAsin).
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-track-asin.ts
 */
import assert from 'node:assert/strict'
import { addOrRestoreTrackedAsin, type AddAsinInput } from '../src/lib/supabase/asins'

// ── Minimal fake Supabase client ────────────────────────────────────────────
// Implements only the fluent chain that addOrRestoreTrackedAsin actually
// calls against `tracked_asins`: select().eq().eq().eq().maybeSingle(),
// update().eq().select().single(), insert().select().single().

type FakeRow = {
  id: string
  workspace_id: string
  asin: string
  marketplace: string
  product_title: string | null
  brand: string | null
  category: string | null
  image_url: string | null
  status: 'active' | 'paused' | 'archived'
  created_at: string
}

type FakeError = { code: string; message: string } | null

let nextId = 1

function makeFakeSupabase(rows: FakeRow[], opts?: { onBeforeInsert?: () => void; forceLookupError?: boolean }) {
  function findUniqueConflict(workspaceId: string, asin: string, marketplace: string) {
    return rows.find(r => r.workspace_id === workspaceId && r.asin === asin && r.marketplace === marketplace)
  }

  return {
    from(table: string) {
      void table // table name isn't branched on — this fake only ever backs `tracked_asins`
      let mode: 'select' | 'update' | 'insert' = 'select'
      let patch: Partial<FakeRow> = {}
      const filters: Array<[string, unknown]> = []

      const builder = {
        select(cols: string) {
          void cols // column list isn't used — this fake always returns full rows
          if (mode !== 'update' && mode !== 'insert') mode = 'select'
          return builder
        },
        eq(col: string, val: unknown) {
          filters.push([col, val])
          return builder
        },
        update(p: Partial<FakeRow>) {
          mode = 'update'
          patch = p
          return builder
        },
        insert(p: Partial<FakeRow>) {
          mode = 'insert'
          patch = p
          return builder
        },
        async maybeSingle(): Promise<{ data: FakeRow | null; error: FakeError }> {
          if (opts?.forceLookupError) return { data: null, error: { code: 'ECONN', message: 'network error' } }
          const match = rows.find(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val))
          return { data: match ?? null, error: null }
        },
        async single(): Promise<{ data: FakeRow | null; error: FakeError }> {
          if (mode === 'update') {
            const match = rows.find(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val))
            if (!match) return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
            Object.assign(match, patch)
            return { data: match, error: null }
          }
          if (mode === 'insert') {
            opts?.onBeforeInsert?.()
            const wsId = patch.workspace_id as string
            const asin = patch.asin as string
            const marketplace = patch.marketplace as string
            if (findUniqueConflict(wsId, asin, marketplace)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
            }
            const row: FakeRow = {
              id: `row-${nextId++}`,
              workspace_id: wsId,
              asin,
              marketplace,
              product_title: (patch.product_title as string) ?? null,
              brand: (patch.brand as string) ?? null,
              category: (patch.category as string) ?? null,
              image_url: (patch.image_url as string) ?? null,
              status: 'active',
              created_at: new Date().toISOString(),
            }
            rows.push(row)
            return { data: row, error: null }
          }
          return { data: null, error: { code: 'UNSUPPORTED', message: 'single() called in select mode' } }
        },
      }
      return builder
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const WORKSPACE_ID = 'ws-1'
const BASE_INPUT: AddAsinInput = {
  asin: 'B0BN5NZCGH',
  productTitle: 'Test Product',
  marketplace: 'IN',
  brand: 'TestBrand',
  category: 'Test Category',
  imageUrl: '',
}

function seedRow(overrides: Partial<FakeRow>): FakeRow {
  return {
    id: `row-${nextId++}`,
    workspace_id: WORKSPACE_ID,
    asin: BASE_INPUT.asin,
    marketplace: 'IN',
    product_title: 'Old Title',
    brand: 'OldBrand',
    category: 'Old Category',
    image_url: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const tests: Array<[string, () => Promise<void>]> = []
function test(name: string, fn: () => Promise<void>) {
  tests.push([name, fn])
}

// 1. New ASIN — no prior row, should insert and return 'added'.
test('new ASIN is added', async () => {
  const rows: FakeRow[] = []
  const supabase = makeFakeSupabase(rows)
  const result = await addOrRestoreTrackedAsin(WORKSPACE_ID, BASE_INPUT, supabase)

  assert.equal(result.outcome, 'added')
  assert.equal(result.product?.asin, BASE_INPUT.asin)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'active')
})

// 2. Already active ASIN — pre-existing active row, must not insert a duplicate.
test('already active ASIN returns already_active without duplicating', async () => {
  const existing = seedRow({ status: 'active' })
  const rows: FakeRow[] = [existing]
  const supabase = makeFakeSupabase(rows)
  const result = await addOrRestoreTrackedAsin(WORKSPACE_ID, BASE_INPUT, supabase)

  assert.equal(result.outcome, 'already_active')
  assert.equal(result.product?.id, existing.id)
  assert.equal(rows.length, 1, 'must not create a duplicate row')
})

// 3. Archived ASIN — must reactivate the same row (preserving id/history), not insert a new one.
test('archived ASIN is restored in place, preserving id and history', async () => {
  const existing = seedRow({ status: 'archived', product_title: 'Old Title' })
  const rows: FakeRow[] = [existing]
  const supabase = makeFakeSupabase(rows)
  const result = await addOrRestoreTrackedAsin(WORKSPACE_ID, BASE_INPUT, supabase)

  assert.equal(result.outcome, 'restored')
  assert.equal(result.product?.id, existing.id, 'must reuse the same row id so asin_snapshots history stays linked')
  assert.equal(rows.length, 1, 'must not create a duplicate row')
  assert.equal(rows[0].status, 'active')
  assert.equal(rows[0].product_title, BASE_INPUT.productTitle, 'restore should refresh display fields')
})

// 4. Concurrent duplicate attempt — a competing request commits its insert
//    between our lookup and our insert. Must resolve to the existing row,
//    never create a second row, and never crash.
test('concurrent duplicate attempt resolves without creating a duplicate', async () => {
  const rows: FakeRow[] = []
  const supabase = makeFakeSupabase(rows, {
    onBeforeInsert: () => {
      // Simulate another request winning the race just before our insert.
      if (rows.length === 0) rows.push(seedRow({ status: 'active' }))
    },
  })
  const result = await addOrRestoreTrackedAsin(WORKSPACE_ID, BASE_INPUT, supabase)

  assert.equal(result.outcome, 'already_active')
  assert.equal(rows.length, 1, 'must not create a duplicate row after losing the race')
})

// 5. Invalid ASIN — must reject before touching the database at all.
test('invalid ASIN is rejected without a database call', async () => {
  const rows: FakeRow[] = []
  let calledFrom = false
  const supabase = makeFakeSupabase(rows)
  const spied = { from: (t: string) => { calledFrom = true; return supabase.from(t) } }
  const result = await addOrRestoreTrackedAsin(WORKSPACE_ID, { ...BASE_INPUT, asin: 'not-an-asin' }, spied as never)

  assert.equal(result.outcome, 'invalid_asin')
  assert.equal(result.product, null)
  assert.equal(calledFrom, false, 'must validate format before any DB call')
  assert.equal(rows.length, 0)
})

async function main() {
  let failures = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`PASS  ${name}`)
    } catch (err) {
      failures += 1
      console.error(`FAIL  ${name}`)
      console.error(err instanceof Error ? err.message : err)
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`)
  if (failures > 0) process.exit(1)
}

void main()
