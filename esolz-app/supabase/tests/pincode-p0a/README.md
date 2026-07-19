# Pincode Checker P0-A — committed test suite

Repeatable, committed tests for the Pincode Checker P0-A schema/RPC
foundation (`esolz-app/supabase/migrations/060`–`063`). Everything here
runs against a **scratch/local-only** PostgreSQL database that the runner
creates and drops itself — nothing in this directory ever touches a
hosted Supabase project, and the runner actively refuses to try.

## Files

| File | Purpose |
|---|---|
| `run-tests.sh` | Single entry point. Refuses non-local targets, bootstraps a scratch database from the real migration history, runs the two phases below plus the benchmark check, cleans up, exits non-zero on any failure. |
| `sequential.sql` | One self-contained `psql` script: seeds fixtures, then runs ~20 numbered test groups (with lettered sub-cases) as `DO` blocks that `RAISE EXCEPTION` on the first failed assertion. A clean run prints only `NOTICE ... PASSED` lines and ends with a summary `SELECT`. |
| `concurrency.sh` | Real multi-connection tests (6 assertions), launched as backgrounded `psql` processes against the same scratch database — not simulated sequentially. Each test asserts a specific outcome programmatically and prints `PASS:`/`FAIL:`; the script exits non-zero if any assertion failed. |
| `explain-analyze.sql` | Seeds ~50,000 representative targets (10% due, matching a real 24h-cadence/hourly-cron shape) and asserts — via the `EXPLAIN (ANALYZE, FORMAT JSON)` plan tree itself, not eyeballed text — that the claim RPC's candidate query uses the due-index, not a sequential scan. |

## Why bash + psql, not a Python/TS client

The suggested structure for this suite mentioned `concurrency.py` or
`concurrency.ts` as options. This suite uses `concurrency.sh` (bash +
`psql`) instead: it needs true multi-connection PostgreSQL sessions with
precise interleaving control (one session holding a row lock while
another blocks behind it, then observing the post-commit state), and
`psql` backgrounded via the shell gives that directly, with zero new
dependencies (no `psycopg2`/`pg` client library to install, nothing to
add to `package.json`). Every test still asserts its outcome
programmatically — pass/fail is never determined by a human reading
output.

## Prerequisites

- A local PostgreSQL server. Developed and verified against PostgreSQL
  16.13 locally; **production runs PostgreSQL 17.6** (confirmed via a
  live read-only query against the production project, see
  `BRAHMASTRA_MASTER_TRACKER.md` §22 update 7) — 17.6 is a strict
  superset of the features this schema uses (in particular, the
  column-specific `ON DELETE SET NULL (<col>)` syntax the schema relies
  on is PG15+), so no compatibility gap is expected, but this suite has
  not been run against 17.6 directly.
- `psql` on `PATH`.
- A role able to `CREATE DATABASE`, `CREATE ROLE`, and run arbitrary DDL
  (a local superuser, e.g. the default `postgres` role, is the simplest
  choice — this is a throwaway scratch environment, not a shared one).
- Nothing else. No Docker, no Supabase CLI, no Node/Python client
  libraries.

### What gets shimmed, and why

This repository's migrations assume a full Supabase stack (Auth schema,
`anon`/`authenticated`/`service_role` roles, `auth.uid()`, `auth.jwt()`).
A vanilla local PostgreSQL server has none of that. `run-tests.sh`
creates a minimal stand-in before applying any migration:

- The three roles (`anon`, `authenticated`, `service_role`), the last
  with `BYPASSRLS` (matching production's actual grant shape).
- `auth.users(id uuid, email text)` — enough for the FKs from
  `public.profiles` to resolve.
- `auth.uid()` / `auth.jwt()` — read a session-local `SET` variable
  (`request.jwt.claim.sub` / `request.jwt.claims`), the same mechanism
  PostgREST uses in production, so `sequential.sql`'s RLS tests
  (`SET LOCAL ROLE authenticated; PERFORM set_config(...)`) exercise the
  real policies, not a bypassed stand-in.

This is a **shim for tables/functions this feature's migrations
reference but do not own**, not a reimplementation of Supabase Auth —
it exists only so the real migration history applies cleanly, nothing
more.

### Two pre-existing, unrelated migrations are skipped/tolerated

Discovered while first bootstrapping a from-scratch scratch database for
this feature (not introduced by, or related to, the Pincode work):

- `004_lock_legacy_tables.sql` — locks tables (`seller_credentials`,
  `users`, `asins`, ...) that predate the migration system and were never
  created by any tracked migration. There is no way to apply this file to
  a from-scratch database; it is skipped entirely.
- `028_internal_fba_fulfillment_reports.sql` — contains a table-level
  `UNIQUE (col, COALESCE(...))` clause, which is not valid PostgreSQL
  syntax for a table constraint (expression-based uniqueness requires
  `CREATE UNIQUE INDEX`, not the plain `UNIQUE(...)` table-constraint
  form). Every statement in this file **before** the invalid one still
  applies; only that one `CREATE TABLE` is skipped. `run-tests.sh`
  tolerates this file's own failure and continues — but treats an
  unexpected failure in **any other** migration, including all four
  Pincode migrations, as fatal and aborts before running any tests.

Neither of these gaps affects any table or function the Pincode P0-A
schema/RPCs touch, and this suite's `run-tests.sh` verifies migrations
`060`–`063` specifically applied with no errors before proceeding.

## Running

```bash
# Simplest form -- uses the Unix domain socket (inherently local) and
# your current OS user. On most local dev setups this just works if you
# can already run `psql` with no arguments.
cd esolz-app/supabase/tests/pincode-p0a
./run-tests.sh

# Explicit host/user, still local-only (PGHOST must be localhost/
# 127.0.0.1/::1/unset -- anything else is refused, see Safety below):
PGHOST=localhost PGUSER=postgres ./run-tests.sh

# Keep the scratch database around after a failing run, for inspection:
PINCODE_TEST_KEEP_DB=1 ./run-tests.sh
psql -d pincode_p0a_scratch_test -c "SELECT ..."
# then clean up manually when done:
psql -d postgres -c "DROP DATABASE pincode_p0a_scratch_test;"

# Run only one phase directly (still against a database YOU already
# bootstrapped -- these two files assume the schema already exists,
# they do not apply migrations themselves):
psql -v ON_ERROR_STOP=1 -f sequential.sql
bash concurrency.sh
```

Exit code is `0` only if every phase (sequential, concurrency, EXPLAIN
ANALYZE) passed. Any failure anywhere produces a non-zero exit code and
a `FAIL:`/`ERROR` line identifying exactly which assertion failed.

## Safety guarantees (what `run-tests.sh` refuses, and why)

1. **Refuses any `PGHOST` other than `localhost` / `127.0.0.1` / `::1` /
   unset.** An unset `PGHOST` makes libpq use the local Unix domain
   socket, which is inherently local (there is no such thing as a remote
   Unix socket path) — at least as safe as an explicit loopback host.
2. **Refuses any `PGHOSTADDR` other than `127.0.0.1` / `::1` / unset.**
   libpq resolves `PGHOSTADDR` *in preference to* `PGHOST` when both are
   set, so a `PGHOST` guard alone is not sufficient — a real routable IP
   in `PGHOSTADDR` would silently override an otherwise-safe `PGHOST`
   and is rejected here independently.
3. **Refuses any non-empty `PGSERVICE` or `PGSERVICEFILE`.** A libpq
   "service" is a named connection profile (host/port/dbname/user/
   sslmode) resolved from a `.pg_service.conf` file, entirely independent
   of `PGHOST`/`PGHOSTADDR` — an operator's pre-existing service
   definition could silently redirect this runner to a real database
   even with every other guard passing. Both must be unset/empty.
4. **After all of the above pass, explicitly (re-)exports a canonical
   local connection target** — `PGHOST` is re-exported if already a
   validated loopback value, otherwise left unset (Unix socket);
   `PGSERVICE`/`PGSERVICEFILE` are unconditionally unset for the rest of
   the run. This closes the gap between "validated at the top of the
   script" and "still true by the time `psql` actually runs" — nothing
   later in the script, or in its environment, can reintroduce a service
   override or a stale `PGHOSTADDR` once this point is reached. Given (1)
   `PGHOST` pinned to loopback/socket, (2) `PGHOSTADDR` pinned to
   loopback/unset, and (3) no service profile in play, there is no
   remaining libpq mechanism this script's environment could use to make
   the actual connection resolve anywhere but local.
5. **Refuses if any of `DATABASE_URL`, `SUPABASE_DB_URL`, `POSTGRES_URL`,
   `PGURL`, `DB_URL`, or `SUPABASE_URL` is set to something that looks
   like a hosted Supabase endpoint** (`supabase.co`, `supabase.com`, or a
   `pooler.*` host), even though this script does not itself read those
   variables — defense in depth against a future edit that starts using
   one of them instead of the `PG*` vars. The refusal message names only
   the **variable**, never its value — no database URL, password, token,
   service key, or connection string is ever printed, logged, or echoed
   anywhere in this script.
6. **Refuses unless the target database name matches
   `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$` (a valid, unquoted Postgres
   identifier, max 63 bytes) AND contains `scratch` or `test`.** The
   regex is checked first and rejects anything with a semicolon, quote,
   whitespace, or other non-identifier character *before* the name is
   ever used in an SQL statement; the `scratch`/`test` substring
   requirement then stops an operator from accidentally pointing the
   runner at a real local database (e.g. a local Supabase CLI project
   with real seeded data) that happens to be reachable and happens to
   pass the regex. The validated name is never interpolated as raw SQL
   text — every `CREATE`/`DROP DATABASE` uses psql's `-v db_name=... ` +
   `:"db_name"` safe-identifier substitution, fed via stdin (`:"var"`
   interpolation is a script-mode feature — it does not apply to `-c`
   command-line arguments, so these always run as a heredoc/stdin
   script, never as `-c`).
7. **No credentials anywhere in this directory.** Connection parameters
   come entirely from the standard `PG*` libpq environment variables (or
   their defaults); nothing is hardcoded, nothing is read from a
   Claude/session-local temp file, nothing is written to one either.
8. **Cleans up its own fixtures.** The scratch database is dropped at the
   end of every run unless `PINCODE_TEST_KEEP_DB=1` is explicitly set.

There is deliberately no flag to override any of the refusals above. If
you need to point this suite at something else, this is the wrong tool
for that — it exists specifically to make "accidentally ran this against
something real" structurally difficult, not just discouraged by a
warning comment.

### Self-test mode

`./run-tests.sh --self-test` exercises the safety-gate functions above
directly (secret redaction, `PGHOSTADDR`/`PGSERVICE`/`PGSERVICEFILE`
guards, all six required database-name cases) in isolated subshells,
asserting each property programmatically — including that a fake secret
value injected into a subshell-scoped `DATABASE_URL` never appears in
the refusal output — without ever invoking `psql` or touching a real
database. The `--self-test` short-circuit is checked before any other
code path, so a self-test invocation can never fall through into a real
database operation. Run it any time to verify these guarantees hold:

```bash
./run-tests.sh --self-test
```

## What this suite covers

**Sequential (`sequential.sql`, ~20 numbered groups):** cross-workspace
FK rejection; RLS `SELECT`-only / write-rejection on all three new
tables; enrollment happy path, quota rejection (all-or-nothing, single-
and multi-product), duplicate-pincode normalization; owned-listing
identity verification (existence *and* ASIN match, not existence alone),
malformed-UUID handling, `'other'`-source contradiction rejection,
`tracked_asin_id` identity verification, conflicting-duplicate-ASIN
rejection; `finalize_pincode_check` NULL-safe validation with actual SQL
`NULL`; full claim→finalize cycle; idempotent finalize retry; stale-
reclaim-then-refinalize race; allowlist fail-closed (`NULL`/empty/non-
membership); history hard-delete rejection (target-level and product-
level, with and without result history); whole-workspace cascade cleanup
still works; remove→re-add atomic restore with history preserved;
pause/resume with quota gating and in-flight (`checking`) all-or-nothing
rejection; manual-check coalescing/cooldown/status-matrix; **complete-
batch ID validation** for `set_pincode_tracking_state` and
`remove_pincode_monitored_products` (missing ID, foreign-workspace ID,
duplicate IDs, `NULL` ID in array, zero partial mutation on rejection);
removal-consistency `CHECK` strengthening; hard configuration ceilings
independent of business-logic quota rejection.

**Concurrency (`concurrency.sh`, 6 assertions, real multi-connection):**
claim genuinely blocks behind a concurrently-held parent lock and
observes the correct post-commit state — 0 claimed if the parent was
archived mid-lock, 1 claimed normally if it stayed active, 0 claimed if
the parent was concurrently removed mid-lock via a real
`remove_pincode_monitored_products` call (not a raw status `UPDATE`),
with the parent's final status independently confirmed as `removed` —
this is the direct empirical proof of the claim RPC's parent-first
locking against all three ways a parent can leave `'active'`, and the
`remove` variant is specifically the claim-vs-product-removal test
required by `IMPLEMENTATION_PLAN.md` §2.8; concurrent
`finalize_pincode_check` with the same still-valid token from two
connections produces exactly one result; concurrent
`enroll_pincode_monitored_products` under joint-exceeding quota
serializes correctly (exactly one of two concurrent requests succeeds);
5 rounds of concurrent claim + pause + manual-queue against the same
product's targets produce zero deadlocks/lock-timeouts.

**Benchmark (`explain-analyze.sql`):** the claim RPC's candidate-ranking
query uses `pincode_tracking_targets_due_idx` (confirmed structurally
via the `EXPLAIN ... FORMAT JSON` plan tree, not text-matched) against a
representative 50,000-row / 10%-due dataset, and does not fall back to a
sequential scan on `pincode_tracking_targets`.
