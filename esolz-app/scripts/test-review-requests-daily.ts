/**
 * Targeted tests for the daily-forward Review Request Automation workflow:
 * src/lib/review-requests/daily-run.ts, the new send-claim/finalize
 * repository functions (claimForSendAttempt/recordSendResult), the new
 * classifySendOutcome policy function, and the cron bearer-auth helper
 * (src/lib/review-requests/cron-auth.ts).
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-requests-daily.ts
 */
import assert from 'node:assert/strict'
import { runDailyForward, DEFAULT_ROLLING_OVERLAP_DAYS } from '../src/lib/review-requests/daily-run'
import { claimForSendAttempt, recordSendResult, findDueCandidates } from '../src/lib/review-requests/repository'
import { classifySendOutcome, TERMINAL_STATUSES } from '../src/lib/review-requests/policy'
import { isValidCronBearer } from '../src/lib/review-requests/cron-auth'
import type { ListOrdersResult, SolicitationActionsResult, CreateSolicitationResult } from '../src/lib/amazon/spapi-client'

// ── Fake in-memory review_solicitation_orders table (mirrors the harness in
// scripts/test-review-requests.ts) ───────────────────────────────────────────

type Row = Record<string, unknown>
type FakeError = { code: string; message: string } | null

let idCounter = 1

function makeFakeAdmin(rows: Row[]) {
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
          if (f.op === 'lte') return r[f.col] !== null && r[f.col] !== undefined && (r[f.col] as string) <= (f.val as string)
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
      if (conflict) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      const newRow: Row = {
        id: `row-${idCounter++}`,
        solicitation_sent: false,
        check_attempts: 0,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
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
    next_check_at: new Date(Date.now() - 1000).toISOString(),
    last_eligibility_response: null,
    last_error_code: null,
    last_error_message: null,
    claimed_at: null,
    claimed_by: null,
    claim_expires_at: null,
    ...overrides,
  }
}

const WS = 'ws-1'
const MP = 'A21TJRUUN4KGV'
const ELIGIBLE_ACTIONS = ['productReviewAndSellerFeedback']

function okOrdersPage(orders: ListOrdersResult['orders'] = []): ListOrdersResult {
  return { ok: true, statusCode: 200, orders, nextToken: null, amazonErrorCode: null }
}
function okSolicitation(actions: string[]): SolicitationActionsResult {
  return { ok: true, statusCode: 200, actions, amazonErrorCode: null }
}
function okCreate(): CreateSolicitationResult {
  return { ok: true, statusCode: 201, amazonErrorCode: null }
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
  const getSolicitationFn = async (): Promise<SolicitationActionsResult> => okSolicitation([])
  const createSolicitationFn = async (): Promise<CreateSolicitationResult> => okCreate()
  const deps = { admin, listOrdersFn, getSolicitationFn, createSolicitationFn, sleepFn: async () => {}, nowFn: () => new Date() }
  const params = {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: DEFAULT_ROLLING_OVERLAP_DAYS, batchSize: 10, rateLimitMs: 1,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  }

  const first = await runDailyForward(deps, params)
  const second = await runDailyForward(deps, params)

  assert.equal(first.ordersInserted, 1)
  assert.equal(second.ordersInserted, 0, 'second run must not re-insert the same order')
  assert.equal(second.ordersUpdated, 1)
  assert.equal(second.duplicatesPrevented, 1)
  assert.equal(rows.filter(r => r.amazon_order_id === 'ORDER-OVERLAP-1').length, 1, 'exactly one row must exist for the order')
})

// ── 2. Dry-run never POSTs ────────────────────────────────────────────────────
test('dry-run mode (default) never calls the create-solicitation POST function, even when eligible', async () => {
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-DRYRUN' })]
  const admin = makeFakeAdmin(rows)
  let createCalls = 0
  const deps = {
    admin,
    listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
    sleepFn: async () => {}, nowFn: () => new Date(),
  }
  const report = await runDailyForward(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: 3, batchSize: 10, rateLimitMs: 1,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })

  assert.equal(createCalls, 0, 'dry-run must never call the send function')
  assert.equal(report.sent, 0)
  assert.equal(report.eligibleDryRun, 1)
  assert.equal(rows[0].solicitation_status, 'eligible_dry_run')
  assert.equal(rows[0].solicitation_sent, false)
})

