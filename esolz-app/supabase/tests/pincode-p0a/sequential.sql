-- Pincode Checker P0-A -- committed, repeatable sequential test suite.
--
-- Run ONLY against a scratch/local database bootstrapped from the real
-- repository migrations (001-063) -- see run-tests.sh, which refuses a
-- production connection before this file is ever invoked. Do not run this
-- file directly against any database you did not create solely to run it.
--
-- Every assertion RAISEs a plain, greppable EXCEPTION on failure. A clean
-- run (no ERROR output, ends with the final summary SELECT) means every
-- test below passed. Designed to run via:
--   psql -v ON_ERROR_STOP=1 -f sequential.sql
-- so the FIRST failing assertion stops the whole run with a non-zero exit
-- code -- run-tests.sh relies on psql's own exit code, it does not parse
-- output for pass/fail.
--
-- Self-contained: creates its own fixtures (workspaces, users, products,
-- targets) and does not depend on any other test file's state. Does not
-- clean up its own fixtures itself -- run-tests.sh drops the entire
-- scratch database after every phase completes, which is the actual
-- cleanup mechanism (simpler and more reliable than per-test teardown).

\set ON_ERROR_STOP on

BEGIN;

-- ---------- Seed ----------
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ownerA@test.com'),
  ('00000000-0000-0000-0000-000000000002', 'viewerA@test.com'),
  ('00000000-0000-0000-0000-000000000003', 'ownerB@test.com'),
  ('00000000-0000-0000-0000-000000000004', 'ownerC@test.com'),
  ('00000000-0000-0000-0000-000000000005', 'ownerD@test.com');

INSERT INTO public.profiles (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ownerA@test.com'),
  ('00000000-0000-0000-0000-000000000002', 'viewerA@test.com'),
  ('00000000-0000-0000-0000-000000000003', 'ownerB@test.com'),
  ('00000000-0000-0000-0000-000000000004', 'ownerC@test.com'),
  ('00000000-0000-0000-0000-000000000005', 'ownerD@test.com');

INSERT INTO public.workspaces (id, owner_id, name) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Workspace A'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'Workspace B'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004', 'Workspace C (claim isolation)'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005', 'Workspace D (quota concurrency)');

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'viewer'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'owner'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004', 'owner'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005', 'owner');

INSERT INTO public.amazon_connections (id, workspace_id, status) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'active'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'active'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'active');

INSERT INTO public.amazon_listing_items (id, workspace_id, connection_id, asin, marketplace_id, sku) VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'B000000001', 'A21TJRUUN4KGV', 'SKU-1'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'B000000002', 'A21TJRUUN4KGV', 'SKU-2'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'B000000009', 'A21TJRUUN4KGV', 'SKU-9'),
  -- Correction 3 fixture: a SECOND listing in workspace A with a DIFFERENT
  -- asin, used to prove "listing exists in the account" is not sufficient
  -- -- its own asin must match the requested one.
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'B0000000WRONG', 'A21TJRUUN4KGV', 'SKU-WRONG');

INSERT INTO public.tracked_asins (id, workspace_id, asin, marketplace) VALUES
  ('31000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'B000000010', 'A21TJRUUN4KGV'),
  ('31000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'B0000000WRO2', 'A21TJRUUN4KGV');

COMMIT;

-- Workspace C: a dedicated product with several pincodes, one per
-- claim/finalize test below, fully isolated from every other workspace's
-- due targets -- avoids cross-test fairness contamination (claim_due_
-- pincode_targets claims at most ONE target per workspace per round, so
-- any other due target in the same workspace would legitimately win that
-- round's slot instead of the one a given test means to exercise).
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000003'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'owned',
      'amazon_listing_item_id', '30000000-0000-0000-0000-000000000003',
      'asin', 'B000000009',
      'pincodes', jsonb_build_array('910001','910002','910003','910004','910005','910006')
    )),
    100
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'SEED FAILED: workspace C enrollment: %', v_result; END IF;
  UPDATE public.pincode_tracking_targets SET next_check_at = now() + interval '1 day'
  WHERE monitored_product_id = (SELECT id FROM public.pincode_monitored_products WHERE asin = 'B000000009');
END $$;

-- ============================================================
-- TEST 1: Cross-workspace FK rejection (composite FK, DATA_MODEL sec2 Correction 2)
-- ============================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO public.pincode_monitored_products (workspace_id, marketplace_id, asin, product_source, amazon_listing_item_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'A21TJRUUN4KGV', 'B000000002', 'owned', '30000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'TEST 1 FAILED: cross-workspace FK was NOT rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'TEST 1 PASSED: cross-workspace FK correctly rejected';
  END;
END $$;

-- ============================================================
-- TEST 2: RLS -- SELECT-only, no member write path, for all 3 tables
-- ============================================================
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.workspace_default_pincodes (workspace_id, marketplace_id, pincode) VALUES
      ('10000000-0000-0000-0000-000000000001', 'A21TJRUUN4KGV', '400001');
    RAISE EXCEPTION 'TEST 2a FAILED: viewer INSERT on workspace_default_pincodes was NOT rejected by RLS';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 2a PASSED: RLS rejected member INSERT on workspace_default_pincodes (no policy exists)';
  END;
  BEGIN
    UPDATE public.pincode_monitored_products SET status = 'archived' WHERE workspace_id = '10000000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'TEST 2b FAILED: viewer UPDATE on pincode_monitored_products was NOT rejected by RLS';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 2b PASSED: RLS rejected member UPDATE on pincode_monitored_products';
  END;
  BEGIN
    UPDATE public.pincode_tracking_targets SET status = 'paused';
    RAISE EXCEPTION 'TEST 2c FAILED: viewer UPDATE on pincode_tracking_targets was NOT rejected by RLS';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 2c PASSED: RLS rejected member UPDATE on pincode_tracking_targets';
  END;
  RESET ROLE;
END $$;

-- ============================================================
-- TEST 3: enroll_pincode_monitored_products -- happy path (owned, verified listing)
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_target_count integer;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'owned',
      'amazon_listing_item_id', '30000000-0000-0000-0000-000000000001',
      'asin', 'B000000001',
      'pincodes', jsonb_build_array('400001', '400002')
    )),
    100
  );
  IF v_result->>'result' <> 'success' THEN
    RAISE EXCEPTION 'TEST 3 FAILED: expected success, got %', v_result;
  END IF;
  SELECT count(*) INTO v_target_count FROM public.pincode_tracking_targets t
    JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
    WHERE p.asin = 'B000000001' AND p.workspace_id = '10000000-0000-0000-0000-000000000001';
  IF v_target_count <> 2 THEN
    RAISE EXCEPTION 'TEST 3 FAILED: expected 2 targets created, got %', v_target_count;
  END IF;
  RAISE NOTICE 'TEST 3 PASSED: enrollment created parent + 2 targets atomically';
END $$;

-- ============================================================
-- TEST 4: enroll_pincode_monitored_products -- owned without valid listing rejected
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'owned',
      'amazon_listing_item_id', '30000000-0000-0000-0000-000000000002', -- belongs to workspace B
      'asin', 'B000000009',
      'pincodes', jsonb_build_array('400003')
    )),
    100
  );
  IF v_result->>'result' <> 'listing_verification_failed' THEN
    RAISE EXCEPTION 'TEST 4 FAILED: expected listing_verification_failed, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4 PASSED: cross-workspace listing rejected the whole request';
END $$;

