#!/usr/bin/env bash
# Pincode Checker P0-A -- committed, repeatable CONCURRENCY test suite.
#
# Runs real multi-connection PostgreSQL sessions (via psql, backgrounded)
# against the target database. Every test asserts a specific outcome
# programmatically (not by eyeballing output) and increments a failure
# counter; the script exits non-zero if any assertion failed.
#
# Must be invoked via run-tests.sh, which performs the production-URL
# refusal check and the migration bootstrap BEFORE this script ever runs.
# Do not run this script directly against any database you did not create
# solely to run it -- it seeds and mutates real rows.
#
# Requires these environment variables (run-tests.sh exports them):
#   PGHOST, PGPORT, PGUSER, PGDATABASE   -- standard libpq vars, already
#                                            validated as scratch/local by
#                                            run-tests.sh before this runs
set -uo pipefail

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "FAIL: $1"; }

psql_q() {
  # Runs a query, returns raw single-column/single-row text (trimmed).
  psql -X -q -t -A -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

psql_f() {
  # Runs a file, streaming output to the given log path. Returns psql's exit
  # code. Formatted (aligned) output -- used where we only check for the
  # ABSENCE of an error string (e.g. "deadlock"), not for parsing a value.
  psql -X -q -v ON_ERROR_STOP=1 -f "$1" > "$2" 2>&1
}

psql_f_ta() {
  # Same, but tuples-only/unaligned (-t -A): every SELECT's result prints
  # as a bare value with no header/dashes/row-count footer, and a void-
  # returning statement like `SELECT pg_sleep(...)` prints nothing at all
  # -- used specifically where the caller needs to parse the LAST line as
  # the actual result value, without fragile text-table scraping.
  psql -X -q -t -A -v ON_ERROR_STOP=1 -f "$1" > "$2" 2>&1
}

echo "=== Concurrency suite: seeding fixtures ==="
psql_q "
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-000000000001','conc-owner@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, email) VALUES ('a0000000-0000-0000-0000-000000000001','conc-owner@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.workspaces (id, owner_id, name) VALUES ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','Concurrency WS 1') ON CONFLICT DO NOTHING;
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','owner') ON CONFLICT DO NOTHING;
INSERT INTO public.pincode_monitored_products (id, workspace_id, marketplace_id, asin, product_source, status)
VALUES ('c0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','A21TJRUUN4KGV','B000000CC1','other','active') ON CONFLICT DO NOTHING;
INSERT INTO public.pincode_tracking_targets (id, workspace_id, monitored_product_id, pincode, status, next_check_at)
VALUES ('d0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001','990001','active', now() - interval '1 minute') ON CONFLICT DO NOTHING;
" > /tmp/pincode_conc_seed.log
if [ $? -ne 0 ]; then echo "FATAL: seeding failed"; cat /tmp/pincode_conc_seed.log; exit 1; fi

# ------------------------------------------------------------------
# TEST C1: claim_due_pincode_targets genuinely BLOCKS behind a
# concurrently-held parent lock, then observes the correct post-commit
# state -- archived parent -> 0 claimed; active parent -> 1 claimed. This
# is the direct empirical proof of the claim RPC's parent-first locking
# (PR #53 round 5's "final narrow correction").
# ------------------------------------------------------------------
run_lock_contention_test() {
  local variant="$1"  # 'archive' or 'active'
  local expect_claimed="$2"

  cat > /tmp/conc_a_$variant.sql <<SQL
\timing off
BEGIN;
SELECT id, status FROM public.pincode_monitored_products WHERE id = 'c0000000-0000-0000-0000-000000000001' FOR UPDATE;
SELECT pg_sleep(3);
$( [ "$variant" = "archive" ] && echo "UPDATE public.pincode_monitored_products SET status = 'archived' WHERE id = 'c0000000-0000-0000-0000-000000000001';" )
COMMIT;
SQL

  cat > /tmp/conc_b_$variant.sql <<SQL
\timing off
SELECT pg_sleep(1);
SELECT count(*) AS b_claimed_count FROM public.claim_due_pincode_targets(
  10, 'conc-test-$variant', '{}'::uuid[], ARRAY['b0000000-0000-0000-0000-000000000001']::uuid[]
) WHERE id = 'd0000000-0000-0000-0000-000000000001';
SQL

  # Reset target to active/unclaimed and parent to active before each run.
  psql_q "
    UPDATE public.pincode_monitored_products SET status='active' WHERE id='c0000000-0000-0000-0000-000000000001';
    UPDATE public.pincode_tracking_targets SET status='active', claim_token=NULL, claimed_at=NULL, claimed_by=NULL, next_check_at=now()-interval '1 minute' WHERE id='d0000000-0000-0000-0000-000000000001';
  " > /dev/null

  psql_f_ta /tmp/conc_a_$variant.sql /tmp/conc_a_${variant}_out.log &
  local pid_a=$!
  psql_f_ta /tmp/conc_b_$variant.sql /tmp/conc_b_${variant}_out.log &
  local pid_b=$!
  wait $pid_a
  wait $pid_b

  local claimed
  claimed=$(grep -E '^[0-9]+$' /tmp/conc_b_${variant}_out.log | tail -1)
  if [ "$claimed" = "$expect_claimed" ]; then
    pass "C1-$variant: claim vs. held parent lock (${variant}) -- claimed=$claimed as expected"
  else
    fail "C1-$variant: claim vs. held parent lock (${variant}) -- expected claimed=$expect_claimed, got '$claimed' (see /tmp/conc_b_${variant}_out.log)"
  fi
}

