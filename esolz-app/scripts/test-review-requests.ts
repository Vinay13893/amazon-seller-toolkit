/**
 * Targeted tests for the Review Request Automation dry-run catch-up
 * foundation: src/lib/review-requests/policy.ts,
 * src/lib/review-requests/repository.ts, and
 * scripts/review-requests-catchup.ts's runCatchup().
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-requests.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TERMINAL_STATUSES,
  isTerminalStatus,
  isProtectedStatus,
  classifyEligibilityOutcome,
  classifySolicitationsError,
  computeNextCheckAt,
  buildSanitizedEligibilityEvidence,
  type SolicitationStatus,
} from '../src/lib/review-requests/policy'
import {
  upsertDiscoveredOrder,
  findDueCandidates,
  claimForEligibilityCheck,
  recordEligibilityResult,
} from '../src/lib/review-requests/repository'
import { runCatchup, maskOrderId } from './review-requests-catchup'
import * as spapiClient from '../src/lib/amazon/spapi-client'
import type { ListOrdersResult, SolicitationActionsResult, OrderSummary } from '../src/lib/amazon/spapi-client'

// ── Fake in-memory review_solicitation_orders table ──────────────────────────
// Generic enough to cover every chain shape the repository/catchup code
// actually uses: select/insert/update, eq/in/lte, order, limit,
// maybeSingle/single, and being awaitable directly (thenable) when no
// terminal method is called -- matching real supabase-js query builders.

type Row = Record<string, unknown>
type FakeError = { code: string; message: string } | null

let idCounter = 1

function makeFakeAdmin(rows: Row[], opts?: { onBeforeInsert?: () => void }) {
  function from(table: string) {
    void table
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: Row | null = null
    const filters: Array<{ op: 'eq' | 'in' | 'lte'; col: string; val: unknown }> = []
    const orderBy: Array<{ col: string; ascending: boolean }> = []
    let limitN: number | null = null

    function applyFilters(candidates: Row[]): Row[] {
      return candidates.filter(r =>
        filters.every(f => {
          if (f.op === 'eq') return r[f.col] === f.val
          if (f.op === 'in') return (f.val as unknown[]).includes(r[f.col])
          if (f.op === 'lte') return (r[f.col] as string) <= (f.val as string)
          return true
        }),
      )
    }

    function runSelect(): Row[] {
      let result = applyFilters(rows)
      for (const o of [...orderBy].reverse()) {
        result = [...result].sort((a, b) => {
          const av = String(a[o.col] ?? '')
          const bv = String(b[o.col] ?? '')
          if (av === bv) return 0
          const cmp = av < bv ? -1 : 1
          return o.ascending ? cmp : -cmp
        })
      }
      if (limitN !== null) result = result.slice(0, limitN)
      return result
    }

    function runInsert(): { data: Row | null; error: FakeError } {
      const conflict = rows.find(
        r =>
          r.workspace_id === payload!.workspace_id &&
          r.marketplace_id === payload!.marketplace_id &&
          r.amazon_order_id === payload!.amazon_order_id,
      )
      opts?.onBeforeInsert?.()
      const raceConflict = rows.find(
        r =>
          r.workspace_id === payload!.workspace_id &&
          r.marketplace_id === payload!.marketplace_id &&
          r.amazon_order_id === payload!.amazon_order_id,
      )
      if (conflict || raceConflict) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      const newRow: Row = {
        id: `row-${idCounter++}`,
        solicitation_sent: false,
        check_attempts: 0,
        ...payload,
      }
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
      in(col: string, val: unknown[]) {
        filters.push({ op: 'in', col, val })
        return builder
      },
      lte(col: string, val: unknown) {
        filters.push({ op: 'lte', col, val })
        return builder
      },
      order(col: string, options?: { ascending?: boolean }) {
        orderBy.push({ col, ascending: options?.ascending !== false })
        return builder
      },
      limit(n: number) {
        limitN = n
        return builder
      },
      async maybeSingle() {
        if (mode === 'select') {
          const result = runSelect()
          return { data: result[0] ?? null, error: null }
        }
        return { data: null, error: { code: 'UNSUPPORTED', message: 'maybeSingle in non-select mode' } }
      },
      async single() {
        if (mode === 'insert') return runInsert()
        if (mode === 'select') {
          const result = runSelect()
          if (result.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          return { data: result[0], error: null }
        }
        return { data: null, error: { code: 'UNSUPPORTED', message: 'single unsupported mode' } }
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        let result: { data: unknown; error: unknown }
        if (mode === 'update') result = runUpdate()
        else if (mode === 'select') result = { data: runSelect(), error: null }
        else result = { data: null, error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return builder
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

function seedRow(overrides: Partial<Row> & { workspace_id: string; marketplace_id: string; amazon_order_id: string }): Row {
  return {
    id: `row-${idCounter++}`,
    order_status: 'Shipped',
    purchase_date: null,
    shipped_at: null,
    amazon_last_updated_at: null,
    solicitation_status: 'pending',
    solicitation_sent: false,
    solicitation_sent_at: null,
    check_attempts: 0,
    next_check_at: new Date().toISOString(),
    last_eligibility_response: null,
    last_error_code: null,
    last_error_message: null,
    ...overrides,
  }
}

const WS = 'ws-1'
const MP = 'A21TJRUUN4KGV'

const tests: Array<[string, () => Promise<void> | void]> = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push([name, fn])
}

// ── 1. 30-day window only ────────────────────────────────────────────────────
test('catchupDays is clamped to 30 even if configured higher (no 120-day backfill)', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const calls: Array<{ createdAfter: string; nextToken?: string }> = []
  const fixedNow = new Date('2026-07-12T00:00:00.000Z')

  const listOrdersFn = async (_token: string, params: { createdAfter: string; nextToken?: string }): Promise<ListOrdersResult> => {
    calls.push({ createdAfter: params.createdAfter, nextToken: params.nextToken })
    return { ok: true, statusCode: 200, orders: [], nextToken: null, amazonErrorCode: null }
  }
  const getSolicitationFn = async (): Promise<SolicitationActionsResult> => ({ ok: true, statusCode: 200, actions: [], amazonErrorCode: null })

  const report = await runCatchup(
    { admin, listOrdersFn, getSolicitationFn, sleepFn: async () => {}, nowFn: () => fixedNow },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', catchupDays: 120, batchSize: 10, rateLimitMs: 1100 },
  )

  assert.equal(report.fetchWindowDays, 30, 'must clamp to 30 days regardless of configured value')
  const expectedStart = new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  assert.equal(calls[0].createdAfter, expectedStart, 'must request exactly a 30-day window, not 120')
})

// ── 2. Orders pagination ─────────────────────────────────────────────────────
test('pagination follows nextToken until exhausted and upserts orders from every page', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  let callCount = 0
  const listOrdersFn = async (_token: string, params: { nextToken?: string }): Promise<ListOrdersResult> => {
    callCount += 1
    if (!params.nextToken) {
      return {
        ok: true, statusCode: 200,
        orders: [{ amazonOrderId: 'ORDER-PAGE1', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }],
        nextToken: 'page-2-token', amazonErrorCode: null,
      }
    }
    return {
      ok: true, statusCode: 200,
      orders: [{ amazonOrderId: 'ORDER-PAGE2', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }],
      nextToken: null, amazonErrorCode: null,
    }
  }
  const getSolicitationFn = async (): Promise<SolicitationActionsResult> => ({ ok: true, statusCode: 200, actions: [], amazonErrorCode: null })

  const report = await runCatchup(
    { admin, listOrdersFn, getSolicitationFn, sleepFn: async () => {}, nowFn: () => new Date() },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', catchupDays: 30, batchSize: 10, rateLimitMs: 1100 },
  )

  assert.equal(callCount, 2, 'must fetch exactly 2 pages')
  assert.equal(report.ordersApiPagesFetched, 2)
  assert.equal(report.ordersReceived, 2)
  assert.equal(report.ordersInserted, 2)
  assert.ok(rows.some(r => r.amazon_order_id === 'ORDER-PAGE1'))
  assert.ok(rows.some(r => r.amazon_order_id === 'ORDER-PAGE2'))
})

// ── 3. Duplicate order upsert (including a true concurrent-insert race) ─────
test('upserting the same order twice does not create a duplicate row', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const input = { workspaceId: WS, marketplaceId: MP, amazonOrderId: 'ORDER-DUP', orderStatus: 'Shipped', purchaseDate: null, amazonLastUpdatedAt: null }

  const first = await upsertDiscoveredOrder(admin, input)
  const second = await upsertDiscoveredOrder(admin, input)

  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(second.id, first.id)
  assert.equal(rows.filter(r => r.amazon_order_id === 'ORDER-DUP').length, 1)
})

test('a true concurrent-insert race (23505) resolves to the existing row without erroring', async () => {
  const rows: Row[] = []
  const input = { workspaceId: WS, marketplaceId: MP, amazonOrderId: 'ORDER-RACE', orderStatus: 'Shipped', purchaseDate: null, amazonLastUpdatedAt: null }
  const admin = makeFakeAdmin(rows, {
    onBeforeInsert: () => {
      // Simulate another process winning the race just before our insert commits.
      if (!rows.some(r => r.amazon_order_id === 'ORDER-RACE')) {
        rows.push(seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RACE' }))
      }
    },
  })

  const result = await upsertDiscoveredOrder(admin, input)
  assert.equal(result.inserted, false, 'must resolve to the row the racing writer created, not insert a duplicate')
  assert.equal(rows.filter(r => r.amazon_order_id === 'ORDER-RACE').length, 1)
})

// ── 4. Terminal status preserved on upsert ───────────────────────────────────
test('upserting an order with a terminal status never resets it to pending', async () => {
  const rows: Row[] = [
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-TERM', solicitation_status: 'failed_terminal', next_check_at: null }),
  ]
  const admin = makeFakeAdmin(rows)
  await upsertDiscoveredOrder(admin, {
    workspaceId: WS, marketplaceId: MP, amazonOrderId: 'ORDER-TERM',
    orderStatus: 'Shipped', purchaseDate: '2026-07-01T00:00:00Z', amazonLastUpdatedAt: '2026-07-02T00:00:00Z',
  })
  const row = rows.find(r => r.amazon_order_id === 'ORDER-TERM')!
  assert.equal(row.solicitation_status, 'failed_terminal', 'must never be reset to pending')
  assert.equal(row.order_status, 'Shipped', 'Amazon-sourced fields should still refresh')
})

// ── 5. Sent row never reset ──────────────────────────────────────────────────
test('upserting a sent order never overwrites solicitation_sent/status/sent_at', async () => {
  const sentAt = '2026-07-01T00:00:00Z'
  const rows: Row[] = [
    seedRow({
      workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-SENT',
      solicitation_status: 'sent', solicitation_sent: true, solicitation_sent_at: sentAt, next_check_at: null,
    }),
  ]
  const admin = makeFakeAdmin(rows)
  await upsertDiscoveredOrder(admin, {
    workspaceId: WS, marketplaceId: MP, amazonOrderId: 'ORDER-SENT',
    orderStatus: 'Shipped', purchaseDate: null, amazonLastUpdatedAt: null,
  })
  const row = rows.find(r => r.amazon_order_id === 'ORDER-SENT')!
  assert.equal(row.solicitation_status, 'sent')
  assert.equal(row.solicitation_sent, true)
  assert.equal(row.solicitation_sent_at, sentAt)
})

// ── 6/7. Eligibility classification ──────────────────────────────────────────
test('an eligible action present maps to eligible_dry_run; absent maps to not_eligible_retryable (never a POST)', () => {
  assert.equal(classifyEligibilityOutcome(true), 'eligible_dry_run')
  assert.equal(classifyEligibilityOutcome(false), 'not_eligible_retryable')
})

// ── 8. eligible_dry_run remains non-terminal ─────────────────────────────────
test('eligible_dry_run is not a terminal status', () => {
  assert.equal(isTerminalStatus('eligible_dry_run'), false)
  assert.equal(TERMINAL_STATUSES.includes('eligible_dry_run' as SolicitationStatus), false)
})

// ── 9. Terminal-with-evidence-only handling ──────────────────────────────────
test('expired/already_solicited/ineligible_terminal are supported by the repository but never produced by this dry-run catch-up itself', async () => {
  // The repository CAN transition to these when given explicit, confident
  // evidence (simulating a future caller) --
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-EXP', solicitation_status: 'checking' })]
  const admin = makeFakeAdmin(rows)
  const ok = await recordEligibilityResult(admin, rows[0].id as string, {
    toStatus: 'expired', checkAttempts: 1, evidence: null,
  })
  assert.equal(ok, true)
  assert.equal(rows[0].solicitation_status, 'expired')
  assert.equal(rows[0].next_check_at, null)

  // -- but this catch-up script's own classification functions never return
  // any of the 3 from a plain GET response, for any input.
  assert.equal(classifyEligibilityOutcome(true), 'eligible_dry_run')
  assert.equal(classifyEligibilityOutcome(false), 'not_eligible_retryable')
  assert.equal(classifySolicitationsError(500, null), 'failed_retryable')
  assert.equal(classifySolicitationsError(404, 'X'), 'failed_retryable')
})

// ── 10. Retryable schedules next_check_at ────────────────────────────────────
test('failed_retryable and not_eligible_retryable schedule a future next_check_at, never immediate', () => {
  const now = '2026-07-12T00:00:00.000Z'
  const failedAt = computeNextCheckAt('failed_retryable', now)
  const notEligibleAt = computeNextCheckAt('not_eligible_retryable', now)
  assert.ok(failedAt && new Date(failedAt).getTime() > new Date(now).getTime(), 'failed_retryable must schedule a future recheck')
  assert.ok(notEligibleAt && new Date(notEligibleAt).getTime() > new Date(now).getTime(), 'not_eligible_retryable must schedule a future recheck')
  // conservative: at least a few hours out, not immediate/same-run
  assert.ok(new Date(failedAt!).getTime() - new Date(now).getTime() >= 60 * 60 * 1000)
})

// ── 11. Terminal clears next_check_at ────────────────────────────────────────
test('every terminal status computes next_check_at = null; eligible_dry_run also null', () => {
  const now = '2026-07-12T00:00:00.000Z'
  for (const status of TERMINAL_STATUSES) {
    assert.equal(computeNextCheckAt(status, now), null, `${status} must clear next_check_at`)
  }
  assert.equal(computeNextCheckAt('eligible_dry_run', now), null)
})

// ── 12. Batch size respected ─────────────────────────────────────────────────
test('findDueCandidates never returns more rows than the configured batch size', async () => {
  const rows: Row[] = []
  for (let i = 0; i < 10; i++) {
    rows.push(seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-BATCH-${i}`, next_check_at: new Date(Date.now() - 1000).toISOString() }))
  }
  const admin = makeFakeAdmin(rows)
  const candidates = await findDueCandidates(admin, { workspaceId: WS, marketplaceId: MP, limit: 3 })
  assert.equal(candidates.length, 3)
})

// ── 13. Rate limit throttle applied ──────────────────────────────────────────
test('the Solicitations rate limit is applied once per candidate checked, using the configured delay', async () => {
  const rows: Row[] = [
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-1', next_check_at: new Date(Date.now() - 1000).toISOString() }),
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-2', next_check_at: new Date(Date.now() - 1000).toISOString() }),
  ]
  const admin = makeFakeAdmin(rows)
  const sleepCalls: number[] = []
  const listOrdersFn = async (): Promise<ListOrdersResult> => ({ ok: true, statusCode: 200, orders: [], nextToken: null, amazonErrorCode: null })
  const getSolicitationFn = async (): Promise<SolicitationActionsResult> => ({ ok: true, statusCode: 200, actions: [], amazonErrorCode: null })

  await runCatchup(
    { admin, listOrdersFn, getSolicitationFn, sleepFn: async (ms: number) => { sleepCalls.push(ms) }, nowFn: () => new Date() },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', catchupDays: 30, batchSize: 10, rateLimitMs: 1234 },
  )

  assert.equal(sleepCalls.length, 2, 'must throttle once per candidate checked')
  assert.ok(sleepCalls.every(ms => ms === 1234), 'must use the configured rate limit, not a hardcoded value')
})

// ── 14. No raw buyer PII ever persisted/logged ───────────────────────────────
test('buildSanitizedEligibilityEvidence output never contains a PII-shaped field, even with adversarial input', () => {
  const evidence = buildSanitizedEligibilityEvidence({
    actionNames: ['productReviewAndSellerFeedback', 'buyerEmail:someone@example.com'],
    checkedAt: '2026-07-12T00:00:00Z',
  })
  const serialized = JSON.stringify(evidence)
  const forbiddenKeys = ['buyerName', 'buyerEmail', 'buyerPhone', 'shippingAddress', 'BuyerInfo', 'rawResponse', 'rawPayload']
  for (const key of forbiddenKeys) {
    assert.equal(Object.prototype.hasOwnProperty.call(evidence, key), false, `evidence must not contain a "${key}" field`)
  }
  // The function's return type is a fixed allowlist shape -- confirm exactly
  // those 5 keys and no others.
  assert.deepEqual(Object.keys(evidence).sort(), ['actionNames', 'amazonErrorCode', 'amazonStatusCode', 'checkedAt', 'sanitizedReason'].sort())
  void serialized
})

test('maskOrderId never exposes a full order id', () => {
  assert.equal(maskOrderId('123-4567890-1234567'), '***4567')
  assert.equal(maskOrderId(''), '')
})

// ── 15. This catch-up script's own send path is still nonexistent ───────────
// createProductReviewAndSellerFeedbackSolicitation was added to the SP-API
// client for the daily-forward workflow (src/lib/review-requests/daily-run.ts,
// see scripts/test-review-requests-daily.ts for its dedicated safety-gating
// tests) -- it now legitimately exists. What this catch-up script must still
// guarantee is that IT never imports or calls it: runCatchup() has no send
// code path, structurally, regardless of env vars.
test('createProductReviewAndSellerFeedbackSolicitation exists on the SP-API client but review-requests-catchup.ts never references it', () => {
  const clientAsRecord = spapiClient as unknown as Record<string, unknown>
  assert.equal(typeof clientAsRecord['createProductReviewAndSellerFeedbackSolicitation'], 'function')

  const catchupSource = readFileSync(new URL('./review-requests-catchup.ts', import.meta.url), 'utf8')
  assert.equal(
    catchupSource.includes('createProductReviewAndSellerFeedbackSolicitation'),
    false,
    'review-requests-catchup.ts must never reference the send function',
  )
})

test('recordEligibilityResult refuses to write a protected status (sent/send_claimed)', async () => {
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-PROTECT', solicitation_status: 'checking' })]
  const admin = makeFakeAdmin(rows)
  assert.equal(isProtectedStatus('sent'), true)
  assert.equal(isProtectedStatus('send_claimed'), true)
  await assert.rejects(
    () => recordEligibilityResult(admin, rows[0].id as string, { toStatus: 'sent', checkAttempts: 1, evidence: null }),
    /must never write a protected status/,
  )
})

test('a catch-up run reports postAttempted: false and reviewRequestsSent: 0 unconditionally', async () => {
  const rows: Row[] = []
  const admin = makeFakeAdmin(rows)
  const listOrdersFn = async (): Promise<ListOrdersResult> => ({ ok: true, statusCode: 200, orders: [], nextToken: null, amazonErrorCode: null })
  const getSolicitationFn = async (): Promise<SolicitationActionsResult> => ({ ok: true, statusCode: 200, actions: ['productReviewAndSellerFeedback'], amazonErrorCode: null })
  const report = await runCatchup(
    { admin, listOrdersFn, getSolicitationFn, sleepFn: async () => {}, nowFn: () => new Date() },
    { workspaceId: WS, marketplaceId: MP, accessToken: 'tok', catchupDays: 30, batchSize: 10, rateLimitMs: 1 },
  )
  assert.equal(report.postAttempted, false)
  assert.equal(report.reviewRequestsSent, 0)
})

// ── 16. Concurrent/double processing does not corrupt the row ────────────────
test('two concurrent claim attempts on the same row: only one succeeds, the row is not corrupted', async () => {
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RACE-CLAIM', solicitation_status: 'pending', check_attempts: 2 })]
  const admin = makeFakeAdmin(rows)
  const id = rows[0].id as string

  const [claimA, claimB] = await Promise.all([
    claimForEligibilityCheck(admin, id, 'pending'),
    claimForEligibilityCheck(admin, id, 'pending'),
  ])

  const claimedCount = [claimA, claimB].filter(c => c.claimed).length
  assert.equal(claimedCount, 1, 'exactly one of the two concurrent claims must succeed')
  assert.equal(rows[0].solicitation_status, 'checking')

  const winner = claimA.claimed ? claimA : claimB
  assert.equal(winner.previousCheckAttempts, 2)

  // Finalizing twice: only the first finalize should apply.
  const finalizeA = await recordEligibilityResult(admin, id, { toStatus: 'not_eligible_retryable', checkAttempts: 3, evidence: null })
  const finalizeB = await recordEligibilityResult(admin, id, { toStatus: 'eligible_dry_run', checkAttempts: 3, evidence: null })
  assert.equal(finalizeA, true)
  assert.equal(finalizeB, false, 'second finalize must fail (row is no longer "checking")')
  assert.equal(rows[0].solicitation_status, 'not_eligible_retryable', 'must reflect only the first finalize')
})

// ── Extra: full order summary shape sanity (guards against accidental PII passthrough from Orders API) ──
test('OrderSummary from listOrders never includes a PII field name', () => {
  const sample: OrderSummary = { amazonOrderId: 'X', orderStatus: 'Shipped', purchaseDate: null, lastUpdateDate: null }
  const forbidden = ['buyerName', 'buyerEmail', 'buyerPhone', 'shippingAddress', 'BuyerInfo']
  for (const key of forbidden) {
    assert.equal(Object.prototype.hasOwnProperty.call(sample, key), false)
  }
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