-- ============================================================
-- TEST 4a (Correction 3): owned listing EXISTS in-account but its OWN asin
-- does not match the requested ASIN -- must still be rejected. This is the
-- exact gap the correction closes: "verify existence" is not "verify
-- identity."
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'owned',
      'amazon_listing_item_id', '30000000-0000-0000-0000-000000000004', -- real listing in THIS workspace, but its asin is B0000000WRONG
      'asin', 'B000000020', -- requested asin does not match the listing's own asin
      'pincodes', jsonb_build_array('400009')
    )),
    100
  );
  IF v_result->>'result' <> 'listing_verification_failed' THEN
    RAISE EXCEPTION 'TEST 4a FAILED: same-workspace listing with a DIFFERENT asin was NOT rejected, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4a PASSED: in-account listing with a mismatched asin correctly rejected (identity, not just existence)';
END $$;

-- ============================================================
-- TEST 4b (Correction 3): malformed UUID in amazon_listing_item_id must
-- return invalid_parameters, never an uncontrolled cast exception.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'owned',
      'amazon_listing_item_id', 'not-a-real-uuid',
      'asin', 'B000000021',
      'pincodes', jsonb_build_array('400010')
    )),
    100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'malformed_listing_id' THEN
    RAISE EXCEPTION 'TEST 4b FAILED: malformed UUID did not return a controlled invalid_parameters result, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4b PASSED: malformed UUID handled as invalid_parameters, no uncontrolled cast exception';
END $$;

-- ============================================================
-- TEST 4c (Correction 3): product_source='other' carrying an
-- amazon_listing_item_id is contradictory input -- explicit rejection.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'other',
      'amazon_listing_item_id', '30000000-0000-0000-0000-000000000001',
      'asin', 'B000000001',
      'pincodes', jsonb_build_array('400011')
    )),
    100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'other_source_cannot_have_listing_id' THEN
    RAISE EXCEPTION 'TEST 4c FAILED: other-source + listing id was NOT rejected, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4c PASSED: other-source with a listing id explicitly rejected, not silently reinterpreted';
END $$;

-- ============================================================
-- TEST 4d (Correction 3): tracked_asin_id must match workspace, the
-- tracked_asins table's own `marketplace` column, and the normalized ASIN.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Valid tracked_asin_id, matching asin -- should succeed.
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'other',
      'tracked_asin_id', '31000000-0000-0000-0000-000000000001',
      'asin', 'B000000010',
      'pincodes', jsonb_build_array('400012')
    )),
    100
  );
  IF v_result->>'result' <> 'success' THEN
    RAISE EXCEPTION 'TEST 4d FAILED: valid tracked_asin_id was rejected, got %', v_result;
  END IF;

  -- Same tracked_asin_id, but requested asin does not match its own asin
  -- column -- must be rejected.
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'other',
      'tracked_asin_id', '31000000-0000-0000-0000-000000000002', -- real row, asin = B0000000WRO2
      'asin', 'B000000099', -- does not match
      'pincodes', jsonb_build_array('400013')
    )),
    100
  );
  IF v_result->>'result' <> 'listing_verification_failed' OR v_result->>'reason' <> 'tracked_asin_mismatch' THEN
    RAISE EXCEPTION 'TEST 4d FAILED: mismatched tracked_asin_id/asin was NOT rejected, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4d PASSED: tracked_asin_id verified against workspace + marketplace (tracked_asins.marketplace) + asin';
END $$;

-- ============================================================
-- TEST 4e (Correction 3): duplicate ASIN objects with CONFLICTING
-- metadata are rejected outright, never resolved by an arbitrary winner.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(
      jsonb_build_object('product_source','other','asin','B000000050','pincodes', jsonb_build_array('400014')),
      jsonb_build_object('product_source','owned','amazon_listing_item_id','30000000-0000-0000-0000-000000000001','asin','B000000050','pincodes', jsonb_build_array('400015'))
    ),
    100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'conflicting_duplicate_asin_metadata' THEN
    RAISE EXCEPTION 'TEST 4e FAILED: conflicting duplicate ASIN metadata was NOT rejected, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 4e PASSED: conflicting duplicate ASIN metadata rejected, no arbitrary-winner resolution';
END $$;

-- ============================================================
-- TEST 5: Enrollment quota rejection -- 409-equivalent shape, all-or-nothing
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_target_count integer;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source', 'other',
      'asin', 'B000000003',
      'pincodes', jsonb_build_array('400001','400002','400003','400004','400005')
    )),
    5  -- current(3: 400001,400002,400012) + requested(5) = 8, exceeds 5
  );
  IF v_result->>'result' <> 'quota_exceeded' THEN
    RAISE EXCEPTION 'TEST 5 FAILED: expected quota_exceeded, got %', v_result;
  END IF;
  SELECT count(*) INTO v_target_count FROM public.pincode_monitored_products WHERE asin = 'B000000003';
  IF v_target_count <> 0 THEN
    RAISE EXCEPTION 'TEST 5 FAILED: partial write occurred despite rejection (all-or-nothing violated)';
  END IF;
  RAISE NOTICE 'TEST 5 PASSED: quota exceeded rejected the whole batch, zero partial writes';
END $$;

-- ============================================================
-- TEST 6: Bulk enrollment all-or-nothing across MULTIPLE products
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_count integer;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(
      jsonb_build_object('product_source','other','asin','B000000004','pincodes', jsonb_build_array('500001')),
      jsonb_build_object('product_source','other','asin','B000000005','pincodes', jsonb_build_array('500002','500003','500004','500005','500006'))
    ),
    5 -- current 3 + requested (1+5=6) exceeds 5
  );
  IF v_result->>'result' <> 'quota_exceeded' THEN
    RAISE EXCEPTION 'TEST 6 FAILED: expected quota_exceeded, got %', v_result;
  END IF;
  SELECT count(*) INTO v_count FROM public.pincode_monitored_products WHERE asin IN ('B000000004','B000000005');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST 6 FAILED: partial multi-product write occurred (% rows)', v_count;
  END IF;
  RAISE NOTICE 'TEST 6 PASSED: multi-product bulk enrollment genuinely all-or-nothing';
END $$;

-- ============================================================
-- TEST 7: Duplicate (asin,pincode) pairs normalized before quota calc
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object(
      'product_source','other','asin','B000000006',
      'pincodes', jsonb_build_array('600001','600001','600001')  -- same pincode 3x
    )),
    100
  );
  IF v_result->>'result' <> 'success' OR (v_result->>'requestedAdditionalTargets')::int <> 1 THEN
    RAISE EXCEPTION 'TEST 7 FAILED: duplicate pincodes not normalized, got %', v_result;
  END IF;
  RAISE NOTICE 'TEST 7 PASSED: duplicate (asin,pincode) pairs normalized to 1 before quota calc';
END $$;