run_lock_contention_test archive 0
run_lock_contention_test active 1

# ------------------------------------------------------------------
# TEST C2: concurrent finalize_pincode_check with the SAME still-valid
# token from two real connections -> exactly one result row, both calls
# return the identical result, no error.
# ------------------------------------------------------------------
psql_q "
UPDATE public.pincode_monitored_products SET status='active' WHERE id='c0000000-0000-0000-0000-000000000001';
UPDATE public.pincode_tracking_targets SET status='active', claim_token=NULL, claimed_at=NULL, claimed_by=NULL, next_check_at=now()-interval '1 minute' WHERE id='d0000000-0000-0000-0000-000000000001';
" > /dev/null

TOKEN=$(psql_q "SELECT claim_token FROM public.claim_due_pincode_targets(10, 'conc-finalize-setup', '{}'::uuid[], ARRAY['b0000000-0000-0000-0000-000000000001']::uuid[]) WHERE id = 'd0000000-0000-0000-0000-000000000001';")

if [ -z "$TOKEN" ]; then
  fail "C2: setup claim did not return a token, cannot run concurrent-finalize test"
else
  cat > /tmp/conc_fin.sql <<SQL
SELECT pg_sleep(0.2);
SELECT id FROM public.finalize_pincode_check('$TOKEN'::uuid, 'success', 'available', NULL, NULL, NULL);
SQL
  psql_f_ta /tmp/conc_fin.sql /tmp/conc_fin_a_out.log &
  pa=$!
  psql_f_ta /tmp/conc_fin.sql /tmp/conc_fin_b_out.log &
  pb=$!
  wait $pa
  wait $pb

  RESULT_A=$(tail -1 /tmp/conc_fin_a_out.log | tr -d ' ')
  RESULT_B=$(tail -1 /tmp/conc_fin_b_out.log | tr -d ' ')
  COUNT=$(psql_q "SELECT count(*) FROM public.pincode_availability_results WHERE check_attempt_id = '$TOKEN'::uuid;")

  if [ "$RESULT_A" = "$RESULT_B" ] && [ "$COUNT" = "1" ] && [ -n "$RESULT_A" ]; then
    pass "C2: concurrent finalize with same token -- both calls returned identical result ($RESULT_A), exactly 1 row"
  else
    fail "C2: concurrent finalize with same token -- A='$RESULT_A' B='$RESULT_B' count=$COUNT (expected equal, non-empty, count=1)"
  fi
fi

# ------------------------------------------------------------------
# TEST C3: concurrent enroll_pincode_monitored_products under joint-
# exceeding quota -- exactly one of two concurrent requests succeeds,
# final active count never exceeds the limit.
# ------------------------------------------------------------------
psql_q "
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-000000000002','conc-quota@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, email) VALUES ('a0000000-0000-0000-0000-000000000002','conc-quota@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.workspaces (id, owner_id, name) VALUES ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','Concurrency WS 2 (quota)') ON CONFLICT DO NOTHING;
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','owner') ON CONFLICT DO NOTHING;
" > /dev/null

cat > /tmp/conc_quota_a.sql <<'SQL'
\timing off
SELECT public.enroll_pincode_monitored_products(
  'b0000000-0000-0000-0000-000000000002'::uuid, 'A21TJRUUN4KGV',
  jsonb_build_array(jsonb_build_object('product_source','other','asin','B00000QA01','pincodes', jsonb_build_array('100001','100002','100003'))),
  4
) AS result_a;
SQL
cat > /tmp/conc_quota_b.sql <<'SQL'
\timing off
SELECT public.enroll_pincode_monitored_products(
  'b0000000-0000-0000-0000-000000000002'::uuid, 'A21TJRUUN4KGV',
  jsonb_build_array(jsonb_build_object('product_source','other','asin','B00000QA02','pincodes', jsonb_build_array('100004','100005','100006'))),
  4
) AS result_b;
SQL
psql_f /tmp/conc_quota_a.sql /tmp/conc_quota_a_out.log &
pa=$!
psql_f /tmp/conc_quota_b.sql /tmp/conc_quota_b_out.log &
pb=$!
wait $pa
wait $pb