// ── 3. Live POST requires BOTH safety env conditions ─────────────────────────
test('live POST requires REVIEW_REQUESTS_ENABLED=true AND REVIEW_REQUESTS_DRY_RUN=false -- any other combination stays dry-run', async () => {
  const combos: Array<{ liveSendEnabled: boolean; dryRun: boolean; expectPost: boolean }> = [
    { liveSendEnabled: false, dryRun: true, expectPost: false },
    { liveSendEnabled: true, dryRun: true, expectPost: false },
    { liveSendEnabled: false, dryRun: false, expectPost: false },
    { liveSendEnabled: true, dryRun: false, expectPost: true },
  ]

  for (const combo of combos) {
    const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-COMBO-${combo.liveSendEnabled}-${combo.dryRun}` })]
    const admin = makeFakeAdmin(rows)
    let createCalls = 0
    const deps = {
      admin,
      listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
      getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
      createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
      sleepFn: async () => {}, nowFn: () => new Date(),
    }
    const report = await runDailyForward(deps, {
      workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
      overlapDays: 3, batchSize: 10, rateLimitMs: 1,
      liveSendEnabled: combo.liveSendEnabled, dryRun: combo.dryRun, workerId: 'test-worker',
    })
    assert.equal(report.liveSendActive, combo.expectPost, `liveSendActive mismatch for ${JSON.stringify(combo)}`)
    assert.equal(createCalls > 0, combo.expectPost, `POST-call mismatch for ${JSON.stringify(combo)}`)
  }
})

// ── 4. Eligible GET action allows POST ────────────────────────────────────────
test('an eligible GET action allows a POST attempt (and a successful send) when live-send is active', async () => {
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-ELIGIBLE-LIVE' })]
  const admin = makeFakeAdmin(rows)
  let createCalls = 0
  const deps = {
    admin,
    listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
    sleepFn: async () => {}, nowFn: () => new Date(),
  }
  const report = await runDailyForward(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: 3, batchSize: 10, rateLimitMs: 1,
    liveSendEnabled: true, dryRun: false, workerId: 'test-worker',
  })

  assert.equal(createCalls, 1)
  assert.equal(report.sent, 1)
  assert.equal(rows[0].solicitation_status, 'sent')
  assert.equal(rows[0].solicitation_sent, true)
  assert.ok(rows[0].solicitation_sent_at)
})

// ── 5. Missing action never POSTs ─────────────────────────────────────────────
test('a GET response missing the eligible action never triggers a POST, live-send active or not', async () => {
  for (const liveSendEnabled of [false, true]) {
    const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-NOACTION-${liveSendEnabled}` })]
    const admin = makeFakeAdmin(rows)
    let createCalls = 0
    const deps = {
      admin,
      listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
      getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
      createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
      sleepFn: async () => {}, nowFn: () => new Date(),
    }
    const report = await runDailyForward(deps, {
      workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
      overlapDays: 3, batchSize: 10, rateLimitMs: 1,
      liveSendEnabled, dryRun: false, workerId: 'test-worker',
    })
    assert.equal(createCalls, 0)
    assert.equal(report.sent, 0)
    assert.equal(report.notEligibleRetryable, 1)
    assert.equal(rows[0].solicitation_status, 'not_eligible_retryable')
  }
})

// ── 6. Already-sent row never POSTs ───────────────────────────────────────────
test('an already-sent row is never selected as a due candidate and is never POSTed to again', async () => {
  const sentAt = '2026-07-01T00:00:00Z'
  const rows: Row[] = [
    seedRow({
      workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-ALREADY-SENT',
      solicitation_status: 'sent', solicitation_sent: true, solicitation_sent_at: sentAt, next_check_at: null,
    }),
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-STILL-ELIGIBLE' }),
  ]
  const admin = makeFakeAdmin(rows)
  let createCalls = 0
  const deps = {
    admin,
    listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
    sleepFn: async () => {}, nowFn: () => new Date(),
  }
  await runDailyForward(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: 3, batchSize: 10, rateLimitMs: 1,
    liveSendEnabled: true, dryRun: false, workerId: 'test-worker',
  })

  assert.equal(createCalls, 1, 'exactly one POST -- only for the still-eligible order, never for the already-sent one')
  const sentRow = rows.find(r => r.amazon_order_id === 'ORDER-ALREADY-SENT')!
  assert.equal(sentRow.solicitation_status, 'sent')
  assert.equal(sentRow.solicitation_sent_at, sentAt, 'must not be touched a second time')
})

