/**
 * Targeted tests for the bounded eligibility-processing phase of the Review
 * Request Automation workflow: src/lib/review-requests/eligibility-processor.ts,
 * the stale-claim reclaim (repository.ts#reclaimStaleCheckingClaims), and the
 * shared cron bearer-auth helper (src/lib/review-requests/cron-auth.ts).
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module, with its own self-contained fake admin harness
 * (matching scripts/test-review-requests.ts / scripts/test-review-requests-ingestion.ts).
 * Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-review-requests-eligibility-processor.ts
 */
import assert from 'node:assert/strict'
import {
  runEligibilityProcessing,
  DEFAULT_ELIGIBILITY_BATCH_SIZE,
  DEFAULT_RUNTIME_BUDGET_MS,
} from '../src/lib/review-requests/eligibility-processor'
import { reclaimStaleCheckingClaims, claimForSendAttempt, recordSendResult, findDueCandidates } from '../src/lib/review-requests/repository'
import { classifySendOutcome, TERMINAL_STATUSES } from '../src/lib/review-requests/policy'
import { isValidCronBearer } from '../src/lib/review-requests/cron-auth'
import type { SolicitationActionsResult, CreateSolicitationResult } from '../src/lib/amazon/spapi-client'

// ── Fake in-memory review_solicitation_orders table, with a real-trigger-like
// updated_at auto-stamp on every UPDATE (mirrors
// trg_review_solicitation_orders_updated_at, migration 059) ─────────────────

type Row = Record<string, unknown>
type FakeError = { code: string; message: string } | null

let idCounter = 1