-- ============================================================
-- TEST 8: NULL-safe finalize validation (actual SQL NULL, not JS undefined)
-- ============================================================
DO $$
BEGIN
  BEGIN
    PERFORM public.finalize_pincode_check(gen_random_uuid(), NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'TEST 8a FAILED: NULL check_status was NOT rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'TEST 8a FAILED: wrong error %', SQLSTATE; END IF;
    RAISE NOTICE 'TEST 8a PASSED: NULL check_status rejected with invalid_check_status';
  END;

  BEGIN
    PERFORM public.finalize_pincode_check(gen_random_uuid(), 'success', NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'TEST 8b FAILED: NULL availability_status on success was NOT rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'TEST 8b FAILED: wrong error %', SQLSTATE; END IF;
    RAISE NOTICE 'TEST 8b PASSED: NULL availability_status on success rejected';
  END;

  BEGIN
    PERFORM public.finalize_pincode_check(gen_random_uuid(), 'failed', 'available', NULL, NULL, NULL);
    RAISE EXCEPTION 'TEST 8c FAILED: non-null availability on failed was NOT rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'TEST 8c FAILED: wrong error %', SQLSTATE; END IF;
    RAISE NOTICE 'TEST 8c PASSED: non-null availability on failed/blocked rejected';
  END;
END $$;

-- Tests 9-11 use Workspace C's dedicated pincodes (910001/910002/910003),
-- fully isolated from every other workspace's due targets.
-- ============================================================
-- TEST 9: Full claim -> finalize cycle (happy path)
-- ============================================================
DO $$
DECLARE
  v_target_id uuid;
  v_claimed public.pincode_tracking_targets;
  v_result public.pincode_availability_results;
BEGIN
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE pincode = '910001'
    AND monitored_product_id = (SELECT id FROM public.pincode_monitored_products WHERE asin = 'B000000009');
  UPDATE public.pincode_tracking_targets SET next_check_at = now() - interval '1 minute' WHERE id = v_target_id;

  SELECT * INTO v_claimed FROM public.claim_due_pincode_targets(
    10, 'test-invocation-1', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000003']::uuid[]
  ) WHERE id = v_target_id;

  IF v_claimed.id IS NULL THEN
    RAISE EXCEPTION 'TEST 9 FAILED: target was not claimed';
  END IF;
  IF v_claimed.status <> 'checking' OR v_claimed.claim_token IS NULL THEN
    RAISE EXCEPTION 'TEST 9 FAILED: claimed target not in checking state with token';
  END IF;

  v_result := public.finalize_pincode_check(v_claimed.claim_token, 'success', 'available', 'In stock', NULL, NULL);
  IF v_result.check_status <> 'success' THEN
    RAISE EXCEPTION 'TEST 9 FAILED: finalize did not record success';
  END IF;

  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_target_id AND status = 'active' AND claim_token IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 9 FAILED: target not finalized back to active with claim cleared';
  END IF;
  RAISE NOTICE 'TEST 9 PASSED: full claim -> finalize cycle correct';
END $$;

-- ============================================================
-- TEST 10: Idempotent finalize retry (same token twice) creates ONE result
-- ============================================================
DO $$
DECLARE
  v_target_id uuid;
  v_claimed public.pincode_tracking_targets;
  v_result1 public.pincode_availability_results;
  v_result2 public.pincode_availability_results;
  v_count integer;
BEGIN
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE pincode = '910002'
    AND monitored_product_id = (SELECT id FROM public.pincode_monitored_products WHERE asin = 'B000000009');
  UPDATE public.pincode_tracking_targets SET next_check_at = now() - interval '1 minute' WHERE id = v_target_id;

  SELECT * INTO v_claimed FROM public.claim_due_pincode_targets(
    10, 'test-invocation-2', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000003']::uuid[]
  ) WHERE id = v_target_id;

  v_result1 := public.finalize_pincode_check(v_claimed.claim_token, 'success', 'unavailable', NULL, NULL, NULL);
  v_result2 := public.finalize_pincode_check(v_claimed.claim_token, 'success', 'unavailable', NULL, NULL, NULL);

  IF v_result1.id <> v_result2.id THEN
    RAISE EXCEPTION 'TEST 10 FAILED: retried finalize created a different result row';
  END IF;
  SELECT count(*) INTO v_count FROM public.pincode_availability_results WHERE check_attempt_id = v_claimed.claim_token;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST 10 FAILED: expected exactly 1 result row, got %', v_count;
  END IF;
  RAISE NOTICE 'TEST 10 PASSED: idempotent retry with same token creates exactly one result';
END $$;

-- ============================================================
-- TEST 11: Stale finalize after reclaim rejected, does not corrupt new claim
-- ============================================================
DO $$
DECLARE
  v_target_id uuid;
  v_claimed_a public.pincode_tracking_targets;
  v_claimed_b public.pincode_tracking_targets;
  v_stale_token uuid;
  v_count integer;
BEGIN
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE pincode = '910003'
    AND monitored_product_id = (SELECT id FROM public.pincode_monitored_products WHERE asin = 'B000000009');
  UPDATE public.pincode_tracking_targets SET next_check_at = now() - interval '1 minute' WHERE id = v_target_id;

  SELECT * INTO v_claimed_a FROM public.claim_due_pincode_targets(
    10, 'test-invocation-3a', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000003']::uuid[]
  ) WHERE id = v_target_id;
  v_stale_token := v_claimed_a.claim_token;

  -- Simulate stale-claim reclaim directly (sec2.4's SQL, worker-owned, not an RPC).
  UPDATE public.pincode_tracking_targets
  SET status = 'active', claimed_at = NULL, claimed_by = NULL, claim_token = NULL, next_check_at = now()
  WHERE id = v_target_id AND claim_token = v_stale_token;

  SELECT * INTO v_claimed_b FROM public.claim_due_pincode_targets(
    10, 'test-invocation-3b', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000003']::uuid[]
  ) WHERE id = v_target_id;

  IF v_claimed_b.id IS NULL THEN
    RAISE EXCEPTION 'TEST 11 FAILED: target was not re-claimed after reclaim';
  END IF;
  IF v_claimed_b.claim_token = v_stale_token THEN
    RAISE EXCEPTION 'TEST 11 FAILED: re-claim produced the same stale token';
  END IF;

  BEGIN
    PERFORM public.finalize_pincode_check(v_stale_token, 'success', 'available', NULL, NULL, NULL);
    RAISE EXCEPTION 'TEST 11 FAILED: stale finalize was NOT rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' THEN RAISE EXCEPTION 'TEST 11 FAILED: wrong error %', SQLSTATE; END IF;
  END;

  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_target_id AND claim_token = v_claimed_b.claim_token AND status = 'checking';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 11 FAILED: stale finalize corrupted claim B''s state';
  END IF;
  PERFORM public.finalize_pincode_check(v_claimed_b.claim_token, 'success', 'available', NULL, NULL, NULL);

  SELECT count(*) INTO v_count FROM public.pincode_availability_results WHERE tracking_target_id = v_target_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST 11 FAILED: expected exactly 1 result row after B finalized, got %', v_count;
  END IF;
  RAISE NOTICE 'TEST 11 PASSED: stale reclaimed attempt rejected, new claim unaffected, exactly one result recorded';
END $$;

-- ============================================================
-- TEST 12: Allowlist fail-closed (NULL and empty both return zero rows;
-- a workspace excluded from a non-empty allowlist is never claimed)
-- ============================================================
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.claim_due_pincode_targets(10, 'test-allowlist-null', '{}'::uuid[], NULL);
  IF v_count <> 0 THEN RAISE EXCEPTION 'TEST 12a FAILED: NULL allowlist claimed % rows', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.claim_due_pincode_targets(10, 'test-allowlist-empty', '{}'::uuid[], '{}'::uuid[]);
  IF v_count <> 0 THEN RAISE EXCEPTION 'TEST 12b FAILED: empty allowlist claimed % rows', v_count; END IF;

  IF EXISTS (
    SELECT 1 FROM public.claim_due_pincode_targets(
      10, 'test-allowlist-excluded', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000003']::uuid[]
    ) WHERE workspace_id = '10000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'TEST 12c FAILED: non-allowlisted workspace A targets were claimed';
  END IF;

  RAISE NOTICE 'TEST 12 PASSED: allowlist fails closed on NULL, empty, and non-membership';
END $$;

-- ============================================================
-- TEST 13: History hard-delete rejection (product with real result history)
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_result_count integer;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000009';
  SELECT count(*) INTO v_result_count FROM public.pincode_availability_results WHERE monitored_product_id = v_product_id;
  IF v_result_count = 0 THEN
    RAISE EXCEPTION 'TEST 13 SETUP FAILED: expected result history on B000000009, found none';
  END IF;
  BEGIN
    DELETE FROM public.pincode_monitored_products WHERE id = v_product_id;
    RAISE EXCEPTION 'TEST 13 FAILED: hard delete of a product with history was NOT rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'TEST 13 PASSED: hard delete rejected by RESTRICT FK (pincode_availability_results history)';
  END;
END $$;

-- ============================================================
-- TEST 13a (Correction 5): direct TARGET deletion with real result history
-- rejected (pincode_availability_results_tracking_target_fk, RESTRICT).
-- ============================================================
DO $$
DECLARE
  v_target_id uuid;
BEGIN
  SELECT tracking_target_id INTO v_target_id FROM public.pincode_availability_results
    WHERE monitored_product_id = (SELECT id FROM public.pincode_monitored_products WHERE asin = 'B000000009')
    LIMIT 1;
  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'TEST 13a SETUP FAILED: no result row with a tracking_target_id found';
  END IF;
  BEGIN
    DELETE FROM public.pincode_tracking_targets WHERE id = v_target_id;
    RAISE EXCEPTION 'TEST 13a FAILED: direct target deletion with history was NOT rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'TEST 13a PASSED: direct target deletion with history correctly rejected';
  END;
END $$;

-- ============================================================
-- TEST 13b (Correction 5): direct monitored-product deletion rejected when
-- it still has TARGETS, even with ZERO result history -- this is the new
-- ON DELETE RESTRICT behavior on pincode_tracking_targets_monitored_
-- product_fk (previously CASCADE, which would have silently erased the
-- targets instead of rejecting).
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_result_count integer;
BEGIN
  -- B000000006 (workspace A) has a target (600001) but has never been
  -- claimed/finalized -- zero pincode_availability_results rows -- so this
  -- specifically tests the NEW parent-target RESTRICT, not the pre-existing
  -- results-table RESTRICT already covered by TEST 13.
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000006';
  SELECT count(*) INTO v_result_count FROM public.pincode_availability_results WHERE monitored_product_id = v_product_id;
  IF v_result_count <> 0 THEN
    RAISE EXCEPTION 'TEST 13b SETUP FAILED: expected zero result history on B000000006, found %', v_result_count;
  END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 13b SETUP FAILED: expected at least one target on B000000006, found none';
  END IF;
  BEGIN
    DELETE FROM public.pincode_monitored_products WHERE id = v_product_id;
    RAISE EXCEPTION 'TEST 13b FAILED: direct product deletion with targets (no history) was NOT rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'TEST 13b PASSED: direct product deletion with targets correctly rejected even with zero history';
  END;
END $$;

-- ============================================================
-- TEST 13c (Correction 5): workspace-level full-cleanup cascade is
-- retained and still works correctly -- deleting an entire workspace must
-- still cascade through BOTH pincode_monitored_products and pincode_
-- tracking_targets (each via its own independent workspace_id CASCADE),
-- despite the parent-to-target FK now being RESTRICT. Run in its own
-- sub-transaction (SAVEPOINT) and rolled back -- this test proves the
-- cascade WORKS, it does not intend to actually destroy fixture data other
-- tests depend on.
-- ============================================================
DO $$
DECLARE
  v_owner_id uuid := '00000000-0000-0000-0000-00000000009d';
  v_ws_id    uuid := '10000000-0000-0000-0000-00000000009d';
  v_product_id uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_owner_id, 'wsdeltest@test.com');
  INSERT INTO public.profiles (id, email) VALUES (v_owner_id, 'wsdeltest@test.com');
  INSERT INTO public.workspaces (id, owner_id, name) VALUES (v_ws_id, v_owner_id, 'Delete-Test WS');
  INSERT INTO public.pincode_monitored_products (id, workspace_id, marketplace_id, asin, product_source, status)
  VALUES (gen_random_uuid(), v_ws_id, 'A21TJRUUN4KGV', 'B000000999', 'other', 'active')
  RETURNING id INTO v_product_id;
  INSERT INTO public.pincode_tracking_targets (workspace_id, monitored_product_id, pincode, status, next_check_at)
  VALUES (v_ws_id, v_product_id, '800001', 'active', now());

  DELETE FROM public.workspaces WHERE id = v_ws_id;

  PERFORM 1 FROM public.pincode_monitored_products WHERE workspace_id = v_ws_id;
  IF FOUND THEN RAISE EXCEPTION 'TEST 13c FAILED: pincode_monitored_products row survived workspace delete'; END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE workspace_id = v_ws_id;
  IF FOUND THEN RAISE EXCEPTION 'TEST 13c FAILED: pincode_tracking_targets row survived workspace delete'; END IF;

  RAISE NOTICE 'TEST 13c PASSED: whole-workspace deletion still cascades through both tables cleanly';
END $$;

-- ============================================================
-- TEST 14: Pause -> Remove -> Re-add atomic restore
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_ids uuid[];
  v_remove_result jsonb;
  v_readd_result jsonb;
  v_status text;
  v_removed_at timestamptz;
  v_removal_reason text;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000006';
  SELECT array_agg(id) INTO v_target_ids FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id;

  v_remove_result := public.remove_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_product_id], 'user_requested'
  );
  IF v_remove_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 14a FAILED: remove did not succeed: %', v_remove_result; END IF;

  SELECT status, removed_at, removal_reason INTO v_status, v_removed_at, v_removal_reason FROM public.pincode_monitored_products WHERE id = v_product_id;
  IF v_status <> 'removed' OR v_removed_at IS NULL OR v_removal_reason IS NULL THEN
    RAISE EXCEPTION 'TEST 14a FAILED: parent not removed correctly (status=%, removed_at=%, removal_reason=%)', v_status, v_removed_at, v_removal_reason;
  END IF;

  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = ANY(v_target_ids) AND status = 'paused';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 14a FAILED: target not paused on removal'; END IF;

  -- Idempotent re-removal: no-op, not an error.
  v_remove_result := public.remove_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_product_id], 'user_requested'
  );
  IF v_remove_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 14b FAILED: idempotent re-removal errored: %', v_remove_result; END IF;

  -- Re-add: atomic restore, same product id, reactivates the paused target, no second Resume call.
  v_readd_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000006','pincodes', jsonb_build_array('600001'))),
    100
  );
  IF v_readd_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 14c FAILED: re-add did not succeed: %', v_readd_result; END IF;

  SELECT status, removed_at, removal_reason INTO v_status, v_removed_at, v_removal_reason FROM public.pincode_monitored_products WHERE id = v_product_id;
  IF v_status <> 'active' OR v_removed_at IS NOT NULL OR v_removal_reason IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 14c FAILED: parent not restored to active, removed_at/removal_reason not cleared';
  END IF;

  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = ANY(v_target_ids) AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 14c FAILED: target not reactivated in the same re-add call'; END IF;

  -- All IDs/history remain joined after soft removal + restore -- same
  -- monitored_product_id, same target ids, nothing recreated.
  PERFORM 1 FROM public.pincode_monitored_products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 14d FAILED: product row identity changed across remove/re-add'; END IF;

  RAISE NOTICE 'TEST 14 PASSED: remove is idempotent, re-add atomically restores parent AND reactivates targets, same row id, history stays joined';
