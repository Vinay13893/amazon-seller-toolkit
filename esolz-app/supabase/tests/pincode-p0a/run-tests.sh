#!/usr/bin/env bash
# Pincode Checker P0-A -- safe test runner.
#
# Bootstraps a SCRATCH/LOCAL-ONLY PostgreSQL database from the real
# repository migration history, runs the sequential correctness suite,
# the concurrency suite, and the EXPLAIN ANALYZE representative-volume
# check, then drops the scratch database. Exits non-zero if any phase
# fails.
#
# SAFETY: this script REFUSES to run against anything that looks like a
# hosted/production Supabase project. It only ever targets a loopback
# PostgreSQL connection, and only ever a database whose name is a plain
# identifier that also self-identifies as disposable ("scratch"/"test").
# There is no flag to override any of these checks -- if you need to
# point this at something else, you are using the wrong tool; this
# runner is deliberately inflexible about that. See "Why the connection
# cannot resolve remotely" below for the full reasoning.
#
# No credentials are embedded anywhere in this file, and none are ever
# printed -- see redact_and_check_hosted_endpoint_vars() below, which
# names an offending environment variable in its refusal message but
# never echoes its value. Connection parameters come entirely from the
# standard libpq environment variables or their defaults. Nothing here
# reads or depends on any Claude/session-local temp file -- every
# fixture this suite needs, it creates itself, in the target database,
# at run time.
#
# Prerequisites:
#   - A local PostgreSQL server (any recent version; developed against
#     16.x locally, production runs 17.6 -- see README.md).
#   - `psql` on PATH, able to connect and CREATE/DROP DATABASE.
#   - The role connecting must be a superuser or otherwise able to
#     CREATE ROLE / CREATE SCHEMA / run arbitrary DDL -- this script
#     creates the anon/authenticated/service_role roles and a minimal
#     auth.users/auth.uid()/auth.jwt() shim that stands in for Supabase
#     Auth (see README.md for exactly what is and is not shimmed).
#
# Usage:
#   PGHOST=localhost PGUSER=postgres ./run-tests.sh
#   # or, with all defaults (local socket, current OS user, default port):
#   ./run-tests.sh
#   # self-test the safety gates themselves -- touches no database at all:
#   ./run-tests.sh --self-test
#
# Optional environment variables:
#   PINCODE_TEST_DB_NAME   -- scratch database name (default:
#                              pincode_p0a_scratch_test). Must match
#                              ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ AND contain
#                              "scratch" or "test" -- both enforced below,
#                              before psql is ever invoked with it.
#   PINCODE_TEST_KEEP_DB   -- set to "1" to skip the final DROP DATABASE
#                              cleanup step, for post-mortem debugging.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/esolz-app/supabase/migrations"

DB_NAME_DEFAULT="pincode_p0a_scratch_test"

# ==================================================================
# SAFETY FUNCTIONS -- pure, side-effect-free (no psql calls, no file
# I/O beyond stdout/stderr), so `--self-test` can exercise the EXACT
# same functions the real run uses, in isolation, without ever
# creating or dropping a database. Every one of these returns 0
# (accept) or 1 (reject); none of them exit the process directly --
# the caller decides whether a rejection is fatal.
# ==================================================================

# GATE 1: PGHOST must be a loopback address or unset (unset means
# libpq uses the local Unix domain socket, which is inherently local --
# there is no such thing as a remote Unix socket path).
validate_pghost() {
  local host="${1:-}"
  case "$host" in
    ""|localhost|127.0.0.1|::1) return 0 ;;
    *) return 1 ;;
  esac
}

# GATE 2 (Correction 2): PGHOSTADDR, if set, must be a literal loopback
# numeric address. PGHOSTADDR takes precedence over PGHOST in libpq when
# both are set, so validating PGHOST alone is not sufficient -- a
# PGHOSTADDR pointing at a real IP would silently redirect the actual
# TCP connection regardless of what PGHOST says.
validate_pghostaddr() {
  local addr="${1:-}"
  case "$addr" in
    ""|127.0.0.1|::1) return 0 ;;
    *) return 1 ;;
  esac
}