function makeFakeAdmin(rows: Row[], getNow: () => Date) {
  function from(table: string) {
    void table
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: Row | null = null
    const filters: Array<{ op: 'eq' | 'in' | 'lte' | 'lt'; col: string; val: unknown }> = []
    const orderBy: Array<{ col: string; ascending: boolean }> = []
    let limitN: number | null = null

    function applyFilters(candidates: Row[]): Row[] {
      return candidates.filter(r =>
        filters.every(f => {
          if (f.op === 'eq') return r[f.col] === f.val
          if (f.op === 'in') return (f.val as unknown[]).includes(r[f.col])
          if (f.op === 'lte') return r[f.col] != null && (r[f.col] as string) <= (f.val as string)
          if (f.op === 'lt') return r[f.col] != null && (r[f.col] as string) < (f.val as string)
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
      const newRow: Row = { id: `row-${idCounter++}`, solicitation_sent: false, check_attempts: 0, updated_at: getNow().toISOString(), ...payload }
      rows.push(newRow)
      return { data: newRow, error: null }
    }

    function runUpdate(): { data: Row[]; error: FakeError } {
      const matched = applyFilters(rows)
      for (const r of matched) {
        for (const [k, v] of Object.entries(payload!)) {
          if (v !== undefined) r[k] = v
        }
        // Mirror trg_review_solicitation_orders_updated_at: every UPDATE
        // bumps updated_at, unconditionally -- this is exactly what
        // reclaimStaleCheckingClaims relies on being true in production.
        r.updated_at = getNow().toISOString()
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
      lt(col: string, val: unknown) {
        filters.push({ op: 'lt', col, val })
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
      async single() {
        if (mode === 'insert') return runInsert()
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

function seedRow(getNow: () => Date, overrides: Partial<Row> & { workspace_id: string; marketplace_id: string; amazon_order_id: string }): Row {
  return {
    id: `row-${idCounter++}`,
    order_status: 'Shipped',
    solicitation_status: 'pending',
    solicitation_sent: false,
    solicitation_sent_at: null,
    check_attempts: 0,
    next_check_at: new Date(getNow().getTime() - 1000).toISOString(),
    last_eligibility_response: null,
    last_error_code: null,
    last_error_message: null,
    claimed_at: null,
    claimed_by: null,
    claim_expires_at: null,
    updated_at: getNow().toISOString(),
    ...overrides,
  }
}

function makeClock(startMs: number) {
  let current = startMs
  return { now: () => new Date(current), advanceMs: (ms: number) => { current += ms } }
}

const WS = 'ws-1'
const MP = 'A21TJRUUN4KGV'
const ELIGIBLE_ACTIONS = ['productReviewAndSellerFeedback']

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

// ── 1. Batch cap is respected ─────────────────────────────────────────────────
test('the eligibility processor selects at most batchSize due candidates, even when more are due', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = Array.from({ length: 5 }, (_, i) =>
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-CAP-${i}` }),
  )
  const admin = makeFakeAdmin(rows, clock.now)
  const deps = {
    admin,
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async () => {}, nowFn: clock.now,
  }
  const report = await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 2, rateLimitMs: 1, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(report.candidatesSelected, 2, 'must never select more than batchSize, even with 5 due')
  assert.equal(report.candidatesCompleted, 2)
})

// ── 2. Runtime budget stops gracefully, finishing the in-flight candidate ────
test('the runtime budget stops claiming new candidates before it is exhausted and finishes the currently claimed one', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = Array.from({ length: 3 }, (_, i) =>
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-BUDGET-${i}` }),
  )
  const admin = makeFakeAdmin(rows, clock.now)
  const deps = {
    admin,
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    // Rate-limit sleep is where "time" moves in this simulation -- advance
    // past the tiny budget on the very first sleep, so candidate 1 still
    // finishes (the budget is only checked BEFORE claiming the next one).
    sleepFn: async () => { clock.advanceMs(500) },
    nowFn: clock.now,
  }
  const report = await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 10, rateLimitMs: 1, runtimeBudgetMs: 100, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(report.stoppedDueToRuntimeBudget, true)
  assert.equal(report.candidatesCompleted, 1, 'exactly the one in-flight candidate must finish before stopping')
})

// ── 3. Partial completion reports accurate counts ─────────────────────────────
test('a partial run (stopped by the runtime budget) returns accurate selected/completed/remaining counts', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = Array.from({ length: 3 }, (_, i) =>
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-PARTIAL-${i}` }),
  )
  const admin = makeFakeAdmin(rows, clock.now)
  const deps = {
    admin,
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async () => { clock.advanceMs(500) },
    nowFn: clock.now,
  }
  const report = await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 10, rateLimitMs: 1, runtimeBudgetMs: 100, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(report.candidatesSelected, 3)
  assert.equal(report.candidatesCompleted, 1)
  assert.equal(report.remaining, 2, 'remaining must equal selected minus completed')
})

// ── 4. Stale checking row is reclaimed ────────────────────────────────────────
test('a checking row older than the stale-claim TTL is reclaimed back to pending', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [
    seedRow(clock.now, {
      workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-STALE',
      solicitation_status: 'checking', next_check_at: null,
      updated_at: new Date(clock.now().getTime() - 20 * 60 * 1000).toISOString(), // 20 min ago
    }),
  ]
  const admin = makeFakeAdmin(rows, clock.now)
  const staleBeforeIso = new Date(clock.now().getTime() - 15 * 60 * 1000).toISOString()
  const reclaimed = await reclaimStaleCheckingClaims(admin, {
    workspaceId: WS, marketplaceId: MP, staleBeforeIso, nowIso: clock.now().toISOString(),
  })
  assert.equal(reclaimed, 1)
  assert.equal(rows[0].solicitation_status, 'pending')
  assert.ok(rows[0].next_check_at, 'reclaimed row must be immediately due again')
})

// ── 5. Fresh checking row is left untouched ───────────────────────────────────
test('a checking row within the stale-claim TTL (a fresh/active lease) is never reclaimed', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [
    seedRow(clock.now, {
      workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-FRESH',
      solicitation_status: 'checking', next_check_at: null,
      updated_at: new Date(clock.now().getTime() - 2 * 60 * 1000).toISOString(), // 2 min ago
    }),
  ]
  const admin = makeFakeAdmin(rows, clock.now)
  const staleBeforeIso = new Date(clock.now().getTime() - 15 * 60 * 1000).toISOString()
  const reclaimed = await reclaimStaleCheckingClaims(admin, {
    workspaceId: WS, marketplaceId: MP, staleBeforeIso, nowIso: clock.now().toISOString(),
  })
  assert.equal(reclaimed, 0, 'a fresh active lease must not be reclaimed')
  assert.equal(rows[0].solicitation_status, 'checking')
})

// ── 6. Reclaim cannot cause a duplicate send claim ────────────────────────────
test('reclaim only ever matches solicitation_status=checking -- a send_claimed row is never touched, regardless of its updated_at age', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [
    seedRow(clock.now, {
      workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-SEND-CLAIMED',
      solicitation_status: 'send_claimed', next_check_at: null,
      claimed_at: new Date(clock.now().getTime() - 30 * 60 * 1000).toISOString(),
      claim_expires_at: new Date(clock.now().getTime() - 20 * 60 * 1000).toISOString(),
      updated_at: new Date(clock.now().getTime() - 30 * 60 * 1000).toISOString(), // older than any reasonable TTL
    }),
  ]
  const admin = makeFakeAdmin(rows, clock.now)
  const staleBeforeIso = new Date(clock.now().getTime() - 15 * 60 * 1000).toISOString()

  const reclaimed = await reclaimStaleCheckingClaims(admin, {
    workspaceId: WS, marketplaceId: MP, staleBeforeIso, nowIso: clock.now().toISOString(),
  })
  assert.equal(reclaimed, 0, 'send_claimed is a different status -- reclaim must never match it')
  assert.equal(rows[0].solicitation_status, 'send_claimed', 'must remain send_claimed, not reset to pending')

  // The row can still be finalized normally afterward -- proves reclaim
  // caused no corruption of the in-flight send-claim state.
  const finalized = await recordSendResult(admin, rows[0].id as string, { toStatus: 'sent', evidence: null })
  assert.equal(finalized, true)
  assert.equal(rows[0].solicitation_status, 'sent')
  assert.equal(rows[0].solicitation_sent, true, 'exactly one send must be recorded -- no duplicate claim was possible')
})

// ── 7. Dry-run never POSTs ────────────────────────────────────────────────────
test('dry-run mode (default) never calls the create-solicitation POST function, even when eligible', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-DRYRUN' })]
  const admin = makeFakeAdmin(rows, clock.now)
  let createCalls = 0
  const deps = {
    admin,
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
    sleepFn: async () => {}, nowFn: clock.now,
  }
  const report = await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 10, rateLimitMs: 1, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(createCalls, 0, 'dry-run must never call the send function')
  assert.equal(report.sent, 0)
  assert.equal(report.eligibleDryRun, 1)
  assert.equal(rows[0].solicitation_status, 'eligible_dry_run')
  assert.equal(rows[0].solicitation_sent, false)
})

// ── 8. Live POST requires BOTH safety env conditions ─────────────────────────
test('live POST requires REVIEW_REQUESTS_ENABLED=true AND REVIEW_REQUESTS_DRY_RUN=false -- any other combination stays dry-run', async () => {
  const combos: Array<{ liveSendEnabled: boolean; dryRun: boolean; expectPost: boolean }> = [
    { liveSendEnabled: false, dryRun: true, expectPost: false },
    { liveSendEnabled: true, dryRun: true, expectPost: false },
    { liveSendEnabled: false, dryRun: false, expectPost: false },
    { liveSendEnabled: true, dryRun: false, expectPost: true },
  ]
  for (const combo of combos) {
    const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
    const rows: Row[] = [seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-COMBO-${combo.liveSendEnabled}-${combo.dryRun}` })]
    const admin = makeFakeAdmin(rows, clock.now)
    let createCalls = 0
    const deps = {
      admin,
      getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation(ELIGIBLE_ACTIONS),
      createSolicitationFn: async (): Promise<CreateSolicitationResult> => { createCalls += 1; return okCreate() },
      sleepFn: async () => {}, nowFn: clock.now,
    }
    const report = await runEligibilityProcessing(deps, {
      workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
      batchSize: 10, rateLimitMs: 1, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS, staleClaimTtlMinutes: 15,
      liveSendEnabled: combo.liveSendEnabled, dryRun: combo.dryRun, workerId: 'test-worker',
    })
    assert.equal(report.liveSendActive, combo.expectPost, `liveSendActive mismatch for ${JSON.stringify(combo)}`)
    assert.equal(createCalls > 0, combo.expectPost, `POST-call mismatch for ${JSON.stringify(combo)}`)
  }
})

// ── 9. Terminal and already-sent rows are excluded ────────────────────────────
test('every terminal status, and any already-sent row, is excluded from findDueCandidates -- process-eligibility never re-checks or re-sends them', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = TERMINAL_STATUSES.map(status =>
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: `ORDER-TERMINAL-${status}`, solicitation_status: status }),
  )
  rows.push(seedRow(clock.now, {
    workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-ALREADY-SENT',
    solicitation_status: 'sent', solicitation_sent: true, solicitation_sent_at: '2026-07-01T00:00:00Z', next_check_at: null,
  }))
  rows.push(seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-NONTERMINAL' }))
  const admin = makeFakeAdmin(rows, clock.now)

  const candidates = await findDueCandidates(admin, { workspaceId: WS, marketplaceId: MP, limit: 50, nowIso: clock.now().toISOString() })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].amazon_order_id, 'ORDER-NONTERMINAL')
})

