/**
 * Targeted tests for the stale-running reclaim fix
 * (scripts/process-asin-checker-jobs.ts: reclaimStuckJob).
 *
 * Root cause this covers: cleanupStuckJobs() used to count a stuck job as
 * "reset" the moment it issued the UPDATE, without checking whether the
 * write actually matched a row. Cross-referenced against two live
 * "Stuck reset: 10" Render log events (2026-07-11), Supabase showed the
 * same 10 truly-stuck rows untouched in both cases. This test exercises
 * reclaimStuckJob() in isolation against a fake Supabase client so the
 * verify-before-counting behavior is checked without a live DB connection.
 *
 * No test framework is installed in this repo, so this follows the existing
 * scripts/*.ts convention: a plain script run via `npx tsx`, using Node's
 * built-in assert module. Exits non-zero on any failure.
 *
 * Run:
 *   npx tsx scripts/test-stuck-job-reclaim.ts
 */
import assert from 'node:assert/strict'
import { reclaimStuckJob } from './process-asin-checker-jobs'

// ── Minimal fake Supabase client ────────────────────────────────────────────
// Implements only the fluent chain reclaimStuckJob actually calls:
// update(patch).eq('id', ...).eq('status', 'running').eq('locked_at', ...).select('id')

type FakeRow = {
  id: string
  status: 'running' | 'queued' | 'failed'
  locked_at: string | null
  locked_by: string | null
  attempt_count: number
  max_attempts: number
  last_error_safe: string | null
  run_after: string | null
  completed_at: string | null
}

type FakeError = { message: string } | null

function makeFakeSupabase(rows: FakeRow[], opts?: { forceError?: string }) {
  return {
    from(table: string) {
      void table // fake only ever backs `background_jobs`
      let patch: Partial<FakeRow> = {}
      const filters: Array<[string, unknown]> = []
      const builder = {
        update(p: Partial<FakeRow>) {
          patch = p
          return builder
        },
        eq(col: string, val: unknown) {
          filters.push([col, val])
          return builder
        },
        select(cols: string) {
          void cols // column list isn't used — this fake always returns full rows
          return builder
        },
        async then(resolve: (v: { data: FakeRow[] | null; error: FakeError }) => void) {
          resolve(await run())
        },
        // Supabase's real client is thenable; awaiting the builder directly
        // is the actual usage pattern in reclaimStuckJob, so this fake must
        // be awaitable too rather than exposing a separate .execute().
      }
      async function run(): Promise<{ data: FakeRow[] | null; error: FakeError }> {
        if (opts?.forceError) return { data: null, error: { message: opts.forceError } }
        // Mirrors the real `background_jobs.run_after timestamptz NOT NULL
        // DEFAULT now()` constraint (migration 034) — this is the exact
        // failure observed live: "null value in column \"run_after\" ...
        // violates not-null constraint". A literal `null` here must reject
        // the write, same as production; `undefined` (key omitted from the
        // patch) is fine and leaves the column untouched.
        if ('run_after' in patch && patch.run_after === null) {
          return { data: null, error: { message: 'null value in column "run_after" of relation "background_jobs" violates not-null constraint' } }
        }
        const matches = rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val))
        // Real Supabase-js JSON.stringifies the patch before sending it over
        // HTTP, which drops any key whose value is `undefined` — the column
        // is left untouched server-side. Object.assign does NOT replicate
        // this (it copies `undefined`-valued keys too), so apply only the
        // defined keys here to match real behavior.
        for (const row of matches) {
          for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) (row as Record<string, unknown>)[key] = value
          }
        }
        return { data: matches.map(r => ({ id: r.id } as FakeRow)), error: null }
      }
      return builder
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// Real background_jobs rows always have a non-null run_after (NOT NULL
// DEFAULT now()) — a "running" row's run_after is whatever it was set to
// when the job was originally queued, well before it got stuck.
const ORIGINAL_RUN_AFTER = '2026-07-09T14:15:06.767Z'

function seedRow(overrides: Partial<FakeRow>): FakeRow {
  return {
    id: 'job-1',
    status: 'running',
    locked_at: '2026-07-09T16:01:03.652Z',
    locked_by: 'render-cron',
    attempt_count: 1,
    max_attempts: 3,
    last_error_safe: null,
    run_after: ORIGINAL_RUN_AFTER,
    completed_at: null,
    ...overrides,
  }
}

const NOW = '2026-07-11T09:00:00.000Z'
const RUN_AFTER = '2026-07-11T09:30:00.000Z'

const tests: Array<[string, () => Promise<void>]> = []
function test(name: string, fn: () => Promise<void>) {
  tests.push([name, fn])
}