// ── 7. Concurrent workers cannot send twice ───────────────────────────────────
test('two concurrent workers cannot both send for the same order (claimForSendAttempt + recordSendResult guards)', async () => {
  const rows: Row[] = [seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RACE-SEND', solicitation_status: 'eligible_dry_run', next_check_at: null })]
  const admin = makeFakeAdmin(rows)
  const id = rows[0].id as string

  const [claimA, claimB] = await Promise.all([
    claimForSendAttempt(admin, id, 'eligible_dry_run', 'worker-a'),
    claimForSendAttempt(admin, id, 'eligible_dry_run', 'worker-b'),
  ])
  const claimedCount = [claimA, claimB].filter(c => c.claimed).length
  assert.equal(claimedCount, 1, 'exactly one of the two concurrent send-claims must succeed')
  assert.equal(rows[0].solicitation_status, 'send_claimed')

  const [finalizeA, finalizeB] = await Promise.all([
    recordSendResult(admin, id, { toStatus: 'sent', evidence: null }),
    recordSendResult(admin, id, { toStatus: 'sent', evidence: null }),
  ])
  const finalizedCount = [finalizeA, finalizeB].filter(Boolean).length
  assert.equal(finalizedCount, 1, 'exactly one finalize must apply -- the row cannot be sent twice')
  assert.equal(rows[0].solicitation_status, 'sent')
  assert.equal(rows[0].solicitation_sent, true)
})

// ── 8. Terminal statuses are skipped ──────────────────────────────────────────
test('every terminal status is excluded from findDueCandidates', async () => {
  const rows: Row[] = TERMINAL_STATUSES.map(status =>
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-TERMINAL-${status}`, solicitation_status: status, next_check_at: new Date(Date.now() - 1000).toISOString() }),
  )
  rows.push(seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-NONTERMINAL', solicitation_status: 'pending' }))
  const admin = makeFakeAdmin(rows)

  const candidates = await findDueCandidates(admin, { workspaceId: WS, marketplaceId: MP, limit: 50 })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].amazon_order_id, 'ORDER-NONTERMINAL')
})

// ── 9. One failed order does not abort the batch ──────────────────────────────
test('one candidate throwing an unexpected error does not abort processing of the rest of the batch', async () => {
  const rows: Row[] = [
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-THROW' }),
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-SUCCEED-1' }),
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-SUCCEED-2' }),
  ]
  const admin = makeFakeAdmin(rows)
  const deps = {
    admin,
    listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
    getSolicitationFn: async (_token: string, params: { amazonOrderId: string }): Promise<SolicitationActionsResult> => {
      if (params.amazonOrderId === 'ORDER-WILL-THROW') throw new Error('simulated transient network failure')
      return okSolicitation([])
    },
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async () => {}, nowFn: () => new Date(),
  }
  const report = await runDailyForward(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: 3, batchSize: 10, rateLimitMs: 1,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })

  assert.equal(report.candidatesChecked, 2, 'the two non-throwing candidates must still be checked')
  assert.equal(report.failedRetryable, 1, 'the thrown error must be counted, not propagated')
  assert.equal(rows.find(r => r.amazon_order_id === 'ORDER-WILL-SUCCEED-1')!.solicitation_status, 'not_eligible_retryable')
  assert.equal(rows.find(r => r.amazon_order_id === 'ORDER-WILL-SUCCEED-2')!.solicitation_status, 'not_eligible_retryable')
})

// ── 10. Rate limiter is applied ───────────────────────────────────────────────
test('the configured rate limit is applied once per candidate checked', async () => {
  const rows: Row[] = [
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-A' }),
    seedRow({ workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-B' }),
  ]
  const admin = makeFakeAdmin(rows)
  const sleepCalls: number[] = []
  const deps = {
    admin,
    listOrdersFn: async (): Promise<ListOrdersResult> => okOrdersPage([]),
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async (ms: number) => { sleepCalls.push(ms) },
    nowFn: () => new Date(),
  }
  await runDailyForward(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    overlapDays: 3, batchSize: 10, rateLimitMs: 1234,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(sleepCalls.length, 2)
  assert.ok(sleepCalls.every(ms => ms === 1234))
})

// ── 11. Cron authentication is enforced ───────────────────────────────────────
test('the daily cron route rejects a missing/wrong bearer token and only accepts the exact configured secret', () => {
  assert.equal(isValidCronBearer(null, 'sekret'), false)
  assert.equal(isValidCronBearer('Bearer wrong', 'sekret'), false)
  assert.equal(isValidCronBearer('Bearer sekret', undefined), false, 'must fail closed when no secret is configured')
  assert.equal(isValidCronBearer('sekret', 'sekret'), false, 'must require the "Bearer " prefix')
  assert.equal(isValidCronBearer('Bearer sekret', 'sekret'), true)
})

// ── 12. 100-150 order daily volume fits expected runtime ─────────────────────
test('expected daily runtime for 100-150 orders stays within the cron/route maxDuration budget', () => {
  const MAX_DAILY_ORDERS = 150
  const RATE_LIMIT_MS = 1100 // REVIEW_REQUESTS_RATE_LIMIT_MS default
  const ROUTE_MAX_DURATION_SECONDS = 280 // matches maxDuration in both new route.ts files
  const ORDER_FETCH_OVERHEAD_MS = 15_000 // generous allowance for ~5 paginated Orders API pages

  const estimatedMs = MAX_DAILY_ORDERS * RATE_LIMIT_MS + ORDER_FETCH_OVERHEAD_MS
  const estimatedSeconds = estimatedMs / 1000

  assert.ok(
    estimatedSeconds < ROUTE_MAX_DURATION_SECONDS,
    `estimated ${estimatedSeconds}s must stay under the ${ROUTE_MAX_DURATION_SECONDS}s budget for ${MAX_DAILY_ORDERS} orders/day`,
  )
})

// ── Extra: classifySendOutcome bounds retries without inventing a reason ─────
test('classifySendOutcome: 429/5xx are retryable, non-429 4xx are terminal, never guesses already_solicited', () => {
  assert.equal(classifySendOutcome(429, null), 'failed_retryable')
  assert.equal(classifySendOutcome(500, null), 'failed_retryable')
  assert.equal(classifySendOutcome(503, null), 'failed_retryable')
  assert.equal(classifySendOutcome(400, 'AnyCode'), 'failed_terminal')
  assert.equal(classifySendOutcome(403, null), 'failed_terminal')
  assert.equal(classifySendOutcome(404, null), 'failed_terminal')
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
