/**
 * Targeted tests for the order-ingestion phase of the Review Request
 * Automation workflow: src/lib/review-requests/order-ingestion.ts.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module, with its own self-contained fake admin harness
 * (matching scripts/test-review-requests.ts / the eligibility-processor
 * test file). Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-requests-ingestion.ts
 */
import assert from 'node:assert/strict'
import {
  runOrderIngestion,
  DEFAULT_ROLLING_OVERLAP_DAYS,
  DEFAULT_INGEST_CONCURRENCY,
  DEFAULT_INGESTION_RUNTIME_BUDGET_MS,
} from '../src/lib/review-requests/order-ingestion'
import type { ListOrdersResult, OrderSummary } from '../src/lib/amazon/spapi-client'

// ── Fake in-memory review_solicitation_orders table, with optional
// concurrency tracking and a configurable per-call delay so tests can
// exercise bounded-concurrency behavior (matches the DB round-trip shape a
// real Supabase call has: one select, then one insert or update). ──────────

type Row = Record<string, unknown>
type FakeError = { code: string; message: string } | null

let idCounter = 1

interface ConcurrencyStats {
  active: number
  maxActive: number
}

function makeFakeAdmin(
  rows: Row[],
  opts?: { delayMs?: number; stats?: ConcurrencyStats; failForOrderId?: string },
) {
  const delayMs = opts?.delayMs ?? 0
  const stats = opts?.stats

  async function trackedDelay() {
    if (stats) {
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (stats) stats.active -= 1
  }

  function from(table: string) {
    void table
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: Row | null = null
    const filters: Array<{ op: 'eq'; col: string; val: unknown }> = []

    function applyFilters(candidates: Row[]): Row[] {
      return candidates.filter(r => filters.every(f => r[f.col] === f.val))
    }

    function runInsert(): { data: Row | null; error: FakeError } {
      if (opts?.failForOrderId && payload!.amazon_order_id === opts.failForOrderId) {
        return { data: null, error: { code: 'SIMULATED_DB_ERROR', message: 'forced failure for test' } }
      }
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
        await trackedDelay()
        if (mode === 'select') {
          const result = applyFilters(rows)
          return { data: result[0] ?? null, error: null }
        }
        return { data: null, error: { code: 'UNSUPPORTED', message: 'maybeSingle in non-select mode' } }
      },
      async single() {
        await trackedDelay()
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

function baseParams(overrides: Partial<Parameters<typeof runOrderIngestion>[1]> = {}) {
  return {
    workspaceId: WS,
    marketplaceId: MP,
    accessToken: 'tok',
    overlapDays: DEFAULT_ROLLING_OVERLAP_DAYS,
    concurrency: DEFAULT_INGEST_CONCURRENCY,
    runtimeBudgetMs: DEFAULT_INGESTION_RUNTIME_BUDGET_MS,
    ...overrides,
  }
}

function makeOrder(i: number): OrderSummary {
  return { amazonOrderId: `ORDER-${i}`, orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }
}

function makeClock(startMs: number) {
  let current = startMs
  return { now: () => new Date(current), advanceMs: (ms: number) => { current += ms } }
}

const tests: Array<[string, () => Promise<void> | void]> = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push([name, fn])
}

// ── 1. Rolling overlap fetch is idempotent ───────────────────────────────────
test('rolling 3-day fetch overlap is idempotent -- re-running with the same window never duplicates order rows', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const order = makeOrder(1)
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage([order])
  const deps = { admin, listOrdersFn, nowFn: () => new Date() }
  const params = baseParams()

  const first = await runOrderIngestion(deps, params)
  const second = await runOrderIngestion(deps, params)

  assert.equal(first.ordersInserted, 1)
  assert.equal(second.ordersInserted, 0, 'second run must not re-insert the same order')
  assert.equal(second.ordersUpdated, 1)
  assert.equal(second.duplicatesPrevented, 1)
  assert.equal(rows.filter(r => r.amazon_order_id === order.amazonOrderId).length, 1, 'exactly one row must exist for the order')
})

// ── 2. Ingestion never touches eligibility/send state ────────────────────────
test('order ingestion is structurally separate from eligibility processing -- it has no eligibility-check or send dependency at all', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const order = makeOrder(1)
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage([order])
  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

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
    if (calls === 1) return okOrdersPage([makeOrder(1)], 'next-token-2')
    return { ok: false, statusCode: 429, orders: [], nextToken: null, amazonErrorCode: 'QuotaExceeded' }
  }
  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

  assert.equal(calls, 2, 'must fetch the second page then stop after the failure')
  assert.equal(report.ordersInserted, 1)
  assert.equal(report.amazonErrorsByCode['QuotaExceeded'], 1)
  assert.equal(report.paginationComplete, false, 'an Amazon-side failure is not a natural pagination end')
})