END $$;

-- ============================================================
-- TEST 15: set_pincode_tracking_state pause/resume + quota + in-flight safety
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id1 uuid;
  v_target_id2 uuid;
  v_result jsonb;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000007','pincodes', jsonb_build_array('700001','700002'))),
    100
  );
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000007';
  SELECT id INTO v_target_id1 FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '700001';
  SELECT id INTO v_target_id2 FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '700002';

  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_target_id1, v_target_id2], 'pause', 100);
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 15a FAILED: pause did not succeed: %', v_result; END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id IN (v_target_id1, v_target_id2) AND status = 'paused';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 15a FAILED: targets not paused'; END IF;

  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_target_id1, v_target_id2], 'resume', 1);
  IF v_result->>'result' <> 'quota_exceeded' THEN RAISE EXCEPTION 'TEST 15b FAILED: expected quota_exceeded on resume, got %', v_result; END IF;

  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_target_id1, v_target_id2], 'resume', 100);
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 15c FAILED: resume under quota did not succeed: %', v_result; END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id IN (v_target_id1, v_target_id2) AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 15c FAILED: targets not resumed'; END IF;

  UPDATE public.pincode_tracking_targets SET next_check_at = now() - interval '1 minute' WHERE id = v_target_id1;
  PERFORM 1 FROM public.claim_due_pincode_targets(10, 'test-inv-15', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000001']::uuid[]) c
    WHERE c.id = v_target_id1;
  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_target_id1, v_target_id2], 'pause', 100);
  IF v_result->>'result' <> 'check_in_progress' THEN RAISE EXCEPTION 'TEST 15d FAILED: expected check_in_progress, got %', v_result; END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_target_id2 AND status = 'paused';
  IF FOUND THEN RAISE EXCEPTION 'TEST 15d FAILED: whole-batch-reject violated, target2 was paused anyway'; END IF;

  RAISE NOTICE 'TEST 15 PASSED: pause/resume quota-checked, in-flight target rejects whole batch';