// ── 10. One failed candidate does not abort the batch ─────────────────────────
test('one candidate throwing an unexpected error does not abort processing of the rest of the batch', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-THROW' }),
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-SUCCEED-1' }),
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-WILL-SUCCEED-2' }),
  ]
  const admin = makeFakeAdmin(rows, clock.now)
  const deps = {
    admin,
    getSolicitationFn: async (_token: string, params: { amazonOrderId: string }): Promise<SolicitationActionsResult> => {
      if (params.amazonOrderId === 'ORDER-WILL-THROW') throw new Error('simulated transient network failure')
      return okSolicitation([])
    },
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async () => {}, nowFn: clock.now,
  }
  const report = await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 10, rateLimitMs: 1, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(report.candidatesCompleted, 2, 'the two non-throwing candidates must still be completed')
  assert.equal(report.failedRetryable, 1, 'the thrown error must be counted, not propagated')
  assert.equal(rows.find(r => r.amazon_order_id === 'ORDER-WILL-SUCCEED-1')!.solicitation_status, 'not_eligible_retryable')
  assert.equal(rows.find(r => r.amazon_order_id === 'ORDER-WILL-SUCCEED-2')!.solicitation_status, 'not_eligible_retryable')
})

// ── 11. Rate limiter is applied ───────────────────────────────────────────────
test('the configured rate limit is applied once per completed candidate', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-A' }),
    seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RL-B' }),
  ]
  const admin = makeFakeAdmin(rows, clock.now)
  const sleepCalls: number[] = []
  const deps = {
    admin,
    getSolicitationFn: async (): Promise<SolicitationActionsResult> => okSolicitation([]),
    createSolicitationFn: async (): Promise<CreateSolicitationResult> => okCreate(),
    sleepFn: async (ms: number) => { sleepCalls.push(ms) },
    nowFn: clock.now,
  }
  await runEligibilityProcessing(deps, {
    workspaceId: WS, marketplaceId: MP, accessToken: 'tok',
    batchSize: 10, rateLimitMs: 1234, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS, staleClaimTtlMinutes: 15,
    liveSendEnabled: false, dryRun: true, workerId: 'test-worker',
  })
  assert.equal(sleepCalls.length, 2)
  assert.ok(sleepCalls.every(ms => ms === 1234))
})