// ── 4. 483 synthetic orders are all processed using bounded concurrency ──────
test('483 synthetic orders across multiple pages are all processed, using bounded concurrency', async () => {
  const stats: ConcurrencyStats = { active: 0, maxActive: 0 }
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows, { delayMs: 2, stats })

  const TOTAL = 483
  const PAGE_SIZE = 100
  const allOrders = Array.from({ length: TOTAL }, (_, i) => makeOrder(i))
  let cursor = 0
  const listOrdersFn = async (): Promise<ListOrdersResult> => {
    const page = allOrders.slice(cursor, cursor + PAGE_SIZE)
    cursor += PAGE_SIZE
    const nextToken = cursor < allOrders.length ? `token-${cursor}` : null
    return okOrdersPage(page, nextToken)
  }

  const report = await runOrderIngestion(
    { admin, listOrdersFn, nowFn: () => new Date() },
    baseParams({ concurrency: 8 }),
  )

  assert.equal(report.ordersFetched, TOTAL)
  assert.equal(report.ordersCompleted, TOTAL, 'every fetched order must be attempted to a resolved outcome')
  assert.equal(report.ordersInserted, TOTAL)
  assert.equal(report.ordersFailed, 0)
  assert.equal(report.paginationComplete, true)
  assert.equal(report.stoppedDueToRuntimeBudget, false)
  assert.equal(rows.length, TOTAL, 'no duplicate/missing rows')
})

// ── 5. Maximum simultaneous upserts never exceeds configured concurrency ─────
test('maximum simultaneous DB calls never exceeds the configured concurrency', async () => {
  const stats: ConcurrencyStats = { active: 0, maxActive: 0 }
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows, { delayMs: 5, stats })
  const orders = Array.from({ length: 40 }, (_, i) => makeOrder(i))
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage(orders)

  await runOrderIngestion(
    { admin, listOrdersFn, nowFn: () => new Date() },
    baseParams({ concurrency: 8 }),
  )

  assert.ok(stats.maxActive <= 8, `observed max concurrent DB calls (${stats.maxActive}) must never exceed the configured concurrency (8)`)
  assert.ok(stats.maxActive > 1, 'sanity check: this test must actually observe overlapping calls, not accidental full serialization')
})

// ── 6. Inserted/updated/failed totals reconcile with fetched orders ──────────
test('ordersInserted + ordersUpdated + ordersFailed always equals ordersCompleted, and reconciles with ordersFetched when pagination completes', async () => {
  const rows: Row[] = [
    { id: 'existing-1', workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-EXISTING', solicitation_sent: false, check_attempts: 0 },
  ]
  const admin = makeFakeAdmin(rows)
  const orders = [{ amazonOrderId: 'ORDER-EXISTING', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }, makeOrder(1), makeOrder(2)]
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage(orders)

  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

  assert.equal(report.ordersInserted + report.ordersUpdated + report.ordersFailed, report.ordersCompleted)
  assert.equal(report.ordersCompleted, report.ordersFetched, 'pagination completed naturally, so everything fetched must have been completed')
  assert.equal(report.ordersUpdated, 1, 'the pre-existing order must be counted as updated, not inserted')
  assert.equal(report.ordersInserted, 2)
})

// ── 7. Duplicate/idempotency behavior is unchanged ────────────────────────────
test('re-fetching the same order across a page boundary within one run never creates a duplicate row', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  let calls = 0
  const listOrdersFn = async (): Promise<ListOrdersResult> => {
    calls += 1
    // The same order id appears on two consecutive "pages" (a realistic
    // overlap scenario at a page boundary) -- must still resolve to one row.
    if (calls === 1) return okOrdersPage([makeOrder(1)], 'tok-2')
    return okOrdersPage([makeOrder(1)], null)
  }
  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

  assert.equal(rows.length, 1)
  assert.equal(report.ordersInserted, 1)
  assert.equal(report.ordersUpdated, 1, 'the second sighting in the same run must be an update, not a second insert')
})

