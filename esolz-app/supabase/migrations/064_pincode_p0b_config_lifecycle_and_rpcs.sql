-- Pincode Checker P0-B correctness amendment (PR #55 review round).
--
-- Five gaps found in review, all closed here:
--
-- 1. Other Product enrollment could bypass the required SP-API-confirmed
--    lookup (closed in the TypeScript route layer, not this migration --
--    see esolz-app/src/lib/pincode-monitoring/other-product-confirmation.ts
--    -- referenced here only for context).
-- 2. "Edit Pincodes" (PATCH .../products/[id]/pincodes, in the locked route
--    map) was never implemented. The existing pincode_tracking_targets
--    status enum (active/paused/failed/checking) has no way to represent
--    "this pincode is no longer part of the product's configured list" --
--    conflating that with 'paused' would be a lie (DATA_MODEL.md's own
--    "never let two different facts share one status value" discipline,
--    already applied once to keep parent lifecycle and derived UI state
--    separate, sec2 Correction 13). New, orthogonal configuration-lifecycle
--    columns below; the existing status enum is UNCHANGED.
-- 3. workspace_default_pincodes replacement was two separate PostgREST
--    requests (upsert, then deactivate) -- not atomic. New RPC below makes
--    it one transaction.
-- 4. The tracker read fetched every historical result row for a page's
--    targets and deduplicated in TypeScript -- unbounded, and silently
--    wrong beyond PostgREST's default row cap. New bounded, indexed,
--    per-target read RPC below returns exactly two rows' worth of data per
--    target (latest attempt, last confirmed availability), computed in the
--    database.
-- 5. claim/manual-check/resume needed to respect the new configuration
--    lifecycle -- amended in place below (none of migrations 060-063 have
--    been applied anywhere yet, so editing in place is safe, same
--    discipline as every prior PR #54 review-round correction).

-- ============================================================
-- 1. Target configuration lifecycle (Correction 2)
-- ============================================================
-- Orthogonal to the OPERATIONAL status enum (active/paused/failed/checking,
-- DATA_MODEL.md sec3) -- is_configured answers "is this pincode still part
-- of what the seller asked to track," never "is a check currently running
-- or paused." A target can be simultaneously status='paused' AND
-- is_configured=true (the seller clicked Pause, still wants this pincode
-- tracked later) or status='paused' AND is_configured=false (the seller
-- removed this pincode from the product's list via Edit Pincodes). Adding
-- 'removed'/'unconfigured' to the status enum would conflate these two
-- independent facts into one column -- exactly the anti-pattern DATA_
-- MODEL.md sec2 Correction 13 already rejected once for the parent table.
ALTER TABLE public.pincode_tracking_targets
  ADD COLUMN is_configured  boolean     NOT NULL DEFAULT true,
  ADD COLUMN unconfigured_at timestamptz NULL;

ALTER TABLE public.pincode_tracking_targets
  ADD CONSTRAINT pincode_tracking_targets_configured_consistency_chk
  CHECK (
    (is_configured = true  AND unconfigured_at IS NULL)
    OR
    (is_configured = false AND unconfigured_at IS NOT NULL)
  );

-- The existing due-index (status='active' AND next_check_at IS NOT NULL)
-- already structurally excludes every non-checking unconfigured target,
-- since replace_pincode_product_targets below always pairs
-- is_configured=false with status='paused'/next_check_at=NULL for anything
-- not currently checking (requirement 10). This partial index adds a
-- second, defense-in-depth condition directly on is_configured for the one
-- remaining window that matters: a target that was mid-flight (status=
-- 'checking') when it was unconfigured stays 'checking' (never
-- interrupted, requirement 11) until finalize_pincode_check parks it --
-- during that window it is NOT due (checking targets never match the due
-- index's status='active' predicate either), so no query-plan-relevant gap
-- actually exists; this index exists purely so claim_due_pincode_targets'
-- own explicit `is_configured = true` predicate (added below) has a
-- matching index rather than relying on the planner to intersect two
-- partial conditions.
CREATE INDEX pincode_tracking_targets_configured_due_idx
  ON public.pincode_tracking_targets (next_check_at, workspace_id)
  WHERE status = 'active' AND next_check_at IS NOT NULL AND is_configured = true;

-- ============================================================
-- 2. claim_due_pincode_targets -- exclude is_configured=false (Correction 2)
-- ============================================================
-- Edited in place (not a new migration): identical to the version in 063
-- except the candidates CTE's WHERE clause gains one predicate,
-- `t.is_configured = true`. Structurally redundant with the status='active'
-- filter already there (see the index comment above for why), added anyway
-- as explicit, defense-in-depth documentation that this RPC is
-- configuration-lifecycle-aware, not an accident of status timing.
CREATE OR REPLACE FUNCTION public.claim_due_pincode_targets(
  p_limit                  integer,
  p_invocation_id          text,
  p_excluded_workspace_ids uuid[] DEFAULT '{}',
  p_allowed_workspace_ids  uuid[] DEFAULT NULL
)
RETURNS SETOF public.pincode_tracking_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_allowed_workspace_ids IS NULL OR array_length(p_allowed_workspace_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 50 THEN
    RETURN;
  END IF;
  IF p_invocation_id IS NULL OR length(p_invocation_id) = 0 OR length(p_invocation_id) > 200 THEN
    RETURN;
  END IF;
  IF array_length(p_excluded_workspace_ids, 1) > 10000 OR array_length(p_allowed_workspace_ids, 1) > 10000 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
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
      AND t.is_configured = true  -- Correction 2 (PR #55 review round): never claim a target the seller removed from the product's pincode list
      AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
      AND p.status = 'active'
      AND p.workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (t.workspace_id = ANY (p_excluded_workspace_ids))
  ),
  ranked_ids AS (
    SELECT id, monitored_product_id FROM candidates
    WHERE rn = 1
    ORDER BY has_manual_request DESC, next_check_at ASC, workspace_id, id
    LIMIT p_limit
  ),
  locked_parents AS (
    SELECT p.id, p.status, p.workspace_id
    FROM public.pincode_monitored_products p
    WHERE p.id IN (SELECT DISTINCT monitored_product_id FROM ranked_ids)
    ORDER BY p.id
    FOR UPDATE
  ),
  eligible_parents AS (
    SELECT id FROM locked_parents
    WHERE status = 'active'
      AND workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (workspace_id = ANY (p_excluded_workspace_ids))
  ),
  locked_targets AS (
    SELECT t.id FROM public.pincode_tracking_targets t
    WHERE t.id IN (
      SELECT r.id FROM ranked_ids r
      JOIN eligible_parents ep ON ep.id = r.monitored_product_id
    )
      AND t.status = 'active'
      AND t.is_configured = true  -- Correction 2: re-checked at revalidation time too, same as every other predicate here
      AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
      AND t.monitored_product_id IN (SELECT id FROM eligible_parents)
    ORDER BY t.id
    FOR UPDATE OF t SKIP LOCKED
  )
  UPDATE public.pincode_tracking_targets t
  SET status = 'checking',
      claimed_at = now(),
      claimed_by = p_invocation_id,
      claim_token = gen_random_uuid()
  FROM locked_targets
  WHERE t.id = locked_targets.id
  RETURNING t.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) TO service_role;

-- ============================================================
-- 3. queue_pincode_manual_check -- reject is_configured=false (Correction 2)
-- ============================================================
-- Edited in place: identical to 063's version except one new status check,
-- ordered right after the existing 'checking'/'paused'/'failed' branch
-- (same status-test-matrix discipline the original already used) -- a
-- target that's been removed from the product's pincode list cannot be
-- manually checked, distinguishable from "paused, needs a resume."
CREATE OR REPLACE FUNCTION public.queue_pincode_manual_check(
  p_target_id uuid,
  p_workspace_id uuid,
  p_marketplace_id text,
  p_user_id uuid,
  p_cooldown_seconds integer,
  p_manual_pending_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lookup_product_id uuid;
  v_target  public.pincode_tracking_targets;
  v_product public.pincode_monitored_products;
  v_outstanding integer;
  MAX_MANUAL_PENDING_LIMIT CONSTANT integer := 10000;
  MAX_MARKETPLACE_LEN      CONSTANT integer := 40;
BEGIN
  IF p_target_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'missing_target_id');
  END IF;
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_cooldown_seconds IS NULL OR p_cooldown_seconds < 0 OR p_cooldown_seconds > 3600 THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'invalid_cooldown_seconds');
  END IF;
  IF p_manual_pending_limit IS NULL OR p_manual_pending_limit <= 0 OR p_manual_pending_limit > MAX_MANUAL_PENDING_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'invalid_manual_pending_limit');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE id = p_target_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  SELECT p.* INTO v_product FROM public.pincode_monitored_products p
    WHERE p.id = v_lookup_product_id
    FOR UPDATE;

  IF v_product.workspace_id <> p_workspace_id OR v_product.marketplace_id <> p_marketplace_id THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'workspace_marketplace_mismatch');
  END IF;

  SELECT t.* INTO v_target FROM public.pincode_tracking_targets t
    WHERE t.id = p_target_id
      AND t.workspace_id = p_workspace_id
      AND t.monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  IF v_product.status IN ('archived', 'removed') THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'product_archived_or_removed');
  END IF;

  -- Correction 2 (PR #55 review round): checked alongside the existing
  -- status-test matrix, before the manual_requested_at/cooldown checks --
  -- an unconfigured target cannot be manually checked regardless of its
  -- current operational status.
  IF NOT v_target.is_configured THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'target_unconfigured');
  END IF;

  IF v_target.status = 'checking' THEN
    RETURN jsonb_build_object('result', 'checking');
  ELSIF v_target.status = 'paused' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'paused_requires_resume');
  ELSIF v_target.status = 'failed' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'failed_requires_resume');
  END IF;

  IF v_target.manual_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_queued', 'manual_request_token', v_target.manual_request_token);
  END IF;

  IF v_target.last_checked_at IS NOT NULL
     AND v_target.last_checked_at > now() - make_interval(secs => p_cooldown_seconds) THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_seconds', p_cooldown_seconds - extract(epoch FROM now() - v_target.last_checked_at)::int);
  END IF;

  SELECT count(*) INTO v_outstanding
  FROM public.pincode_tracking_targets t2
  JOIN public.pincode_monitored_products p2 ON p2.id = t2.monitored_product_id
  WHERE p2.workspace_id = p_workspace_id
    AND p2.marketplace_id = p_marketplace_id
    AND t2.manual_requested_at IS NOT NULL;

  IF v_outstanding >= p_manual_pending_limit THEN
    RETURN jsonb_build_object('result', 'quota_exceeded',
      'currentOutstanding', v_outstanding, 'limit', p_manual_pending_limit);
  END IF;

  UPDATE public.pincode_tracking_targets
  SET manual_requested_at = now(),
      manual_requested_by = p_user_id,
      manual_request_token = gen_random_uuid(),
      next_check_at = now()
  WHERE id = p_target_id AND workspace_id = p_workspace_id AND status = 'active'
  RETURNING manual_request_token INTO STRICT v_target.manual_request_token;

  RETURN jsonb_build_object('result', 'queued', 'manual_request_token', v_target.manual_request_token);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, text, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_pincode_manual_check(uuid, uuid, text, uuid, integer, integer) TO service_role;