END $$;

-- ============================================================
-- TEST 16: queue_pincode_manual_check coalescing + cooldown + status matrix
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id uuid;
  v_result jsonb;
  v_token1 uuid;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000001';
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '400002';
  UPDATE public.pincode_tracking_targets SET status='active', manual_requested_at = NULL, manual_request_token = NULL, last_checked_at = NULL WHERE id = v_target_id;

  v_result := public.queue_pincode_manual_check(v_target_id, '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '00000000-0000-0000-0000-000000000001'::uuid, 300, 10);
  IF v_result->>'result' <> 'queued' THEN RAISE EXCEPTION 'TEST 16a FAILED: expected queued, got %', v_result; END IF;
  v_token1 := (v_result->>'manual_request_token')::uuid;

  v_result := public.queue_pincode_manual_check(v_target_id, '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '00000000-0000-0000-0000-000000000001'::uuid, 300, 10);
  IF v_result->>'result' <> 'already_queued' OR (v_result->>'manual_request_token')::uuid <> v_token1 THEN
    RAISE EXCEPTION 'TEST 16b FAILED: second concurrent-ish call was not coalesced: %', v_result;
  END IF;

  UPDATE public.pincode_tracking_targets SET manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL, last_checked_at = now() WHERE id = v_target_id;
  v_result := public.queue_pincode_manual_check(v_target_id, '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '00000000-0000-0000-0000-000000000001'::uuid, 300, 10);
  IF v_result->>'result' <> 'cooldown' THEN RAISE EXCEPTION 'TEST 16c FAILED: expected cooldown, got %', v_result; END IF;

  UPDATE public.pincode_monitored_products SET status = 'archived' WHERE id = v_product_id;
  UPDATE public.pincode_tracking_targets SET last_checked_at = NULL WHERE id = v_target_id;
  v_result := public.queue_pincode_manual_check(v_target_id, '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '00000000-0000-0000-0000-000000000001'::uuid, 300, 10);
  IF v_result->>'result' <> 'invalid_status' OR v_result->>'reason' <> 'product_archived_or_removed' THEN
    RAISE EXCEPTION 'TEST 16d FAILED: archived parent did not reject: %', v_result;
  END IF;
  UPDATE public.pincode_monitored_products SET status = 'active' WHERE id = v_product_id;

  RAISE NOTICE 'TEST 16 PASSED: manual check coalesced, cooldown enforced, archived parent rejects regardless of target status';
END $$;

-- ============================================================
-- TEST 17 (Correction 2): set_pincode_tracking_state -- complete-batch ID
-- validation. One valid + one nonexistent ID; one local + one foreign-
-- workspace ID; duplicate IDs; null ID inside array; complete rollback.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_local_id uuid;
  v_foreign_id uuid;
  v_before_status text;
BEGIN
  -- Fresh, dedicated product+pincode for this test -- test 15's target
  -- 700001 is deliberately left 'checking' at the end of test 15 (to prove
  -- the in-flight rejection), so it must not be reused here.
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000008','pincodes', jsonb_build_array('750001'))),
    100
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 17 SETUP FAILED: enrollment: %', v_result; END IF;

  SELECT id INTO v_local_id FROM public.pincode_tracking_targets WHERE pincode = '750001';
  SELECT t.id INTO v_foreign_id FROM public.pincode_tracking_targets t
    JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
    WHERE p.workspace_id = '10000000-0000-0000-0000-000000000003' LIMIT 1; -- workspace C, foreign to A
  SELECT status INTO v_before_status FROM public.pincode_tracking_targets WHERE id = v_local_id;

  -- 17a: one valid + one nonexistent id.
  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, gen_random_uuid()], 'pause', 100);
  IF v_result->>'result' <> 'not_found_or_scope_mismatch' THEN
    RAISE EXCEPTION 'TEST 17a FAILED: expected not_found_or_scope_mismatch, got %', v_result;
  END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_local_id AND status = v_before_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 17a FAILED: the valid id was mutated despite overall rejection (partial mutation)'; END IF;

  -- 17b: one local + one foreign-workspace id.
  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, v_foreign_id], 'pause', 100);
  IF v_result->>'result' <> 'not_found_or_scope_mismatch' THEN
    RAISE EXCEPTION 'TEST 17b FAILED: expected not_found_or_scope_mismatch for foreign-workspace id, got %', v_result;
  END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_local_id AND status = v_before_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 17b FAILED: the local id was mutated despite the foreign id causing rejection'; END IF;
  PERFORM 1 FROM public.pincode_tracking_targets WHERE id = v_foreign_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 17b FAILED: the foreign workspace C target was mutated by a workspace A call'; END IF;

  -- 17c: duplicate ids -- normalized, does not by itself cause rejection.
  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, v_local_id, v_local_id], 'pause', 100);
  IF v_result->>'result' <> 'success' OR (v_result->>'targetCount')::int <> 1 THEN
    RAISE EXCEPTION 'TEST 17c FAILED: duplicate ids not normalized to 1, got %', v_result;
  END IF;
  -- restore for the next sub-test
  PERFORM public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', ARRAY[v_local_id], 'resume', 100);

  -- 17d: null id inside array.
  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, NULL]::uuid[], 'pause', 100);
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'null_id_in_array' THEN
    RAISE EXCEPTION 'TEST 17d FAILED: null id in array was not rejected, got %', v_result;
  END IF;

  RAISE NOTICE 'TEST 17 PASSED: set_pincode_tracking_state complete-batch ID validation (missing/foreign/duplicate/null), no partial mutation';
END $$;

-- ============================================================
-- TEST 18 (Correction 2): remove_pincode_monitored_products -- same
-- complete-batch ID validation shape as TEST 17.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_local_id uuid;
  v_foreign_id uuid;
  v_before_status text;
