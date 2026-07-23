#!/usr/bin/env bash
# SKU Performance P1-B -- safe test runner.
#
# Bootstraps a SCRATCH/LOCAL-ONLY PostgreSQL database from the real
# repository migration history, runs the sequential correctness suite and
# the EXPLAIN ANALYZE representative-volume check, then drops the scratch
# database. Exits non-zero if any phase fails.
#
# Adapted directly from esolz-app/supabase/tests/pincode-p0a/run-tests.sh --
# same safety gates, same bootstrap approach, same "no flag to override any
# check" posture. Only two differences from that script:
#   1. This feature's two RPCs (get_sku_performance_summary,
#      get_sku_performance_daily) are pure reads with no claim/finalize-style
#      row locking, so there is no concurrency phase here -- there is nothing
#      analogous to pincode's claim-race condition to exercise.
#   2. The scratch database name/env-var prefix are namespaced to this
#      feature so the two suites can never collide if run back-to-back.
#
# SAFETY: this script REFUSES to run against anything that looks like a
# hosted/production Supabase project. It only ever targets a loopback
# PostgreSQL connection, and only ever a database whose name is a plain
# identifier that also self-identifies as disposable ("scratch"/"test").
# There is no flag to override any of these checks.
#
# Prerequisites:
#   - A local PostgreSQL server, psql on PATH, able to CREATE/DROP DATABASE.
#   - The connecting role must be able to CREATE ROLE / CREATE SCHEMA / run
#     arbitrary DDL -- this script creates the anon/authenticated/
#     service_role roles and a minimal auth.users/auth.uid()/auth.jwt() shim.
#
# Usage:
#   PGHOST=localhost PGUSER=postgres ./run-tests.sh
#   ./run-tests.sh                     # local socket, current OS user
#   ./run-tests.sh --self-test         # exercises the safety gates only
#
# Optional environment variables:
#   SKU_PERF_TEST_DB_NAME  -- scratch database name (default:
#                              sku_performance_p1b_scratch_test). Must match
#                              ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ AND contain
#                              "scratch" or "test".
#   SKU_PERF_TEST_KEEP_DB  -- set to "1" to skip the final DROP DATABASE.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/esolz-app/supabase/migrations"

DB_NAME_DEFAULT="sku_performance_p1b_scratch_test"

# ==================================================================
# SAFETY FUNCTIONS -- identical logic to pincode-p0a/run-tests.sh, kept
# self-contained here rather than sourced, matching that suite's own
# "no shared runtime dependency between test suites" convention.
# ==================================================================

validate_pghost() {
  local host="${1:-}"
  case "$host" in
    ""|localhost|127.0.0.1|::1) return 0 ;;
    *) return 1 ;;
  esac
}

validate_pghostaddr() {
  local addr="${1:-}"
  case "$addr" in
    ""|127.0.0.1|::1) return 0 ;;
    *) return 1 ;;
  esac
}

validate_no_service_override() {
  local svc="${1:-}" svcfile="${2:-}"
  [[ -z "$svc" && -z "$svcfile" ]]
}

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

run_all_safety_gates() {
  if ! validate_pghost "${PGHOST:-}"; then
    echo "REFUSED: PGHOST='${PGHOST:-}' is not localhost/127.0.0.1/::1/unset." >&2
    return 1
  fi
  if ! validate_pghostaddr "${PGHOSTADDR:-}"; then
    echo "REFUSED: PGHOSTADDR='${PGHOSTADDR:-}' is not a loopback address." >&2
    return 1
  fi
  if ! validate_no_service_override "${PGSERVICE:-}" "${PGSERVICEFILE:-}"; then
    echo "REFUSED: PGSERVICE or PGSERVICEFILE is set." >&2
    return 1
  fi
  if ! redact_and_check_hosted_endpoint_vars; then
    echo "This runner never targets a hosted project, even if PGHOST looks local." >&2
    return 1
  fi
  local db_name="${SKU_PERF_TEST_DB_NAME:-$DB_NAME_DEFAULT}"
  if ! validate_db_name "$db_name"; then
    echo "REFUSED: SKU_PERF_TEST_DB_NAME='$db_name' failed validation." >&2
    return 1
  fi
  return 0
}

