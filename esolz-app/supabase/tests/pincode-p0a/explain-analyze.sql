-- Pincode Checker P0-A -- EXPLAIN ANALYZE representative-volume check.
--
-- Seeds ~500 workspaces x 1 product x 10 targets (5,000 due targets),
-- diluted against a ~50,000-row total table (10% due) to match a
-- realistic 24h-cadence/hourly-cron workload, then asserts -- via the
-- EXPLAIN JSON plan itself, not eyeballed text -- that the claim RPC's
-- candidate-ranking query uses the due-index (Bitmap Index Scan or Index
-- Scan on pincode_tracking_targets_due_idx), not a sequential scan.
--
-- Run ONLY against a scratch/local database -- see run-tests.sh.
\set ON_ERROR_STOP on

BEGIN;
INSERT INTO auth.users (id, email)
SELECT gen_random_uuid(), 'bench' || g || '@test.com' FROM generate_series(1,500) g;

INSERT INTO public.profiles (id, email)
SELECT id, email FROM auth.users WHERE email LIKE 'bench%@test.com'
ON CONFLICT DO NOTHING;

WITH numbered AS (
  SELECT id, row_number() OVER () AS rn FROM public.profiles WHERE email LIKE 'bench%@test.com'
)
INSERT INTO public.workspaces (id, owner_id, name)
SELECT gen_random_uuid(), id, 'bench-ws-' || rn FROM numbered;

INSERT INTO public.pincode_monitored_products (id, workspace_id, marketplace_id, asin, product_source, status)
SELECT gen_random_uuid(), w.id, 'A21TJRUUN4KGV', 'B' || lpad((row_number() OVER ())::text, 9, '0'), 'other', 'active'
FROM public.workspaces w WHERE w.name LIKE 'bench-ws-%';

-- 5,000 DUE targets (next_check_at in the past).
INSERT INTO public.pincode_tracking_targets (id, workspace_id, monitored_product_id, pincode, status, next_check_at)
SELECT gen_random_uuid(), p.workspace_id, p.id,
       lpad((100000 + gs)::text, 6, '9'),
       'active', now() - (random() * interval '2 hours')
FROM public.pincode_monitored_products p
JOIN public.workspaces w ON w.id = p.workspace_id AND w.name LIKE 'bench-ws-%'
CROSS JOIN generate_series(1,10) gs;

-- 45,000 NOT-due targets (next_check_at in the future) -- dilutes the
-- table so the due-index is actually selective, matching production
-- shape rather than a synthetic 100%-due table where a seq scan would be
-- the (correctly) cheaper plan regardless of index quality.
INSERT INTO public.pincode_tracking_targets (id, workspace_id, monitored_product_id, pincode, status, next_check_at)
SELECT gen_random_uuid(), p.workspace_id, p.id,
       lpad((200000 + gs)::text, 6, '9'),
       'active', now() + interval '1 hour' + (random() * interval '23 hours')
FROM public.pincode_monitored_products p
JOIN public.workspaces w ON w.id = p.workspace_id AND w.name LIKE 'bench-ws-%'
CROSS JOIN generate_series(1,90) gs;
COMMIT;

ANALYZE public.pincode_tracking_targets;
ANALYZE public.pincode_monitored_products;

DO $$
DECLARE
  v_allowed uuid[];
  v_plan json;
  v_plan_text text;
  v_due_count integer;
BEGIN
  SELECT array_agg(id) INTO v_allowed FROM public.workspaces WHERE name LIKE 'bench-ws-%';

  SELECT count(*) INTO v_due_count
  FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  JOIN public.workspaces w ON w.id = p.workspace_id AND w.name LIKE 'bench-ws-%'
  WHERE t.status='active' AND t.next_check_at <= now();

  IF v_due_count < 4000 THEN
    RAISE EXCEPTION 'EXPLAIN-ANALYZE SETUP FAILED: expected ~5000 due targets, found %', v_due_count;
  END IF;

  -- Same shape as claim_due_pincode_targets' own candidates CTE
  -- (IMPLEMENTATION_PLAN.md sec2.8) -- this is what's actually being
  -- benchmarked, not an approximation of it.
  EXECUTE format(
    $q$EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT t.id, t.workspace_id, t.monitored_product_id,
              (t.manual_requested_at IS NOT NULL) AS has_manual_request,
              t.next_check_at,
              ROW_NUMBER() OVER (
                PARTITION BY t.workspace_id
                ORDER BY (t.manual_requested_at IS NOT NULL) DESC, t.next_check_at ASC
              ) AS rn
       FROM public.pincode_tracking_targets t
       JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
       WHERE t.status = 'active'
         AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
         AND p.status = 'active'
         AND p.workspace_id = ANY (%L)
         AND NOT (t.workspace_id = ANY ('{}'::uuid[]))$q$,
    v_allowed
  ) INTO v_plan;

  v_plan_text := v_plan::text;

  -- Structural checks via jsonpath, not naive substring search -- the plan
  -- also contains an (expected, harmless) Seq Scan on the UNRELATED
  -- pincode_monitored_products table (the small, 500-row allowlist-filter
  -- side of the join), so a plain "does the text contain both strings
  -- anywhere" check would false-positive on that.
  --
  -- Note: "Relation Name" and "Index Name" are NOT always on the same
  -- plan node -- a Bitmap Index Scan (child) carries "Index Name" while
  -- its parent Bitmap Heap Scan carries "Relation Name"; only a plain
  -- Index Scan node carries both together. So the two assertions below
  -- are deliberately independent: (1) the specific due-index name appears
  -- SOMEWHERE in the plan at all, (2) no node ANYWHERE is a Seq Scan
  -- specifically on pincode_tracking_targets (Node Type + Relation Name
  -- co-occurring on the same node is exactly what identifies that).
  IF NOT jsonb_path_exists(v_plan::jsonb,
       '$.** ? (@."Index Name" == "pincode_tracking_targets_due_idx")'
     ) THEN
    RAISE EXCEPTION 'EXPLAIN-ANALYZE FAILED: pincode_tracking_targets_due_idx does not appear anywhere in the plan -- plan: %', v_plan_text;
  END IF;

  IF jsonb_path_exists(v_plan::jsonb,
       '$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "pincode_tracking_targets")'
     ) THEN
    RAISE EXCEPTION 'EXPLAIN-ANALYZE FAILED: planner chose a sequential scan on pincode_tracking_targets instead of the due-index at 10%% selectivity -- plan: %', v_plan_text;
  END IF;

  RAISE NOTICE 'EXPLAIN-ANALYZE PASSED: due-index (pincode_tracking_targets_due_idx) used, no sequential scan, % due targets across % workspaces', v_due_count, array_length(v_allowed, 1);
END $$;

SELECT 'EXPLAIN-ANALYZE CHECK COMPLETED WITHOUT ERROR' AS summary;
