/**
 * Targeted tests for the order-ingestion phase of the Review Request
 * Automation workflow: src/lib/review-requests/order-ingestion.ts.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module, with its own self-contained fake admin harness
 * (matching scripts/test-review-requests.ts / the former
 * scripts/test-review-requests-daily.ts). Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-requests-ingestion.ts
 */
import assert from 'node:assert/strict'
import { runOrderIngestion, DEFAULT_ROLLING_OVERLAP_DAYS } from '../src/lib/review-requests/order-ingestion'
import type { ListOrdersResult } from '../src/lib/amazon/spapi-client'

// ── Fake in-memory review_solicitation_orders table ──────────────────────────

type Row = Record<string, unknown>
type FakeError = { code: string; message: string } | null

let idCounter = 1

function makeFakeAdmin(rows: Row[]) {
  function from(table: string) {
    void table
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: Row | null = null
    const filters: Array<{ op: 'eq'; col: string; val: unknown }> = []

    function applyFilters(candidates: Row[]): Row[] {
      return candidates.filter(r => filters.every(f => r[f.col] === f.val))
    }

    function runInsert(): { data: Row | null; error: FakeError } {
      const conflict = rows.find(
        r =>
          r.workspace_id === payload!.workspace_id &&
          r.marketplace_id === payload!.marketplace_id &&
          r.amazon_order_id === payload!.amazon_order_id,
      )
      if (conflict) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      const newRow: Row = { id: `row-${idCounter++}`, solicitation_sent: false, check_attempts: 0, ...payload }
      rows.push(newRow)
      return { data: newRow, error: null }
    }

    function runUpdate(): { data: Row[]; error: FakeError } {
      const matched = applyFilters(rows)
      for (const r of matched) {
        for (const [k, v] of Object.entries(payload!)) {
          if (v !== undefined) r[k] = v
        }
      }
      return { data: matched, error: null }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select(cols: string) {
        void cols
        if (mode !== 'insert' && mode !== 'update') mode = 'select'
        return builder
      },
      insert(p: Row) {
        mode = 'insert'
        payload = p
        return builder
      },
      update(p: Row) {
        mode = 'update'
        payload = p
        return builder
      },
      eq(col: string, val: unknown) {
        filters.push({ op: 'eq', col, val })
        return builder
      },
      async maybeSingle() {
        if (mode === 'select') {
          const result = applyFilters(rows)
          return { data: result[0] ?? null, error: null }
        }
        return { data: null, error: { code: 'UNSUPPORTED', message: 'maybeSingle in non-select mode' } }
      },
      async single() {
        if (mode === 'insert') return runInsert()
        if (mode === 'select') {
          const result = applyFilters(rows)
          if (result.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          return { data: result[0], error: null }
        }
        return { data: null, error: { code: 'UNSUPPORTED', message: 'single unsupported mode' } }
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        let result: { data: unknown; error: unknown }
        if (mode === 'update') result = runUpdate()
        else if (mode === 'select') result = { data: applyFilters(rows), error: null }
        else result = { data: null, error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return builder
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

const WS = 'ws-1'
const MP = 'A21TJRUUN4KGV'

function okOrdersPage(orders: ListOrdersResult['orders'] = [], nextToken: string | null = null): ListOrdersResult {
  return { ok: true, statusCode: 200, orders, nextToken, amazonErrorCode: null }
}

const tests: Array<[string, () => Promise<void> | void]> = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push([name, fn])
}

// ── 1. Rolling overlap fetch is idempotent ───────────────────────────────────
test('rolling 3-day fetch overlap is idempotent -- re-running with the same window never duplicates order rows', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const order = { amazonOrderId: 'ORDER-OVERLAP-1', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage([order])
  const deps = { admin, listOrdersFn, nowFn: () => new Date() }
  const params = { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', overlapDays: DEFAULT_ROLLING_OVERLAP_DAYS }

  const first = await runOrderIngestion(deps, params)
  const second = await runOrderIngestion(deps, params)

  assert.equal(first.ordersInserted, 1)
  assert.equal(second.ordersInserted, 0, 'second run must not re-insert the same order')
  assert.equal(second.ordersUpdated, 1)
  assert.equal(second.duplicatesPrevented, 1)
  assert.equal(rows.filter(r => r.amazon_order_id === 'ORDER-OVERLAP-1').length, 1, 'exactly one row must exist for the order')
})

// ── 2. Ingestion never touches eligibility/send state ────────────────────────
test('order ingestion is structurally separate from eligibility processing -- it has no eligibility-check or send dependency at all', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const order = { amazonOrderId: 'ORDER-NEW-1', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage([order])
  const report = await runOrderIngestion(
    { admin, listOrdersFn, nowFn: () => new Date() },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', overlapDays: 3 },
  )

  // runOrderIngestion's deps type has no getSolicitationFn/createSolicitationFn
  // parameter at all (see OrderIngestionDeps) -- this is a structural
  // (type-level) guarantee, not just a runtime one. At runtime: the new row
  // must land as 'pending' (the insert default), never any eligibility-check
  // or send-related status, since this phase never calls
  // claimForEligibilityCheck/recordEligibilityResult/claimForSendAttempt.
  assert.equal(report.ordersInserted, 1)
  assert.equal(rows[0].solicitation_status, 'pending')
  assert.equal(rows[0].solicitation_sent, false)
  assert.equal(rows[0].check_attempts, 0, 'ingestion must never touch check_attempts')
})

// ── 3. Pagination respects the page cap and stops on a failed page ──────────
test('ingestion pages until nextToken is exhausted or the API returns a failure, and records the safe error code', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  let calls = 0
  const listOrdersFn = async (): Promise<ListOrdersResult> => {
    calls += 1
    if (calls === 1) return okOrdersPage([{ amazonOrderId: 'ORDER-PAGE-1', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }], 'next-token-2')
    return { ok: false, statusCode: 429, orders: [], nextToken: null, amazonErrorCode: 'QuotaExceeded' }
  }
  const report = await runOrderIngestion(
    { admin, listOrdersFn, nowFn: () => new Date() },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', overlapDays: 3 },
  )

  assert.equal(calls, 2, 'must fetch the second page then stop after the failure')
  assert.equal(report.ordersInserted, 1)
  assert.equal(report.amazonErrorsByCode['QuotaExceeded'], 1)
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