// ── 8. Ingestion does not silently drop a failed order ────────────────────────
test('a failed upsert is counted in ordersFailed, never silently dropped, and does not abort the rest of the batch', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows, { failForOrderId: 'ORDER-WILL-FAIL' })
  const orders = [
    { amazonOrderId: 'ORDER-WILL-FAIL', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null },
    makeOrder(1),
    makeOrder(2),
  ]
  const listOrdersFn = async (): Promise<ListOrdersResult> => okOrdersPage(orders)

  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

  assert.equal(report.ordersFetched, 3)
  assert.equal(report.ordersFailed, 1)
  assert.equal(report.ordersInserted, 2, 'the other two orders must still succeed')
  assert.equal(report.ordersCompleted, 3, 'a failed order is still "completed" -- attempted to a resolved outcome')
  assert.equal(rows.length, 2, 'the failed order must never appear as a row')
})

// ── 9. Runtime guard returns an honest partial report ─────────────────────────
test('the runtime guard stops ingestion before it is exhausted and returns an honest partial report', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const PAGE_SIZE_LOCAL = 5
  let cursor = 0
  const totalOrders = 15
  const allOrders = Array.from({ length: totalOrders }, (_, i) => makeOrder(i))
  const listOrdersFn = async (): Promise<ListOrdersResult> => {
    clock.advanceMs(60) // simulate page-fetch latency
    const page = allOrders.slice(cursor, cursor + PAGE_SIZE_LOCAL)
    cursor += PAGE_SIZE_LOCAL
    const nextToken = cursor < allOrders.length ? `token-${cursor}` : null
    return okOrdersPage(page, nextToken)
  }

  const report = await runOrderIngestion(
    { admin, listOrdersFn, nowFn: clock.now },
    baseParams({ runtimeBudgetMs: 100 }), // trips after ~1-2 page fetches at 60ms each
  )

  assert.equal(report.stoppedDueToRuntimeBudget, true)
  assert.equal(report.paginationComplete, false, 'must never claim the full window was ingested')
  assert.ok(report.ordersCompleted < totalOrders, 'a partial run must not claim to have completed everything')
  assert.ok(report.partialIngestionNote && report.partialIngestionNote.length > 0, 'must explain the partial-run risk')
})

// ── 10. Pagination completion is reported accurately ──────────────────────────
test('pagesCompleted and paginationComplete accurately reflect a fully-processed window', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const PAGE_SIZE_LOCAL = 5
  let cursor = 0
  const totalOrders = 12 // 3 pages of 5, 5, 2
  const allOrders = Array.from({ length: totalOrders }, (_, i) => makeOrder(i))
  const listOrdersFn = async (): Promise<ListOrdersResult> => {
    const page = allOrders.slice(cursor, cursor + PAGE_SIZE_LOCAL)
    cursor += PAGE_SIZE_LOCAL
    const nextToken = cursor < allOrders.length ? `token-${cursor}` : null
    return okOrdersPage(page, nextToken)
  }

  const report = await runOrderIngestion({ admin, listOrdersFn, nowFn: () => new Date() }, baseParams())

  assert.equal(report.ordersApiPagesFetched, 3)
  assert.equal(report.pagesCompleted, 3)
  assert.equal(report.paginationComplete, true)
  assert.equal(report.partialIngestionNote, null, 'no partial-run note when pagination genuinely completed')
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