run_self_tests() {
  local st_failures=0 st_passes=0
  st_pass() { st_passes=$((st_passes+1)); echo "SELFTEST PASS: $1"; }
  st_fail() { st_failures=$((st_failures+1)); echo "SELFTEST FAIL: $1"; }

  if (validate_db_name "sku_performance_p1b_scratch_test"); then
    st_pass "db-name: valid scratch name accepted"
  else
    st_fail "db-name: valid scratch name was rejected"
  fi
  if (validate_db_name "sku_performance_p1b_prod"); then
    st_fail "db-name: name without scratch/test was accepted"
  else
    st_pass "db-name: name without scratch/test is rejected"
  fi
  if (validate_pghostaddr "203.0.113.55"); then
    st_fail "PGHOSTADDR: a real routable IP was accepted"
  else
    st_pass "PGHOSTADDR: a real routable IP is rejected"
  fi
  if (validate_no_service_override "prod" ""); then
    st_fail "PGSERVICE: a non-empty service name was accepted"
  else
    st_pass "PGSERVICE: a non-empty service name is rejected"
  fi

  echo ""
  echo "=== Self-test summary: $st_passes passed, $st_failures failed ==="
  [[ $st_failures -eq 0 ]]
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_tests
  exit $?
fi

if ! run_all_safety_gates; then
  exit 1
fi

DB_NAME="${SKU_PERF_TEST_DB_NAME:-$DB_NAME_DEFAULT}"

if [[ -n "${PGHOST:-}" ]]; then
  export PGHOST
else
  unset PGHOST
fi
unset PGSERVICE PGSERVICEFILE

echo "=== SKU Performance P1-B test runner ==="
echo "Target: ${PGHOST:-<local socket>} / database '$DB_NAME' (scratch, will be dropped and recreated)"
echo ""

run_psql() {
  psql -X -v ON_ERROR_STOP=1 "$@"
}

echo "--- Recreating scratch database '$DB_NAME' ---"
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

# Same two pre-existing, unrelated exceptions documented in
# pincode-p0a/run-tests.sh -- neither caused by, or touched by, this work:
#   004_lock_legacy_tables.sql               -- locks tables that predate
#                                                the migration system.
#   028_internal_fba_fulfillment_reports.sql -- one invalid table-level
#                                                UNIQUE(col, COALESCE(...))
#                                                clause; every other
#                                                statement in that file
#                                                still applies.
MIGRATION_FAILURES=0
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort -V); do
  base="$(basename "$f")"
  if [ "$base" = "004_lock_legacy_tables.sql" ]; then
    continue
  fi
  num="$(echo "$base" | grep -oE '^[0-9]+')"
  run_psql -f "$f" > /tmp/sku_perf_p1b_migration_${num}.log 2>&1
  rc=$?
  if [ $rc -ne 0 ] && [ "$num" != "028" ]; then
    echo "FATAL: unexpected migration failure: $base" >&2
    tail -40 /tmp/sku_perf_p1b_migration_${num}.log >&2
    MIGRATION_FAILURES=$((MIGRATION_FAILURES+1))
  fi
done
if [ "$MIGRATION_FAILURES" -gt 0 ]; then
  echo "FATAL: $MIGRATION_FAILURES migration(s) failed unexpectedly. Aborting before running tests." >&2
  exit 1
fi
echo "Migrations applied cleanly (065 confirmed present)."
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

echo "=== Phase 2: EXPLAIN ANALYZE representative-volume check ==="
run_psql -f "$SCRIPT_DIR/explain-analyze.sql"
if [ $? -ne 0 ]; then
  echo "EXPLAIN-ANALYZE CHECK: FAILED"
  OVERALL_FAILURES=$((OVERALL_FAILURES+1))
else
  echo "EXPLAIN-ANALYZE CHECK: PASSED"
fi
echo ""

if [ "${SKU_PERF_TEST_KEEP_DB:-0}" = "1" ]; then
  echo "--- SKU_PERF_TEST_KEEP_DB=1: leaving '$DB_NAME' in place for inspection ---"
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