-- ============================================================
-- 4. set_pincode_tracking_state -- resume rejects is_configured=false (Correction 2)
-- ============================================================
-- Edited in place: identical to 063's version except one new EXISTS check
-- in the resume branch, checked alongside the existing archived/removed-
-- parent check (same "reject the whole batch, name the reason" shape).
-- Pause is UNCHANGED -- pausing an unconfigured (already-paused) target is
-- already a harmless no-op under the existing `status = 'active'` guard on
-- the pause UPDATE, requires no new check.
CREATE OR REPLACE FUNCTION public.set_pincode_tracking_state(
  p_workspace_id   uuid,
  p_marketplace_id text,
  p_target_ids     uuid[],
  p_action         text,
  p_quota_limit    integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_ids           uuid[];
  v_requested_count       integer;
  v_valid_count           integer;
  v_checking_ids          uuid[];
  v_current_active        integer;
  v_projected_additional  integer;
  MAX_QUOTA_LIMIT      CONSTANT integer := 100000;
  MAX_MARKETPLACE_LEN  CONSTANT integer := 40;
  MAX_TARGET_IDS       CONSTANT integer := 500;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_target_ids IS NULL OR array_length(p_target_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'empty_target_ids');
  END IF;
  IF array_length(p_target_ids, 1) > MAX_TARGET_IDS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_target_ids');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_target_ids) AS x WHERE x IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'null_id_in_array');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('pause', 'resume') THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_action');
  END IF;
  IF p_quota_limit IS NULL OR p_quota_limit <= 0 OR p_quota_limit > MAX_QUOTA_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_quota_limit');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_target_ids FROM unnest(p_target_ids) AS x;
  v_requested_count := array_length(v_target_ids, 1);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  PERFORM 1 FROM public.pincode_monitored_products p
  WHERE p.id IN (SELECT DISTINCT t.monitored_product_id FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids))
  ORDER BY p.id
  FOR UPDATE;

  PERFORM 1 FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids) ORDER BY t.id FOR UPDATE;

  SELECT count(*) INTO v_valid_count
  FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  WHERE t.id = ANY (v_target_ids)
    AND t.workspace_id = p_workspace_id
    AND p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id;

  IF v_valid_count <> v_requested_count THEN
    RETURN jsonb_build_object(
      'result', 'not_found_or_scope_mismatch',
      'requestedCount', v_requested_count,
      'validCount', v_valid_count
    );
  END IF;

  IF p_action = 'resume' THEN
    IF EXISTS (
      SELECT 1 FROM public.pincode_monitored_products p
      WHERE p.id IN (SELECT DISTINCT t.monitored_product_id FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids))
        AND p.status IN ('archived', 'removed')
    ) THEN
      RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'parent_archived_or_removed');
    END IF;

    -- Correction 2 (PR #55 review round): a target removed from its
    -- product's configured pincode list cannot be resumed -- Edit Pincodes
    -- (reconfiguring it) is the only way back, not Resume.
    IF EXISTS (
      SELECT 1 FROM public.pincode_tracking_targets t
      WHERE t.id = ANY (v_target_ids) AND t.is_configured = false
    ) THEN
      RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'target_unconfigured');
    END IF;

    SELECT count(*) INTO v_current_active
    FROM public.pincode_tracking_targets t
    JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
    WHERE p.workspace_id = p_workspace_id AND p.marketplace_id = p_marketplace_id
      AND t.status IN ('active', 'checking');

    SELECT count(*) INTO v_projected_additional
    FROM public.pincode_tracking_targets t
    WHERE t.id = ANY (v_target_ids) AND t.status IN ('paused', 'failed');

    IF v_current_active + v_projected_additional > p_quota_limit THEN
      RETURN jsonb_build_object(
        'result', 'quota_exceeded',
        'currentActiveTargets', v_current_active,
        'requestedAdditionalTargets', v_projected_additional,
        'limit', p_quota_limit
      );
    END IF;

    UPDATE public.pincode_tracking_targets t
    SET status = 'active',
        next_check_at = now(),
        consecutive_failures = CASE WHEN t.status = 'failed' THEN 0 ELSE t.consecutive_failures END
    WHERE t.id = ANY (v_target_ids) AND t.status IN ('paused', 'failed');

    RETURN jsonb_build_object('result', 'success', 'action', 'resume', 'targetCount', v_valid_count);
  END IF;

  SELECT array_agg(t.id) INTO v_checking_ids
  FROM public.pincode_tracking_targets t
  WHERE t.id = ANY (v_target_ids) AND t.status = 'checking';

  IF v_checking_ids IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'check_in_progress', 'targetIds', to_jsonb(v_checking_ids));
  END IF;

  UPDATE public.pincode_tracking_targets t
  SET status = 'paused',
      next_check_at = NULL,
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL
  WHERE t.id = ANY (v_target_ids) AND t.status = 'active';

  RETURN jsonb_build_object('result', 'success', 'action', 'pause', 'targetCount', v_valid_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_pincode_tracking_state(uuid, text, uuid[], text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_pincode_tracking_state(uuid, text, uuid[], text, integer) TO service_role;

-- ============================================================
-- 5. finalize_pincode_check -- park an unconfigured target (Correction 2)
-- ============================================================
-- Edited in place: identical to 063's version except step 5 gains one new
-- branch, checked immediately after the existing archived/removed-parent
-- branch (same "this target left the running set while in flight, park
-- it, don't reschedule" shape) -- requirement 11's "let it finalize; then
-- parks it paused with no next check."
CREATE OR REPLACE FUNCTION public.finalize_pincode_check(
  p_claim_token        uuid,
  p_check_status       text,
  p_availability_status text,
  p_delivery_message    text,
  p_error_code          text,
  p_error_message       text
)
RETURNS public.pincode_availability_results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing        public.pincode_availability_results;
  v_lookup_product_id uuid;
  v_target          public.pincode_tracking_targets;
  v_product         public.pincode_monitored_products;
  v_result          public.pincode_availability_results;
  v_next_status     text;
  v_next_check_at   timestamptz;
  v_consecutive     integer;
  v_max_failures    CONSTANT integer := 5;
BEGIN
  IF p_check_status IS NULL OR p_check_status NOT IN ('success', 'failed', 'blocked') THEN
    RAISE EXCEPTION 'invalid_check_status' USING ERRCODE = 'P0002';
  END IF;
  IF p_check_status = 'success' AND (
       p_availability_status IS NULL
       OR p_availability_status NOT IN ('available', 'unavailable', 'unknown')
     ) THEN
    RAISE EXCEPTION 'invalid_availability_for_success' USING ERRCODE = 'P0002';
  END IF;
  IF p_check_status IN ('failed', 'blocked') AND p_availability_status IS NOT NULL THEN
    RAISE EXCEPTION 'availability_must_be_null_for_non_success' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM public.pincode_availability_results
    WHERE check_attempt_id = p_claim_token;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking';

  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_product FROM public.pincode_monitored_products
    WHERE id = v_lookup_product_id
    FOR UPDATE;

  SELECT * INTO v_target FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking'
      AND monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.pincode_availability_results (
    workspace_id, asin, pincode, monitored_product_id, tracking_target_id,
    check_attempt_id, check_status, availability_status,
    delivery_message, error_code, error_message, checked_at
  ) VALUES (
    v_target.workspace_id, v_product.asin, v_target.pincode,
    v_target.monitored_product_id, v_target.id,
    p_claim_token, p_check_status, p_availability_status,
    p_delivery_message, p_error_code, p_error_message, now()
  ) RETURNING * INTO v_result;

  IF v_product.status IN ('archived', 'removed') THEN
    v_next_status := 'paused';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures;
  ELSIF NOT v_target.is_configured THEN
    -- Correction 2 (PR #55 review round): this pincode was removed from
    -- the product's configured list while the check was in flight
    -- (replace_pincode_product_targets left status='checking' untouched,
    -- requirement 11) -- the result is still recorded honestly above, but
    -- the target parks paused/unscheduled, same as the archived/removed
    -- case, never rescheduled for a pincode the seller no longer wants
    -- tracked.
    v_next_status := 'paused';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures;
  ELSIF p_check_status = 'blocked' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours * 2 || ' hours')::interval;
    v_consecutive := v_target.consecutive_failures;
  ELSIF p_check_status = 'failed' AND v_target.consecutive_failures + 1 >= v_max_failures THEN
    v_next_status := 'failed';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures + 1;
  ELSIF p_check_status = 'failed' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;
    v_consecutive := v_target.consecutive_failures + 1;
  ELSE
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;
    v_consecutive := 0;
  END IF;

  UPDATE public.pincode_tracking_targets
  SET status = v_next_status,
      last_checked_at = now(),
      next_check_at = v_next_check_at,
      consecutive_failures = v_consecutive,
      last_error_code = p_error_code,
      claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL
  WHERE id = v_target.id AND claim_token = p_claim_token AND status = 'checking';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_target_update_affected_zero_rows_unexpectedly' USING ERRCODE = 'XX000';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) TO service_role;

-- ============================================================
-- 6. replace_pincode_product_targets (Correction 2's new RPC)
-- ============================================================
-- The "Edit Pincodes" RPC (PATCH .../products/[id]/pincodes). Atomic,
-- whole-list replacement for one product's configured pincodes -- follows
-- the same global lock order (advisory lock -> parent -> targets,
-- IMPLEMENTATION_PLAN.md sec2.0) and complete-batch-validation discipline
-- every other mutating RPC in this feature already uses.
CREATE OR REPLACE FUNCTION public.replace_pincode_product_targets(
  p_workspace_id          uuid,
  p_marketplace_id        text,
  p_monitored_product_id  uuid,
  p_pincodes              text[],
  p_quota_limit           integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pincodes         text[];
  v_pincode          text;
  v_product          public.pincode_monitored_products;
  v_current_active    integer;
  v_net_new_active    integer;
  v_added_count       integer;
  v_reconfigured_count integer;
  v_unconfigured_count integer;
  MAX_QUOTA_LIMIT      CONSTANT integer := 100000;
  MAX_MARKETPLACE_LEN  CONSTANT integer := 40;
  MAX_PINCODES         CONSTANT integer := 100; -- matches enroll_pincode_monitored_products' own MAX_PINCODES_PER_PRODUCT
BEGIN
  -- Requirement 1: validate bounded, deduplicated pincodes, before any
  -- lock or query.
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_monitored_product_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_monitored_product_id');
  END IF;
  IF p_quota_limit IS NULL OR p_quota_limit <= 0 OR p_quota_limit > MAX_QUOTA_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_quota_limit');
  END IF;
  -- P0 decision, recorded explicitly (not silently assumed): an empty
  -- pincode list is REJECTED, not treated as "unconfigure every target."
  -- Removing an entire product from tracking is Remove Tracking's job
  -- (remove_pincode_monitored_products) -- this RPC only ever replaces a
  -- non-empty configured set. DATA_MODEL.md/IMPLEMENTATION_PLAN.md are
  -- updated to record this as a locked P0 decision, not an oversight.
  IF p_pincodes IS NULL OR array_length(p_pincodes, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'empty_pincodes_use_remove_tracking');
  END IF;
  IF array_length(p_pincodes, 1) > MAX_PINCODES THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_pincodes');
  END IF;
  FOREACH v_pincode IN ARRAY p_pincodes LOOP
    IF v_pincode !~ '^[1-9][0-9]{5}$' THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_pincode', 'pincode', v_pincode);
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT x) INTO v_pincodes FROM unnest(p_pincodes) AS x;

  -- Lock order step 1: advisory lock -- this RPC can change the active-
  -- target count (requirement 12), same discipline as enroll/resume.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Lock order step 2: lock the parent first.
  SELECT p.* INTO v_product FROM public.pincode_monitored_products p
    WHERE p.id = p_monitored_product_id
    FOR UPDATE;

  IF NOT FOUND OR v_product.workspace_id <> p_workspace_id OR v_product.marketplace_id <> p_marketplace_id THEN
    RETURN jsonb_build_object('result', 'not_found_or_scope_mismatch');
  END IF;

  -- Requirement 4: active parent only -- an archived/removed product's
  -- pincode list is not user-editable (re-adding via enrollment or Remove
  -- Tracking's own restore path is the way back, not this RPC).
  IF v_product.status <> 'active' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'parent_not_active');
  END IF;

  -- Lock order step 3: lock EVERY existing target row for this product,
  -- ordered by id, one query -- covers both the ones being kept/
  -- reconfigured and the ones about to be unconfigured.
  PERFORM 1 FROM public.pincode_tracking_targets t
  WHERE t.monitored_product_id = p_monitored_product_id
  ORDER BY t.id
  FOR UPDATE;

  -- Requirement 12: quota impact = genuinely new targets (no existing row
  -- for that pincode) + reconfigured targets that are not currently
  -- 'checking' (a reconfigured in-flight target doesn't change the active/
  -- checking count, it was already counted). Existing already-active/
  -- checking/configured targets being kept contribute nothing new.
  SELECT count(*) INTO v_added_count
  FROM unnest(v_pincodes) AS pin(pincode)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.pincode_tracking_targets t
    WHERE t.monitored_product_id = p_monitored_product_id AND t.pincode = pin.pincode
  );

  SELECT count(*) INTO v_reconfigured_count
  FROM public.pincode_tracking_targets t
  WHERE t.monitored_product_id = p_monitored_product_id
    AND t.is_configured = false
    AND t.pincode = ANY (v_pincodes)
    AND t.status <> 'checking';

  v_net_new_active := v_added_count + v_reconfigured_count;

  SELECT count(*) INTO v_current_active
  FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  WHERE p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id
    AND t.status IN ('active', 'checking');

  IF v_current_active + v_net_new_active > p_quota_limit THEN
    RETURN jsonb_build_object(
      'result', 'quota_exceeded',
      'currentActiveTargets', v_current_active,
      'requestedAdditionalTargets', v_net_new_active,
      'limit', p_quota_limit
    );
  END IF;

  -- Write phase -- nothing above this point has written anything, so a
  -- quota rejection above is a true no-op (requirement 13/14).

  -- Requirement 5: genuinely new targets.
  INSERT INTO public.pincode_tracking_targets (workspace_id, monitored_product_id, pincode, status, next_check_at, is_configured)
  SELECT p_workspace_id, p_monitored_product_id, pin.pincode, 'active', now(), true
  FROM unnest(v_pincodes) AS pin(pincode)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.pincode_tracking_targets t
    WHERE t.monitored_product_id = p_monitored_product_id AND t.pincode = pin.pincode
  );

  -- Requirement 6: reconfigure previously-unconfigured, requested targets.
  -- An in-flight ('checking') target being reconfigured keeps its current
  -- status/claim/schedule untouched -- only the configuration-lifecycle
  -- columns change; a non-checking one becomes active/scheduled/reset,
  -- same as a fresh resume.
  UPDATE public.pincode_tracking_targets t
  SET is_configured = true,
      unconfigured_at = NULL,
      status = CASE WHEN t.status = 'checking' THEN t.status ELSE 'active' END,
      next_check_at = CASE WHEN t.status = 'checking' THEN t.next_check_at ELSE now() END,
      consecutive_failures = CASE WHEN t.status = 'checking' THEN t.consecutive_failures ELSE 0 END
  WHERE t.monitored_product_id = p_monitored_product_id
    AND t.is_configured = false
    AND t.pincode = ANY (v_pincodes);

  -- Requirement 7/9/10/11: omitted, currently-configured targets.
  -- Requirement 9 (clear pending manual requests) and the is_configured/
  -- unconfigured_at transition apply UNCONDITIONALLY, regardless of
  -- current status. Requirement 10/11 (status/schedule) apply ONLY to
  -- non-checking rows -- an in-flight 'checking' target is never
  -- interrupted; finalize_pincode_check (above) parks it once it
  -- completes.
  UPDATE public.pincode_tracking_targets t
  SET is_configured = false,
      unconfigured_at = now(),
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL,
      status = CASE WHEN t.status = 'checking' THEN t.status ELSE 'paused' END,
      next_check_at = CASE WHEN t.status = 'checking' THEN t.next_check_at ELSE NULL END
  WHERE t.monitored_product_id = p_monitored_product_id
    AND t.is_configured = true
    AND NOT (t.pincode = ANY (v_pincodes));

  GET DIAGNOSTICS v_unconfigured_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'result', 'success',
    'addedCount', v_added_count,
    'reconfiguredCount', v_reconfigured_count,
    'unconfiguredCount', v_unconfigured_count,
    'targetCount', array_length(v_pincodes, 1)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_pincode_product_targets(uuid, text, uuid, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_pincode_product_targets(uuid, text, uuid, text[], integer) TO service_role;

-- ============================================================
-- 7. replace_workspace_default_pincodes (Correction 3's new RPC)
-- ============================================================
-- Atomic replacement for GET/PUT .../default-pincodes. p_pincodes is a
-- jsonb array of {"pincode": "110001", "displayOrder": 0} objects -- kept
-- as an explicit per-item display order (matching the existing route
-- contract) rather than array-position-implies-order, since the route
-- already collects/validates that shape.
CREATE OR REPLACE FUNCTION public.replace_workspace_default_pincodes(
  p_workspace_id   uuid,
  p_marketplace_id text,
  p_pincodes       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_element      jsonb;
  v_pincode      text;
  v_display_order integer;
  v_seen_pincodes text[];
  MAX_MARKETPLACE_LEN  CONSTANT integer := 40;
  MAX_DEFAULT_PINCODES CONSTANT integer := 200;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_pincodes IS NULL OR jsonb_typeof(p_pincodes) <> 'array' THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'pincodes_must_be_array');
  END IF;
  IF jsonb_array_length(p_pincodes) > MAX_DEFAULT_PINCODES THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_pincodes');
  END IF;

  v_seen_pincodes := '{}';
  FOR v_element IN SELECT * FROM jsonb_array_elements(p_pincodes)
  LOOP
    v_pincode := v_element->>'pincode';
    IF v_pincode IS NULL OR v_pincode !~ '^[1-9][0-9]{5}$' THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_pincode', 'pincode', v_element->>'pincode');
    END IF;
    IF v_element->'displayOrder' IS NULL OR jsonb_typeof(v_element->'displayOrder') <> 'number'
       OR (v_element->>'displayOrder')::numeric <> floor((v_element->>'displayOrder')::numeric)
       OR (v_element->>'displayOrder')::integer < 0 THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_display_order', 'pincode', v_pincode);
    END IF;
    IF v_pincode = ANY (v_seen_pincodes) THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'duplicate_pincode', 'pincode', v_pincode);
    END IF;
    v_seen_pincodes := array_append(v_seen_pincodes, v_pincode);
  END LOOP;

  -- Lock existing rows for this (workspace, marketplace) pair before
  -- mutating, so two concurrent PUT calls serialize rather than
  -- interleaving their upsert/deactivate steps against each other.
  PERFORM 1 FROM public.workspace_default_pincodes
  WHERE workspace_id = p_workspace_id AND marketplace_id = p_marketplace_id
  ORDER BY id
  FOR UPDATE;

  IF jsonb_array_length(p_pincodes) > 0 THEN
    INSERT INTO public.workspace_default_pincodes (workspace_id, marketplace_id, pincode, display_order, is_active)
    SELECT p_workspace_id, p_marketplace_id, elem->>'pincode', (elem->>'displayOrder')::integer, true
    FROM jsonb_array_elements(p_pincodes) AS elem
    ON CONFLICT (workspace_id, marketplace_id, pincode) DO UPDATE SET
      display_order = EXCLUDED.display_order,
      is_active = true;
  END IF;

  UPDATE public.workspace_default_pincodes d
  SET is_active = false
  WHERE d.workspace_id = p_workspace_id
    AND d.marketplace_id = p_marketplace_id
    AND d.is_active = true
    AND NOT (d.pincode = ANY (v_seen_pincodes));

  RETURN jsonb_build_object(
    'result', 'success',
    'defaults', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'pincode', pincode, 'displayOrder', display_order) ORDER BY display_order), '[]'::jsonb)
      FROM public.workspace_default_pincodes
      WHERE workspace_id = p_workspace_id AND marketplace_id = p_marketplace_id AND is_active = true
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_workspace_default_pincodes(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_workspace_default_pincodes(uuid, text, jsonb) TO service_role;

-- ============================================================
-- 8. get_pincode_target_results (Correction 4's bounded tracker-read RPC)
-- ============================================================
-- Returns, per requested target ID, exactly two facts computed in the
-- database: the latest attempt of any kind, and the last CONFIRMED
-- (available/unavailable) result -- never "every historical row." Both
-- lateral subqueries use `ORDER BY checked_at DESC LIMIT 1`, index-assisted
-- by pincode_availability_results_tracking_target_idx (tracking_target_id,
-- checked_at DESC) (062 migration) -- bounded to one index-scan-and-stop
-- per target per fact, not a full-history download. p_workspace_id is
-- required and checked on every row read, defense-in-depth against a
-- target_id that somehow doesn't belong to the caller's own workspace,
-- even though the caller (tracker.ts) already scopes its own target-ID
-- list to one authorized workspace before calling this.
CREATE OR REPLACE FUNCTION public.get_pincode_target_results(
  p_workspace_id uuid,
  p_target_ids   uuid[]
)
RETURNS TABLE (
  tracking_target_id          uuid,
  latest_check_status         text,
  latest_availability_status  text,
  latest_checked_at           timestamptz,
  latest_delivery_message     text,
  latest_error_code           text,
  latest_error_message        text,
  confirmed_availability_status text,
  confirmed_checked_at        timestamptz,
  confirmed_delivery_message  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN;
  END IF;
  IF p_target_ids IS NULL OR array_length(p_target_ids, 1) IS NULL OR array_length(p_target_ids, 1) > 500 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    la.check_status, la.availability_status, la.checked_at, la.delivery_message, la.error_code, la.error_message,
    ca.availability_status, ca.checked_at, ca.delivery_message
  FROM unnest(p_target_ids) AS t(id)
  LEFT JOIN LATERAL (
    SELECT r.check_status, r.availability_status, r.checked_at, r.delivery_message, r.error_code, r.error_message
    FROM public.pincode_availability_results r
    WHERE r.tracking_target_id = t.id AND r.workspace_id = p_workspace_id
    ORDER BY r.checked_at DESC
    LIMIT 1
  ) la ON true
  LEFT JOIN LATERAL (
    SELECT r.availability_status, r.checked_at, r.delivery_message
    FROM public.pincode_availability_results r
    WHERE r.tracking_target_id = t.id AND r.workspace_id = p_workspace_id
      AND r.check_status = 'success'
      AND r.availability_status IN ('available', 'unavailable')
    ORDER BY r.checked_at DESC
    LIMIT 1
  ) ca ON true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_pincode_target_results(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pincode_target_results(uuid, uuid[]) TO service_role;

notify pgrst, 'reload schema';