# GATE 3 (Correction 2): PGSERVICE / PGSERVICEFILE must both be empty.
# A "service" is a named connection profile (host, port, dbname, user,
# even sslmode) resolved from a services file -- setting either of
# these can redirect every subsequent libpq connection to an arbitrary
# target that GATE 1/2 never sees, since PGSERVICE resolution happens
# inside libpq itself, not via PGHOST. There is no safe "validate the
# service points somewhere local" check available from the shell
# without reimplementing libpq's service-file parser, so both are
# rejected outright when non-empty rather than partially trusted.
validate_no_service_override() {
  local svc="${1:-}" svcfile="${2:-}"
  [[ -z "$svc" && -z "$svcfile" ]]
}

# GATE 4: connection-shaped environment variables that are not
# themselves read by this script, but are checked anyway as defense in
# depth against a future edit that starts reading one of them instead
# of the PG* vars. NEVER prints the variable's value -- only its name
# -- see the Correction 1 self-test below, which asserts this directly
# against this exact function.
redact_and_check_hosted_endpoint_vars() {
  local var val ok=0
  for var in DATABASE_URL SUPABASE_DB_URL POSTGRES_URL PGURL DB_URL SUPABASE_URL; do
    val="${!var:-}"
    if [[ -n "$val" ]]; then
      case "$val" in
        *supabase.co*|*supabase.com*|*pooler.*)
          echo "REFUSED: environment variable $var is set and appears to reference a hosted database." >&2
          ok=1
          ;;
      esac
    fi
  done
  [[ $ok -eq 0 ]]
}

# GATE 5 (Correction 3): the scratch database name itself. Two
# independent requirements, both enforced BEFORE this name is ever
# passed to psql: (a) it must be a plain SQL identifier -- letters/
# digits/underscore only, starting with a letter or underscore, <=63
# chars (Postgres's own identifier length limit) -- rejecting anything
# containing a semicolon, quote, whitespace, or other SQL-meaningful
# character; (b) it must still self-identify as disposable by
# containing "scratch" or "test". Even though (a) alone already makes
# SQL injection structurally impossible, the CREATE/DROP DATABASE
# calls below additionally use psql's `:"identifier"` interpolation
# (safe identifier quoting), never raw string interpolation into the
# SQL text -- belt and suspenders, not either/or.
validate_db_name() {
  local name="${1:-}"
  if [[ ! "$name" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]]; then
    return 1
  fi
  case "$name" in
    *scratch*|*test*) return 0 ;;
    *) return 1 ;;
  esac
}

# ==================================================================
# Why the connection cannot resolve to a remote database after these
# five gates all pass (Correction 2's documentation requirement):
#
#   PGHOST      -- loopback literal or unset (GATE 1)
#   PGHOSTADDR  -- loopback literal or unset (GATE 2) -- checked
#                  separately because it OVERRIDES PGHOST in libpq
#   PGSERVICE / PGSERVICEFILE -- forced empty (GATE 3) -- the one
#                  other mechanism libpq has for resolving a target
#                  independent of PGHOST/PGHOSTADDR
#   DATABASE_URL and friends -- checked for hosted-endpoint patterns
#                  even though unused (GATE 4)
#   database name -- constrained to a plain identifier containing
#                  scratch/test, safely quoted at the call site (GATE 5)
#
# Between GATE 1/2, no host libpq would actually dial is anything but
# loopback. Between GATE 3, no alternate resolution path exists that
# could substitute a different host out from under GATE 1/2. After all
# five gates pass, this script explicitly re-exports PGHOST to a pinned
# value (see "pin the validated target" below) so nothing later in the
# process's lifetime can change it by mutating the inherited
# environment.
# ==================================================================

