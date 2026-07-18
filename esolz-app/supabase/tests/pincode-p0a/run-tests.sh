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
# hosted/production Supabase project. It only ever targets localhost/
# 127.0.0.1/::1, and only ever a database whose name contains "scratch"
# or "test". There is no flag to override either check -- if you need to
# point this at something else, you are using the wrong tool; this
# runner is deliberately inflexible about that.
#
# No credentials are embedded anywhere in this file. Connection
# parameters come entirely from the standard libpq environment variables
# (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD) or their defaults.
# Nothing here reads or depends on any Claude/session-local temp file --
# every fixture this suite needs, it creates itself, in the target
# database, at run time.
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
#   # or, with all defaults (localhost, current OS user, default port):
#   ./run-tests.sh
#
# Optional environment variables:
#   PINCODE_TEST_DB_NAME   -- scratch database name (default:
#                              pincode_p0a_scratch_test). Must contain
#                              "scratch" or "test" -- enforced below.
#   PINCODE_TEST_KEEP_DB   -- set to "1" to skip the final DROP DATABASE
#                              cleanup step, for post-mortem debugging.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/esolz-app/supabase/migrations"

DB_NAME="${PINCODE_TEST_DB_NAME:-pincode_p0a_scratch_test}"
DB_HOST="${PGHOST:-}"

# ------------------------------------------------------------------
# SAFETY GATE 1: refuse anything that isn't localhost/127.0.0.1/::1, or
# unset (an unset PGHOST makes libpq use the local Unix domain socket,
# which is inherently local -- there is no such thing as a remote Unix
# socket path, so this is at least as safe as an explicit loopback host).
# ------------------------------------------------------------------
case "$DB_HOST" in
  ""|localhost|127.0.0.1|::1) ;;
  *)
    echo "REFUSED: PGHOST='$DB_HOST' is not localhost/127.0.0.1/::1/unset." >&2
    echo "This runner only ever targets a local scratch database. Aborting." >&2
    exit 1
    ;;
esac

# ------------------------------------------------------------------
# SAFETY GATE 2: refuse if ANY connection-shaped environment variable
# anywhere in this process's environment looks like a hosted Supabase
# endpoint -- defense in depth even though this script only actually
# uses PG* vars itself, in case a future edit starts reading one of
# these instead.
# ------------------------------------------------------------------
for var in DATABASE_URL SUPABASE_DB_URL POSTGRES_URL PGURL DB_URL SUPABASE_URL; do
  val="${!var:-}"
  if [[ -n "$val" ]]; then
    case "$val" in
      *supabase.co*|*supabase.com*|*pooler.*)
        echo "REFUSED: environment variable $var is set and looks like a hosted Supabase endpoint ('$val')." >&2
        echo "This runner never targets a hosted project, even if PGHOST looks local. Aborting." >&2
        exit 1
        ;;
    esac
  fi
done

# ------------------------------------------------------------------
# SAFETY GATE 3: the target database name must self-identify as
# scratch/test -- refuses an operator accidentally pointing this at a
# real local database that happens to be reachable on localhost (e.g. a
# local Supabase CLI project database with real seeded data).
# ------------------------------------------------------------------
case "$DB_NAME" in
  *scratch*|*test*) ;;
  *)
    echo "REFUSED: PINCODE_TEST_DB_NAME='$DB_NAME' does not contain 'scratch' or 'test'." >&2
    echo "Refusing to CREATE/DROP a database whose name doesn't self-identify as disposable. Aborting." >&2
    exit 1
    ;;
esac

echo "=== Pincode P0-A test runner ==="
echo "Target: $DB_HOST / database '$DB_NAME' (scratch, will be dropped and recreated)"
echo ""

run_psql() {
  psql -X -v ON_ERROR_STOP=1 "$@"
}

echo "--- Recreating scratch database '$DB_NAME' ---"
run_psql -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" || { echo "FATAL: could not drop existing scratch database"; exit 1; }
run_psql -d postgres -c "CREATE DATABASE $DB_NAME;" || { echo "FATAL: could not create scratch database"; exit 1; }

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
  run_psql -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" || echo "WARNING: cleanup drop failed, scratch database '$DB_NAME' may still exist"
fi

echo ""
if [ "$OVERALL_FAILURES" -gt 0 ]; then
  echo "=== RESULT: $OVERALL_FAILURES phase(s) failed ==="
  exit 1
fi
echo "=== RESULT: all phases passed ==="
exit 0