BEGIN
  SELECT id INTO v_local_id FROM public.pincode_monitored_products WHERE asin = 'B000000006';
  SELECT id INTO v_foreign_id FROM public.pincode_monitored_products WHERE workspace_id = '10000000-0000-0000-0000-000000000003' LIMIT 1;
  SELECT status INTO v_before_status FROM public.pincode_monitored_products WHERE id = v_local_id;

  -- 18a: one valid + one nonexistent id.
  v_result := public.remove_pincode_monitored_products('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, gen_random_uuid()], 'user_requested');
  IF v_result->>'result' <> 'not_found_or_scope_mismatch' THEN
    RAISE EXCEPTION 'TEST 18a FAILED: expected not_found_or_scope_mismatch, got %', v_result;
  END IF;
  PERFORM 1 FROM public.pincode_monitored_products WHERE id = v_local_id AND status = v_before_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 18a FAILED: the valid id was mutated despite overall rejection'; END IF;

  -- 18b: one local + one foreign-workspace id.
  v_result := public.remove_pincode_monitored_products('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, v_foreign_id], 'user_requested');
  IF v_result->>'result' <> 'not_found_or_scope_mismatch' THEN
    RAISE EXCEPTION 'TEST 18b FAILED: expected not_found_or_scope_mismatch for foreign-workspace id, got %', v_result;
  END IF;
  PERFORM 1 FROM public.pincode_monitored_products WHERE id = v_foreign_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST 18b FAILED: the foreign workspace C product was mutated by a workspace A call'; END IF;

  -- 18c: duplicate ids -- normalized.
  v_result := public.remove_pincode_monitored_products('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, v_local_id], 'user_requested');
  IF v_result->>'result' <> 'success' OR (v_result->>'productCount')::int <> 1 THEN
    RAISE EXCEPTION 'TEST 18c FAILED: duplicate ids not normalized to 1, got %', v_result;
  END IF;

  -- 18d: null id inside array (fresh product, since the one above is now removed).
  v_result := public.remove_pincode_monitored_products('10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_local_id, NULL]::uuid[], 'user_requested');
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'null_id_in_array' THEN
    RAISE EXCEPTION 'TEST 18d FAILED: null id in array was not rejected, got %', v_result;
  END IF;

  RAISE NOTICE 'TEST 18 PASSED: remove_pincode_monitored_products complete-batch ID validation (missing/foreign/duplicate/null), no partial mutation';
END $$;

-- ============================================================
-- TEST 19 (Correction 6): removal consistency CHECK strengthened --
-- removal_reason is now required and narrow-valued whenever status='removed'.
-- ============================================================
DO $$
BEGIN
  BEGIN
    UPDATE public.pincode_monitored_products
    SET status = 'removed', removed_at = now(), removal_reason = NULL
    WHERE asin = 'B000000009';
    RAISE EXCEPTION 'TEST 19a FAILED: removed status with NULL removal_reason was NOT rejected';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 19a PASSED: removed status with NULL removal_reason rejected by CHECK';
  END;

  BEGIN
    UPDATE public.pincode_monitored_products
    SET status = 'removed', removed_at = now(), removal_reason = 'not_a_real_reason'
    WHERE asin = 'B000000009';
    RAISE EXCEPTION 'TEST 19b FAILED: arbitrary removal_reason was NOT rejected';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST 19b PASSED: arbitrary/non-allow-listed removal_reason rejected by CHECK';
  END;
END $$;

-- ============================================================
-- TEST 20 (Correction 4): hard configuration ceilings reject malformed
-- config values outright, independent of business-logic quota rejection.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- A quota "limit" of 10 million is clearly a misconfigured environment
  -- value, not a real commercial tier -- must be rejected as
  -- invalid_parameters, not silently treated as "unlimited."
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000004'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000801','pincodes', jsonb_build_array('900001'))),
    10000000
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_quota_limit' THEN
    RAISE EXCEPTION 'TEST 20a FAILED: oversized quota limit was not rejected, got %', v_result;
  END IF;

  v_result := public.set_pincode_tracking_state('10000000-0000-0000-0000-000000000004'::uuid, 'A21TJRUUN4KGV',
    ARRAY[gen_random_uuid()], 'pause', 10000000);
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_quota_limit' THEN
    RAISE EXCEPTION 'TEST 20b FAILED: oversized quota limit was not rejected in set_pincode_tracking_state, got %', v_result;
  END IF;

  v_result := public.queue_pincode_manual_check(gen_random_uuid(), '10000000-0000-0000-0000-000000000004'::uuid, 'A21TJRUUN4KGV', gen_random_uuid(), 60, 999999999);
  IF v_result->>'result' <> 'invalid_status' OR v_result->>'reason' <> 'invalid_manual_pending_limit' THEN
    RAISE EXCEPTION 'TEST 20c FAILED: oversized manual pending limit was not rejected, got %', v_result;
  END IF;

  -- Marketplace string length ceiling.
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000004'::uuid, repeat('X', 100),
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000802','pincodes', jsonb_build_array('900002'))),
    100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_marketplace_id' THEN
    RAISE EXCEPTION 'TEST 20d FAILED: oversized marketplace_id was not rejected, got %', v_result;
  END IF;

  RAISE NOTICE 'TEST 20 PASSED: hard configuration ceilings reject malformed values independent of business quota logic';
END $$;

-- ============================================================
-- PR #55 REVIEW ROUND -- Correction 2/3/4: target configuration lifecycle,
-- replace_pincode_product_targets, replace_workspace_default_pincodes,
-- get_pincode_target_results.
-- ============================================================

-- ============================================================
-- TEST 21: replace_pincode_product_targets -- add/reconfigure/unconfigure,
-- ID preservation, atomicity, empty-list rejection, quota rejection.
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_product_id uuid;
  v_target_110001_id uuid;
  v_before_count integer;
  v_after_count integer;
BEGIN
  v_result := public.enroll_pincode_monitored_products(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(jsonb_build_object('product_source','other','asin','B000000EDT','pincodes', jsonb_build_array('110001','110002','110003'))),
    100
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 21 SETUP FAILED: %', v_result; END IF;
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_target_110001_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110001';

  -- Replace with {110002,110003,110004}: 110001 dropped (unconfigure),
  -- 110002/110003 kept as-is, 110004 genuinely new.
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110002','110003','110004'], 100
  );
  IF v_result->>'result' <> 'success' OR (v_result->>'addedCount')::int <> 1
     OR (v_result->>'unconfiguredCount')::int <> 1 OR (v_result->>'reconfiguredCount')::int <> 0 THEN
    RAISE EXCEPTION 'TEST 21a FAILED: unexpected replace result: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_target_110001_id AND is_configured = false AND unconfigured_at IS NOT NULL AND status = 'paused' AND next_check_at IS NULL) THEN
    RAISE EXCEPTION 'TEST 21a FAILED: 110001 was not correctly unconfigured/paused/unscheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110004' AND is_configured = true AND status = 'active') THEN
    RAISE EXCEPTION 'TEST 21a FAILED: 110004 was not correctly added as a new active configured target';
  END IF;

  -- Reconfigure 110001, drop 110003/110004 -- same target ID reused, not a new row.
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110001','110002'], 100
  );
  IF v_result->>'result' <> 'success' OR (v_result->>'addedCount')::int <> 0
     OR (v_result->>'reconfiguredCount')::int <> 1 OR (v_result->>'unconfiguredCount')::int <> 2 THEN
    RAISE EXCEPTION 'TEST 21b FAILED: unexpected reconfigure result: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_target_110001_id AND is_configured = true AND unconfigured_at IS NULL AND status = 'active') THEN
    RAISE EXCEPTION 'TEST 21b FAILED: 110001 was not correctly reconfigured on the SAME target ID (%)', v_target_110001_id;
  END IF;

  -- Empty list is rejected outright (P0 decision: use Remove Tracking for
  -- whole-product removal instead) -- no mutation.
  SELECT count(*) INTO v_before_count FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND is_configured = true;
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id, '{}'::text[], 100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'empty_pincodes_use_remove_tracking' THEN
    RAISE EXCEPTION 'TEST 21c FAILED: empty pincode list was not rejected, got %', v_result;
  END IF;
  SELECT count(*) INTO v_after_count FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND is_configured = true;
  IF v_before_count <> v_after_count THEN
    RAISE EXCEPTION 'TEST 21c FAILED: rejected empty-list call still mutated configured targets (% -> %)', v_before_count, v_after_count;
  END IF;

  -- Quota rejection: whole call atomic, zero mutation.
  SELECT count(*) INTO v_before_count FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND is_configured = true;
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110001','110002','110005','110006','110007'], 1
  );
  IF v_result->>'result' <> 'quota_exceeded' THEN
    RAISE EXCEPTION 'TEST 21d FAILED: over-quota replace was not rejected, got %', v_result;
  END IF;
  SELECT count(*) INTO v_after_count FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND is_configured = true;
  IF v_before_count <> v_after_count THEN
    RAISE EXCEPTION 'TEST 21d FAILED: quota-rejected call still partially mutated configured targets (% -> %)', v_before_count, v_after_count;
  END IF;

  -- Duplicate pincodes within one request are deduplicated, not an error.
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110001','110001','110002'], 100
  );
  IF v_result->>'result' <> 'success' OR (v_result->>'targetCount')::int <> 2 THEN
    RAISE EXCEPTION 'TEST 21e FAILED: duplicate pincodes in request were not deduplicated, got %', v_result;
  END IF;

  -- Invalid pincode format rejected before any lock/mutation.
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110001','bad'], 100
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_pincode' THEN
    RAISE EXCEPTION 'TEST 21f FAILED: malformed pincode was not rejected, got %', v_result;
  END IF;

  RAISE NOTICE 'TEST 21 PASSED: replace_pincode_product_targets add/reconfigure/unconfigure, ID preservation, empty-list rejection, quota atomicity, dedup, format validation';