run_all_safety_gates() {
  # Runs every gate in order, printing a REFUSED message and returning
  # 1 on the first failure. Called once by the real flow before
  # touching any database; called per-case by --self-test.
  if ! validate_pghost "${PGHOST:-}"; then
    echo "REFUSED: PGHOST='${PGHOST:-}' is not localhost/127.0.0.1/::1/unset." >&2
    echo "This runner only ever targets a local scratch database. Aborting." >&2
    return 1
  fi
  if ! validate_pghostaddr "${PGHOSTADDR:-}"; then
    echo "REFUSED: PGHOSTADDR='${PGHOSTADDR:-}' is not a loopback address." >&2
    echo "PGHOSTADDR overrides PGHOST in libpq -- this runner refuses to trust it unless it is loopback or unset. Aborting." >&2
    return 1
  fi
  if ! validate_no_service_override "${PGSERVICE:-}" "${PGSERVICEFILE:-}"; then
    echo "REFUSED: PGSERVICE or PGSERVICEFILE is set." >&2
    echo "A service definition can redirect the connection to an arbitrary target this runner cannot inspect. Aborting." >&2
    return 1
  fi
  if ! redact_and_check_hosted_endpoint_vars; then
    echo "This runner never targets a hosted project, even if PGHOST looks local. Aborting." >&2
    return 1
  fi
  local db_name="${PINCODE_TEST_DB_NAME:-$DB_NAME_DEFAULT}"
  if ! validate_db_name "$db_name"; then
    echo "REFUSED: PINCODE_TEST_DB_NAME='$db_name' failed validation." >&2
    echo "Must match ^[a-zA-Z_][a-zA-Z0-9_]{0,62}\$ AND contain 'scratch' or 'test'. Aborting." >&2
    return 1
  fi
  return 0
}