// ── 12. Cron authentication is enforced ───────────────────────────────────────
test('the review-requests cron entry points reject a missing/wrong bearer token and only accept the exact configured secret', () => {
  assert.equal(isValidCronBearer(null, 'sekret'), false)
  assert.equal(isValidCronBearer('Bearer wrong', 'sekret'), false)
  assert.equal(isValidCronBearer('Bearer sekret', undefined), false, 'must fail closed when no secret is configured')
  assert.equal(isValidCronBearer('sekret', 'sekret'), false, 'must require the "Bearer " prefix')
  assert.equal(isValidCronBearer('Bearer sekret', 'sekret'), true)
})

// ── 13. Every-4-hours capacity covers expected daily volume ──────────────────
test('capacity: batch 120 at 1100ms fits the 220s runtime budget, and 6 runs/day covers expected volume with room for backlog decline', () => {
  const BATCH_SIZE = DEFAULT_ELIGIBILITY_BATCH_SIZE // 120
  const RATE_LIMIT_MS = 1100 // REVIEW_REQUESTS_RATE_LIMIT_MS default
  const RUNTIME_BUDGET_SECONDS = DEFAULT_RUNTIME_BUDGET_MS / 1000 // 220
  const ROUTE_MAX_DURATION_SECONDS = 280 // matches maxDuration in both new route.ts files
  const RUNS_PER_DAY = 6 // "0 */4 * * *"
  const EXPECTED_MAX_DAILY_NEW_ORDERS = 150

  const mandatoryThrottleSeconds = (BATCH_SIZE * RATE_LIMIT_MS) / 1000
  assert.ok(
    mandatoryThrottleSeconds < 140,
    `batch ${BATCH_SIZE} at ${RATE_LIMIT_MS}ms must be ~132s of mandatory throttling, got ${mandatoryThrottleSeconds}s`,
  )
  assert.ok(
    mandatoryThrottleSeconds < RUNTIME_BUDGET_SECONDS,
    `mandatory throttling (${mandatoryThrottleSeconds}s) must fit inside the ${RUNTIME_BUDGET_SECONDS}s internal budget, leaving room for GET/DB overhead`,
  )
  assert.ok(
    RUNTIME_BUDGET_SECONDS < ROUTE_MAX_DURATION_SECONDS,
    `internal budget (${RUNTIME_BUDGET_SECONDS}s) must stay comfortably under Vercel's ${ROUTE_MAX_DURATION_SECONDS}s hard ceiling`,
  )

  const dailyCapacity = BATCH_SIZE * RUNS_PER_DAY
  assert.equal(dailyCapacity, 720)
  assert.ok(
    dailyCapacity > EXPECTED_MAX_DAILY_NEW_ORDERS,
    `daily capacity (${dailyCapacity}) must exceed expected daily new-order volume (${EXPECTED_MAX_DAILY_NEW_ORDERS}) for the backlog to decline instead of grow`,
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

// ── Extra: two concurrent workers cannot both send for the same order ────────
test('two concurrent workers cannot both send for the same order (claimForSendAttempt + recordSendResult guards)', async () => {
  const clock = makeClock(Date.parse('2026-07-18T03:00:00Z'))
  const rows: Row[] = [seedRow(clock.now, { workspace_id: WS, marketplace_id: MP, amazon_order_id: 'ORDER-RACE-SEND', solicitation_status: 'eligible_dry_run', next_check_at: null })]
  const admin = makeFakeAdmin(rows, clock.now)
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