END $$;

-- ============================================================
-- TEST 22: an unconfigured target is never claimed, even if (via direct
-- manipulation, proving the explicit is_configured filter is load-bearing,
-- not an accident of status/next_check_at) it looks otherwise claimable.
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id uuid;
  v_claimed_count integer;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110001';

  -- Force an impossible-via-RPC state: configured-looking active/due target
  -- that is ALSO is_configured=false, to prove claim's explicit filter
  -- (not just status/next_check_at) is what excludes it.
  UPDATE public.pincode_tracking_targets
  SET is_configured = false, unconfigured_at = now(), status = 'active', next_check_at = now() - interval '1 minute'
  WHERE id = v_target_id;

  SELECT count(*) INTO v_claimed_count FROM public.claim_due_pincode_targets(
    50, 'test-22-claim', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000001']::uuid[]
  ) WHERE id = v_target_id;

  IF v_claimed_count <> 0 THEN
    RAISE EXCEPTION 'TEST 22 FAILED: an is_configured=false target was claimed';
  END IF;

  -- Restore to a normal, valid state for later tests.
  UPDATE public.pincode_tracking_targets SET status = 'paused', next_check_at = NULL WHERE id = v_target_id;

  RAISE NOTICE 'TEST 22 PASSED: claim_due_pincode_targets never claims an is_configured=false target';
END $$;

-- ============================================================
-- TEST 23: an unconfigured target cannot be manually queued.
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110001';

  UPDATE public.pincode_tracking_targets
  SET is_configured = false, unconfigured_at = now(), status = 'active', next_check_at = now()
  WHERE id = v_target_id;

  v_result := public.queue_pincode_manual_check(v_target_id, '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '00000000-0000-0000-0000-000000000001'::uuid, 60, 10);
  IF v_result->>'result' <> 'invalid_status' OR v_result->>'reason' <> 'target_unconfigured' THEN
    RAISE EXCEPTION 'TEST 23 FAILED: unconfigured target manual-check was not rejected, got %', v_result;
  END IF;

  UPDATE public.pincode_tracking_targets SET status = 'paused', next_check_at = NULL WHERE id = v_target_id;
  RAISE NOTICE 'TEST 23 PASSED: queue_pincode_manual_check rejects an is_configured=false target';
END $$;

-- ============================================================
-- TEST 24: an unconfigured target cannot be resumed -- whole batch
-- rejected even when mixed with an ordinary configured-and-paused target.
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_unconfigured_id uuid;
  v_configured_paused_id uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_unconfigured_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110001';
  SELECT id INTO v_configured_paused_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110002';

  UPDATE public.pincode_tracking_targets SET status = 'paused', next_check_at = NULL WHERE id = v_configured_paused_id;

  v_result := public.set_pincode_tracking_state(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    ARRAY[v_unconfigured_id, v_configured_paused_id], 'resume', 100
  );
  IF v_result->>'result' <> 'invalid_status' OR v_result->>'reason' <> 'target_unconfigured' THEN
    RAISE EXCEPTION 'TEST 24 FAILED: resume batch including an unconfigured target was not rejected, got %', v_result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_configured_paused_id AND status = 'active') THEN
    RAISE EXCEPTION 'TEST 24 FAILED: the configured target was partially resumed despite whole-batch rejection';
  END IF;

  RAISE NOTICE 'TEST 24 PASSED: set_pincode_tracking_state resume rejects the whole batch when any target is unconfigured, no partial resume';
END $$;

-- ============================================================
-- TEST 25/26: in-flight unconfiguration does not interrupt a checking
-- target; finalize then parks it paused/unscheduled; target and history
-- IDs are preserved throughout (never deleted, never recreated).
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id uuid;
  v_claim_token uuid;
  v_result jsonb;
  v_history_count_before integer;
  v_history_count_after integer;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110002';

  UPDATE public.pincode_tracking_targets SET status = 'active', next_check_at = now() - interval '1 minute', is_configured = true, unconfigured_at = NULL WHERE id = v_target_id;
  SELECT count(*) INTO v_history_count_before FROM public.pincode_availability_results WHERE tracking_target_id = v_target_id;

  -- Claim it (simulates the scheduler picking it up).
  SELECT claim_token INTO v_claim_token FROM public.claim_due_pincode_targets(
    50, 'test-25-claim', '{}'::uuid[], ARRAY['10000000-0000-0000-0000-000000000001']::uuid[]
  ) WHERE id = v_target_id;
  IF v_claim_token IS NULL THEN RAISE EXCEPTION 'TEST 25 SETUP FAILED: target was not claimed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_target_id AND status = 'checking') THEN
    RAISE EXCEPTION 'TEST 25 SETUP FAILED: target is not checking after claim';
  END IF;

  -- Edit Pincodes now omits 110002 while it is mid-flight -- must NOT
  -- interrupt the checking target (requirement 11).
  v_result := public.replace_pincode_product_targets(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', v_product_id,
    ARRAY['110001'], 100
  );
  IF v_result->>'result' <> 'success' THEN RAISE EXCEPTION 'TEST 25 FAILED: mid-flight replace call itself failed: %', v_result; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_target_id AND status = 'checking' AND is_configured = false AND unconfigured_at IS NOT NULL AND claim_token = v_claim_token) THEN
    RAISE EXCEPTION 'TEST 25 FAILED: in-flight target was interrupted (status/claim changed) by unconfiguration -- must stay checking with its claim intact';
  END IF;

  -- Finalize the still-valid claim -- result is still honestly recorded.
  PERFORM public.finalize_pincode_check(v_claim_token, 'success', 'available', 'Same-day', NULL, NULL);

  IF NOT EXISTS (SELECT 1 FROM public.pincode_tracking_targets WHERE id = v_target_id AND status = 'paused' AND next_check_at IS NULL AND is_configured = false) THEN
    RAISE EXCEPTION 'TEST 25 FAILED: unconfigured target was not parked paused/unscheduled after finalize';
  END IF;

  SELECT count(*) INTO v_history_count_after FROM public.pincode_availability_results WHERE tracking_target_id = v_target_id;
  IF v_history_count_after <> v_history_count_before + 1 THEN
    RAISE EXCEPTION 'TEST 26 FAILED: finalize result for an unconfigured target was not recorded (history count % -> %)', v_history_count_before, v_history_count_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pincode_availability_results WHERE tracking_target_id = v_target_id AND check_status = 'success' ORDER BY checked_at DESC LIMIT 1) THEN
    RAISE EXCEPTION 'TEST 26 FAILED: the recorded result does not reference the SAME preserved target ID';
  END IF;

  RAISE NOTICE 'TEST 25 PASSED: in-flight unconfiguration never interrupts a checking target; finalize honestly records the result then parks it paused/unscheduled';
  RAISE NOTICE 'TEST 26 PASSED: target ID and result history are preserved across unconfigure/finalize, never deleted or recreated';
END $$;