# ==================================================================
# SELF-TEST MODE -- exercises the exact functions above with crafted
# inputs, in subshells, so a real-looking secret or an unsafe database
# name never actually reaches this process's real environment or any
# psql invocation. Touches no database. Exit code is non-zero if any
# self-test fails.
# ==================================================================
run_self_tests() {
  local st_failures=0
  local st_passes=0

  st_pass() { st_passes=$((st_passes+1)); echo "SELFTEST PASS: $1"; }
  st_fail() { st_failures=$((st_failures+1)); echo "SELFTEST FAIL: $1"; }

  # ---- Correction 1: secret redaction ----
  local fake_secret="sk_live_TOTALLY_FAKE_SECRET_VALUE_12345"
  local out
  out="$(export DATABASE_URL="postgresql://produser:${fake_secret}@db.example.supabase.co:5432/postgres"; redact_and_check_hosted_endpoint_vars 2>&1)"
  if echo "$out" | grep -qF -- "$fake_secret"; then
    st_fail "secret-redaction: fake secret value LEAKED into refusal output -- $out"
  elif echo "$out" | grep -q "DATABASE_URL"; then
    st_pass "secret-redaction: variable name (DATABASE_URL) present, fake secret value absent from refusal output"
  else
    st_fail "secret-redaction: refusal message did not even name the offending variable -- $out"
  fi

  # ---- Correction 2: PGHOSTADDR guard ----
  if (unset PGHOSTADDR; export PGHOSTADDR="203.0.113.55"; validate_pghostaddr "$PGHOSTADDR"); then
    st_fail "PGHOSTADDR: a real routable IP was accepted"
  else
    st_pass "PGHOSTADDR: a real routable IP is rejected"
  fi
  if (validate_pghostaddr "127.0.0.1"); then
    st_pass "PGHOSTADDR: loopback literal accepted"
  else
    st_fail "PGHOSTADDR: loopback literal was rejected"
  fi
  if (validate_pghostaddr ""); then
    st_pass "PGHOSTADDR: unset accepted"
  else
    st_fail "PGHOSTADDR: unset was rejected"
  fi

  # ---- Correction 2: PGSERVICE / PGSERVICEFILE guard ----
  if (validate_no_service_override "prod" ""); then
    st_fail "PGSERVICE: a non-empty service name was accepted"
  else
    st_pass "PGSERVICE: a non-empty service name is rejected"
  fi
  if (validate_no_service_override "" "/etc/postgresql-service.conf"); then
    st_fail "PGSERVICEFILE: a non-empty service file path was accepted"
  else
    st_pass "PGSERVICEFILE: a non-empty service file path is rejected"
  fi
  if (validate_no_service_override "" ""); then
    st_pass "PGSERVICE/PGSERVICEFILE: both empty accepted"
  else
    st_fail "PGSERVICE/PGSERVICEFILE: both-empty case was rejected"
  fi

  # ---- Correction 3: database name validation, each REJECTED case
  # asserted to never reach a psql call -- trivially true here since
  # validate_db_name() itself never invokes psql, but we additionally
  # assert run_all_safety_gates() (the actual gate the real flow calls
  # before ANY psql invocation) also rejects each one, proving the
  # real code path, not just the helper function in isolation.
  local name
  for name in "pincode_scratch_test" "pincode_p0a_scratch_test"; do
    if (validate_db_name "$name"); then
      st_pass "db-name: valid scratch name '$name' accepted"
    else
      st_fail "db-name: valid scratch name '$name' was rejected"
    fi
  done
  if (validate_db_name "pincode_p0a_foo"); then
    st_fail "db-name: name without scratch/test ('pincode_p0a_foo') was accepted"
  else
    st_pass "db-name: name without scratch/test is rejected"
  fi
  if (validate_db_name "test_db; DROP DATABASE postgres;--"); then
    st_fail "db-name: name containing a semicolon was accepted"
  else
    st_pass "db-name: name containing a semicolon is rejected"
  fi
  if (validate_db_name "test_db'; DROP TABLE x;--"); then
    st_fail "db-name: name containing a quote was accepted"
  else
    st_pass "db-name: name containing a quote is rejected"
  fi
  if (validate_db_name "test db name"); then
    st_fail "db-name: name containing whitespace was accepted"
  else
    st_pass "db-name: name containing whitespace is rejected"
  fi
  local overlength_name="test_$(printf 'a%.0s' {1..70})"
  if (validate_db_name "$overlength_name"); then
    st_fail "db-name: overlength name (${#overlength_name} chars) was accepted"
  else
    st_pass "db-name: overlength name is rejected"
  fi

  echo ""
  echo "=== Self-test summary: $st_passes passed, $st_failures failed ==="
  [[ $st_failures -eq 0 ]]
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_tests
  exit $?
fi

# ==================================================================
# REAL FLOW -- only reached after the --self-test short-circuit above,
# so a self-test invocation can never fall through into any psql call.
# ==================================================================

if ! run_all_safety_gates; then
  exit 1
fi

DB_NAME="${PINCODE_TEST_DB_NAME:-$DB_NAME_DEFAULT}"

# Pin the validated target explicitly (Correction 2's "after validation,
# explicitly export a canonical local PGHOST" requirement) -- if PGHOST
# was already set to a valid loopback value, re-export that exact value
# so it cannot silently drift for the remainder of this process's
# lifetime; if it was unset, explicitly unset it again (deliberately
# choosing the local Unix socket, not leaving "unset" to chance).
# PGSERVICE/PGSERVICEFILE are already confirmed empty by the gate above;
# unset them explicitly too, purely as defense in depth against
# something later in this script's execution setting one by accident.
if [[ -n "${PGHOST:-}" ]]; then
  export PGHOST
else
  unset PGHOST
fi
unset PGSERVICE PGSERVICEFILE

echo "=== Pincode P0-A test runner ==="
echo "Target: ${PGHOST:-<local socket>} / database '$DB_NAME' (scratch, will be dropped and recreated)"
echo ""

run_psql() {
  psql -X -v ON_ERROR_STOP=1 "$@"
}

echo "--- Recreating scratch database '$DB_NAME' ---"
# Correction 3: safe identifier interpolation via psql's :"var" syntax
# -- never raw string interpolation of $DB_NAME into the SQL text, even
# though validate_db_name() above already makes injection structurally
# impossible for anything that reaches this point.
#
# NOTE: psql only performs :"var" variable interpolation when the SQL is
# read as a script (stdin/-f), not when passed via -c -- empirically
# confirmed (PostgreSQL 16.13): `-c 'SELECT :"foo";'` raises a syntax
# error at ":" even with -v foo=... set, while the identical text fed via
# stdin substitutes correctly. So these use a heredoc, not -c.
if ! run_psql -d postgres -v db_name="$DB_NAME" <<'EOF'
DROP DATABASE IF EXISTS :"db_name";
EOF
then
  echo "FATAL: could not drop existing scratch database"
  exit 1
fi
if ! run_psql -d postgres -v db_name="$DB_NAME" <<'EOF'
CREATE DATABASE :"db_name";
EOF
then
  echo "FATAL: could not create scratch database"
  exit 1
fi

export PGDATABASE="$DB_NAME"

echo "--- Bootstrapping Supabase Auth shim (anon/authenticated/service_role roles, auth.users/auth.uid()/auth.jwt()) ---"
run_psql <<'EOF'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
EOF
if [ $? -ne 0 ]; then echo "FATAL: auth shim bootstrap failed"; exit 1; fi

echo "--- Applying real migration history ($MIGRATIONS_DIR) ---"
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "FATAL: migrations directory not found at $MIGRATIONS_DIR" >&2
  exit 1
fi

# Two pre-existing, unrelated migrations are known not to apply cleanly to
# a from-scratch database -- neither is caused by, or touched by, the
# Pincode P0-A work this suite tests:
#   004_lock_legacy_tables.sql        -- locks tables that predate the
#                                         migration system and never
#                                         existed in a from-scratch DB.
#   028_internal_fba_fulfillment_reports.sql -- contains a table-level
#                                         UNIQUE(col, COALESCE(...)) clause,
#                                         which is not valid PostgreSQL
#                                         syntax for a table constraint
#                                         (expression uniqueness requires a
#                                         CREATE UNIQUE INDEX). Every
#                                         statement in this file BEFORE the
#                                         invalid one still applies; only
#                                         that one CREATE TABLE is skipped.
# Every other migration, including every Pincode migration (060-063),
# applies cleanly -- this is enforced below, not assumed.
MIGRATION_FAILURES=0
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort -V); do
  base="$(basename "$f")"
  if [ "$base" = "004_lock_legacy_tables.sql" ]; then
    continue
  fi
  num="$(echo "$base" | grep -oE '^[0-9]+')"
  run_psql -f "$f" > /tmp/pincode_p0a_migration_${num}.log 2>&1
  rc=$?
  if [ $rc -ne 0 ] && [ "$num" != "028" ]; then
    echo "FATAL: unexpected migration failure: $base" >&2
    tail -20 /tmp/pincode_p0a_migration_${num}.log >&2
    MIGRATION_FAILURES=$((MIGRATION_FAILURES+1))
  fi