SUCCESS_COUNT=$(grep -c '"result": "success"' /tmp/conc_quota_a_out.log /tmp/conc_quota_b_out.log | awk -F: '{sum+=$2} END {print sum}')
FINAL_ACTIVE=$(psql_q "
SELECT count(*) FROM public.pincode_tracking_targets t JOIN public.pincode_monitored_products p ON p.id=t.monitored_product_id
WHERE p.workspace_id='b0000000-0000-0000-0000-000000000002' AND t.status IN ('active','checking');
")

if [ "$SUCCESS_COUNT" = "1" ] && [ "$FINAL_ACTIVE" -le "4" ]; then
  pass "C3: concurrent enrollment under joint-exceeding quota -- exactly 1 of 2 succeeded, final active count=$FINAL_ACTIVE (<=4)"
else
  fail "C3: concurrent enrollment under joint-exceeding quota -- success_count=$SUCCESS_COUNT final_active=$FINAL_ACTIVE (expected success_count=1, final_active<=4)"
fi

# ------------------------------------------------------------------
# TEST C4: global lock-order deadlock stress -- claim + pause +
# manual-queue fired concurrently against the same product's targets,
# repeated 5 rounds, zero deadlock/lock-timeout errors.
# ------------------------------------------------------------------
psql_q "
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-000000000003','conc-dl@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, email) VALUES ('a0000000-0000-0000-0000-000000000003','conc-dl@test.com') ON CONFLICT DO NOTHING;
INSERT INTO public.workspaces (id, owner_id, name) VALUES ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000003','Concurrency WS 3 (deadlock)') ON CONFLICT DO NOTHING;
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000003','owner') ON CONFLICT DO NOTHING;
INSERT INTO public.pincode_monitored_products (id, workspace_id, marketplace_id, asin, product_source, status)
VALUES ('c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000003','A21TJRUUN4KGV','B000000DL1','other','active') ON CONFLICT DO NOTHING;
INSERT INTO public.pincode_tracking_targets (id, workspace_id, monitored_product_id, pincode, status, next_check_at)
SELECT gen_random_uuid(), 'b0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002', p, 'active', now() - interval '1 minute'
FROM unnest(ARRAY['200001','200002','200003','200004','200005','200006','200007','200008']) p
ON CONFLICT DO NOTHING;
" > /dev/null

cat > /tmp/dl_claim.sql <<'SQL'
\timing off
SELECT count(*) AS n FROM public.claim_due_pincode_targets(3, 'dl-claim', '{}'::uuid[], ARRAY['b0000000-0000-0000-0000-000000000003']::uuid[]);
SQL
cat > /tmp/dl_pause.sql <<'SQL'
\timing off
SELECT public.set_pincode_tracking_state('b0000000-0000-0000-0000-000000000003'::uuid, 'A21TJRUUN4KGV',
  (SELECT array_agg(id) FROM public.pincode_tracking_targets WHERE monitored_product_id='c0000000-0000-0000-0000-000000000002' AND status='active' LIMIT 2),
  'pause', 100) AS r;
SQL
cat > /tmp/dl_manual.sql <<'SQL'
\timing off
SELECT public.queue_pincode_manual_check(
  (SELECT id FROM public.pincode_tracking_targets WHERE monitored_product_id='c0000000-0000-0000-0000-000000000002' AND status='active' ORDER BY id LIMIT 1),
  'b0000000-0000-0000-0000-000000000003'::uuid, 'A21TJRUUN4KGV', 'a0000000-0000-0000-0000-000000000003'::uuid, 0, 50
) AS r;
SQL

DEADLOCK_FOUND=0
for i in 1 2 3 4 5; do
  psql_f /tmp/dl_claim.sql /tmp/dl_claim_$i.log &
  p1=$!
  psql_f /tmp/dl_pause.sql /tmp/dl_pause_$i.log &
  p2=$!
  psql_f /tmp/dl_manual.sql /tmp/dl_manual_$i.log &
  p3=$!
  wait $p1; wait $p2; wait $p3
  if grep -qil "deadlock\|lock timeout\|could not serialize" /tmp/dl_claim_$i.log /tmp/dl_pause_$i.log /tmp/dl_manual_$i.log; then
    DEADLOCK_FOUND=1
  fi
  psql_q "
    UPDATE public.pincode_tracking_targets SET status='active', claim_token=NULL, claimed_at=NULL, claimed_by=NULL, manual_requested_at=NULL, manual_requested_by=NULL, manual_request_token=NULL, next_check_at=now()-interval '1 minute'
    WHERE monitored_product_id='c0000000-0000-0000-0000-000000000002';
  " > /dev/null
done

if [ "$DEADLOCK_FOUND" -eq 0 ]; then
  pass "C4: 5 rounds of concurrent claim+pause+manual-queue -- zero deadlocks/lock-timeouts"
else
  fail "C4: deadlock or lock-timeout detected across the 5 concurrent rounds -- see /tmp/dl_*.log"
fi

echo ""
echo "=== Concurrency suite summary: $PASSES passed, $FAILURES failed ==="
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