// 1. Successful reclaim, retries remaining -> requeued, not marked failed,
//    with a valid non-null run_after (the new retry-delay timestamp).
test('reclaims a stuck job with retries remaining back to queued with a non-null run_after', async () => {
  const row = seedRow({ attempt_count: 1, max_attempts: 3 })
  const rows = [row]
  const supabase = makeFakeSupabase(rows)

  const result = await reclaimStuckJob(supabase, { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }, NOW, RUN_AFTER)

  assert.equal(result.ok, true)
  assert.equal(row.status, 'queued')
  assert.notEqual(row.run_after, null, 'run_after must never be null (NOT NULL constraint)')
  assert.equal(row.run_after, RUN_AFTER)
  assert.equal(row.completed_at, null)
  assert.equal(row.locked_at, null)
  assert.equal(row.locked_by, null)
  assert.equal(row.last_error_safe, 'stale processing reset')
})

// 2. Successful reclaim, attempts exhausted -> marked failed, not requeued,
//    and run_after is left at its existing (non-null) value rather than
//    being nulled out. This is the exact bug found live in production:
//    "null value in column \"run_after\" ... violates not-null constraint".
test('reclaims a stuck job at max attempts to failed with run_after preserved, never null', async () => {
  const row = seedRow({ attempt_count: 3, max_attempts: 3 })
  const rows = [row]
  const supabase = makeFakeSupabase(rows)

  const result = await reclaimStuckJob(supabase, { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }, NOW, RUN_AFTER)

  assert.equal(result.ok, true, 'must succeed — a null run_after write would be rejected by the fake NOT NULL check and fail here')
  assert.equal(row.status, 'failed')
  assert.notEqual(row.run_after, null, 'run_after must never be null (NOT NULL constraint)')
  assert.equal(row.run_after, ORIGINAL_RUN_AFTER, 'run_after must be left at its existing value, not overwritten')
  assert.equal(row.completed_at, NOW)
  assert.equal(row.last_error_safe, 'stale processing reset')
})

// 3. Supabase returns an error -> must NOT be counted as reclaimed. This is
//    the exact class of bug found live: the old code never checked this.
test('a Supabase error is reported as a failure, not silently counted as reclaimed', async () => {
  const row = seedRow({})
  const supabase = makeFakeSupabase([row], { forceError: 'connection reset' })

  const result = await reclaimStuckJob(supabase, { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }, NOW, RUN_AFTER)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /connection reset/)
  assert.equal(row.status, 'running', 'row must be untouched when the write errors')
})

// 4. Zero rows matched at update time (already reclaimed by another worker,
//    or the guard conditions no longer hold) -> reported as a failure, not
//    a false-positive success. This is the second half of the live bug.
test('a write matching zero rows is reported as a failure, not a false success', async () => {
  const row = seedRow({ status: 'queued' }) // already moved on by someone else
  const supabase = makeFakeSupabase([row])

  const result = await reclaimStuckJob(supabase, { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }, NOW, RUN_AFTER)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /no row matched/)
})

// 5. Idempotency: reclaiming the same row twice in a row must not double-act
//    or throw — the second call finds nothing left to guard-match and fails
//    cleanly instead of corrupting state.
test('reclaiming the same job twice is idempotent (second call fails cleanly)', async () => {
  const row = seedRow({ attempt_count: 1, max_attempts: 3 })
  const rows = [row]
  const supabase = makeFakeSupabase(rows)
  const jobArgs = { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }

  const first = await reclaimStuckJob(supabase, jobArgs, NOW, RUN_AFTER)
  assert.equal(first.ok, true)
  assert.equal(row.status, 'queued')

  // Second call reuses the stale locked_at snapshot from before the first
  // reclaim — exactly what a second, overlapping cron invocation would do.
  const second = await reclaimStuckJob(supabase, jobArgs, NOW, RUN_AFTER)
  assert.equal(second.ok, false, 'must not report success twice for the same row')
  assert.equal(row.status, 'queued', 'row must not be mutated again')
})

// 6. Direct regression guard: a max-attempts reclaim must never even attempt
//    to send a literal `run_after: null` to Supabase — verified against a
//    fake client that rejects that exact write the way production does
//    ("null value in column \"run_after\" ... violates not-null constraint",
//    the exact error seen live).
test('the failed-path update never triggers the Supabase NOT NULL rejection', async () => {
  const row = seedRow({ attempt_count: 5, max_attempts: 5, run_after: '2026-07-08T11:11:57.503Z' })
  const rows = [row]
  const supabase = makeFakeSupabase(rows)

  const result = await reclaimStuckJob(supabase, { id: row.id, attempt_count: row.attempt_count, max_attempts: row.max_attempts, locked_at: row.locked_at! }, NOW, RUN_AFTER)

  assert.equal(result.ok, true, 'the fake NOT NULL guard would turn this into a failure if run_after were sent as null')
  assert.equal(row.run_after, '2026-07-08T11:11:57.503Z')
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