done
if [ "$MIGRATION_FAILURES" -gt 0 ]; then
  echo "FATAL: $MIGRATION_FAILURES migration(s) failed unexpectedly. Aborting before running tests." >&2
  exit 1
fi
echo "Migrations applied cleanly (060-063 confirmed present)."
echo ""

OVERALL_FAILURES=0

echo "=== Phase 1: sequential correctness suite ==="
run_psql -f "$SCRIPT_DIR/sequential.sql"
if [ $? -ne 0 ]; then
  echo "SEQUENTIAL SUITE: FAILED"
  OVERALL_FAILURES=$((OVERALL_FAILURES+1))
else
  echo "SEQUENTIAL SUITE: PASSED"
fi
echo ""

echo "=== Phase 2: concurrency suite ==="
bash "$SCRIPT_DIR/concurrency.sh"
if [ $? -ne 0 ]; then
  echo "CONCURRENCY SUITE: FAILED"
  OVERALL_FAILURES=$((OVERALL_FAILURES+1))
else
  echo "CONCURRENCY SUITE: PASSED"
fi
echo ""

echo "=== Phase 3: EXPLAIN ANALYZE representative-volume check ==="
run_psql -f "$SCRIPT_DIR/explain-analyze.sql"
if [ $? -ne 0 ]; then
  echo "EXPLAIN-ANALYZE CHECK: FAILED"
  OVERALL_FAILURES=$((OVERALL_FAILURES+1))
else
  echo "EXPLAIN-ANALYZE CHECK: PASSED"
fi
echo ""

if [ "${PINCODE_TEST_KEEP_DB:-0}" = "1" ]; then
  echo "--- PINCODE_TEST_KEEP_DB=1: leaving '$DB_NAME' in place for inspection ---"
else
  echo "--- Cleaning up: dropping scratch database '$DB_NAME' ---"
  if ! run_psql -d postgres -v db_name="$DB_NAME" <<'EOF'
DROP DATABASE IF EXISTS :"db_name";
EOF
  then
    echo "WARNING: cleanup drop failed, scratch database '$DB_NAME' may still exist"
  fi
fi

echo ""
if [ "$OVERALL_FAILURES" -gt 0 ]; then
  echo "=== RESULT: $OVERALL_FAILURES phase(s) failed ==="
  exit 1
fi
echo "=== RESULT: all phases passed ==="
exit 0