-- ============================================================
-- TEST 27: replace_workspace_default_pincodes -- atomic, no partial write
-- on validation failure, empty list allowed (unlike product pincode edit).
-- ============================================================
DO $$
DECLARE
  v_result jsonb;
  v_before_count integer;
  v_after_count integer;
BEGIN
  v_result := public.replace_workspace_default_pincodes(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(
      jsonb_build_object('pincode','500001','displayOrder',0),
      jsonb_build_object('pincode','500002','displayOrder',1)
    )
  );
  IF v_result->>'result' <> 'success' OR jsonb_array_length(v_result->'defaults') <> 2 THEN
    RAISE EXCEPTION 'TEST 27a FAILED: initial default replacement failed: %', v_result;
  END IF;

  SELECT count(*) INTO v_before_count FROM public.workspace_default_pincodes
    WHERE workspace_id = '10000000-0000-0000-0000-000000000001' AND marketplace_id = 'A21TJRUUN4KGV' AND is_active = true;

  -- One invalid pincode among otherwise-valid ones: whole call rejected,
  -- active set must be UNCHANGED (proves atomicity, not just "the RPC
  -- validates first" -- this actually re-reads the table after the call).
  v_result := public.replace_workspace_default_pincodes(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(
      jsonb_build_object('pincode','500003','displayOrder',0),
      jsonb_build_object('pincode','bad','displayOrder',1)
    )
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'invalid_pincode' THEN
    RAISE EXCEPTION 'TEST 27b FAILED: invalid pincode in list was not rejected: %', v_result;
  END IF;
  SELECT count(*) INTO v_after_count FROM public.workspace_default_pincodes
    WHERE workspace_id = '10000000-0000-0000-0000-000000000001' AND marketplace_id = 'A21TJRUUN4KGV' AND is_active = true;
  IF v_before_count <> v_after_count THEN
    RAISE EXCEPTION 'TEST 27b FAILED: rejected replacement call still partially mutated the active default set (% -> %)', v_before_count, v_after_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_default_pincodes WHERE workspace_id = '10000000-0000-0000-0000-000000000001' AND marketplace_id = 'A21TJRUUN4KGV' AND pincode = '500003') THEN
    RAISE EXCEPTION 'TEST 27b FAILED: the valid pincode from the rejected batch was written anyway (no rollback)';
  END IF;

  -- Duplicate pincode within the request is rejected, no mutation.
  v_result := public.replace_workspace_default_pincodes(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV',
    jsonb_build_array(
      jsonb_build_object('pincode','500001','displayOrder',0),
      jsonb_build_object('pincode','500001','displayOrder',1)
    )
  );
  IF v_result->>'result' <> 'invalid_parameters' OR v_result->>'reason' <> 'duplicate_pincode' THEN
    RAISE EXCEPTION 'TEST 27c FAILED: duplicate pincode in request was not rejected: %', v_result;
  END IF;

  -- Empty list IS allowed for defaults (unlike product pincode edit) --
  -- deactivates everything, atomically, no hard delete.
  v_result := public.replace_workspace_default_pincodes(
    '10000000-0000-0000-0000-000000000001'::uuid, 'A21TJRUUN4KGV', '[]'::jsonb
  );
  IF v_result->>'result' <> 'success' OR jsonb_array_length(v_result->'defaults') <> 0 THEN
    RAISE EXCEPTION 'TEST 27d FAILED: empty default list was not accepted: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_default_pincodes WHERE workspace_id = '10000000-0000-0000-0000-000000000001' AND marketplace_id = 'A21TJRUUN4KGV' AND pincode = '500001' AND is_active = false) THEN
    RAISE EXCEPTION 'TEST 27d FAILED: previously-active default was not soft-deactivated (row must still exist, is_active=false)';
  END IF;

  RAISE NOTICE 'TEST 27 PASSED: replace_workspace_default_pincodes is atomic, rejects invalid/duplicate lists with zero partial mutation, allows an empty list (soft-deactivate only, never a hard delete)';
END $$;

-- ============================================================
-- TEST 28: get_pincode_target_results -- bounded latest-attempt and
-- last-confirmed-availability selection, distinct from each other; a
-- failed/blocked latest attempt does not hide an older confirmed result;
-- correctness holds at volume (>1000 history rows for one target, well
-- beyond PostgREST's default response row cap).
-- ============================================================
DO $$
DECLARE
  v_product_id uuid;
  v_target_id uuid;
  v_row record;
BEGIN
  SELECT id INTO v_product_id FROM public.pincode_monitored_products WHERE asin = 'B000000EDT';
  SELECT id INTO v_target_id FROM public.pincode_tracking_targets WHERE monitored_product_id = v_product_id AND pincode = '110001';

  -- 1,200 older synthetic history rows -- volume beyond PostgREST's default
  -- row cap, all older than the two rows that actually decide this test's
  -- assertions below.
  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status, checked_at
  )
  SELECT '10000000-0000-0000-0000-000000000001'::uuid, 'B000000EDT', '110001', v_product_id, v_target_id,
         gen_random_uuid(), 'success', 'unknown', now() - interval '1000 hours' + (gs || ' minutes')::interval
  FROM generate_series(1, 1200) gs;

  -- The older CONFIRMED result (available).
  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status, delivery_message, checked_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000001'::uuid, 'B000000EDT', '110001', v_product_id, v_target_id,
    gen_random_uuid(), 'success', 'available', 'Same-day delivery', now() - interval '2 hours'
  );

  -- The newest attempt: FAILED -- must not overwrite/hide the confirmed result above.
  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status, error_code, checked_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000001'::uuid, 'B000000EDT', '110001', v_product_id, v_target_id,
    gen_random_uuid(), 'failed', NULL, 'timeout', now() - interval '5 minutes'
  );

  SELECT * INTO v_row FROM public.get_pincode_target_results(
    '10000000-0000-0000-0000-000000000001'::uuid, ARRAY[v_target_id]
  );

  IF v_row.tracking_target_id IS NULL THEN
    RAISE EXCEPTION 'TEST 28 FAILED: get_pincode_target_results returned no row for the target';
  END IF;
  IF v_row.latest_check_status <> 'failed' OR v_row.latest_availability_status IS NOT NULL OR v_row.latest_error_code <> 'timeout' THEN
    RAISE EXCEPTION 'TEST 28 FAILED: latest attempt was not the most recent (failed) row -- got status=% availability=% error=%',
      v_row.latest_check_status, v_row.latest_availability_status, v_row.latest_error_code;
  END IF;
  IF v_row.confirmed_availability_status <> 'available' OR v_row.confirmed_delivery_message <> 'Same-day delivery' THEN
    RAISE EXCEPTION 'TEST 28 FAILED: last confirmed availability was not the older available result -- got status=% message=%',
      v_row.confirmed_availability_status, v_row.confirmed_delivery_message;
  END IF;
  IF v_row.confirmed_checked_at >= v_row.latest_checked_at THEN
    RAISE EXCEPTION 'TEST 28 FAILED: confirmed_checked_at (%) should be strictly older than latest_checked_at (%) in this scenario',
      v_row.confirmed_checked_at, v_row.latest_checked_at;
  END IF;

  -- A bounds-rejecting call (too many target IDs) returns nothing, never an error.
  IF EXISTS (
    SELECT 1 FROM public.get_pincode_target_results(
      '10000000-0000-0000-0000-000000000001'::uuid,
      (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 501))
    )
  ) THEN
    RAISE EXCEPTION 'TEST 28 FAILED: an over-limit target_ids array should return zero rows, not process a truncated/arbitrary subset';
  END IF;

  RAISE NOTICE 'TEST 28 PASSED: get_pincode_target_results returns latestAttempt and lastConfirmedAvailability as distinct, correct facts, including a failed latest attempt over an older confirmed result, correct at >1000-row volume';
END $$;

SELECT 'ALL SEQUENTIAL TESTS COMPLETED WITHOUT ERROR' AS summary;
