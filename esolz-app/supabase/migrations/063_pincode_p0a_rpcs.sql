-- Pincode Checker P0-A, migration 4 of 4: the six trusted, SECURITY DEFINER
-- RPCs this feature's entire mutation/scheduling surface goes through.
--
-- Every function below: explicit search_path, EXECUTE revoked from PUBLIC
-- and granted only to service_role (never authenticated), validates its own
-- parameters before any lock or query, and follows the one global lock
-- order (PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md sec2.0): advisory lock
-- (quota/manual-queue-affecting RPCs only) -> parent rows (id order) ->
-- target rows (id order) -> result insertion (finalize only).
--
-- claim_due_pincode_targets, finalize_pincode_check, and
-- queue_pincode_manual_check are transcribed directly from the merged spec's
-- literal SQL bodies (IMPLEMENTATION_PLAN.md sec2.7, sec2.8, sec2.10), with
-- one substitution: finalize_pincode_check's failure-threshold placeholder
-- is set to the documented PINCODE_SCHEDULER_MAX_CONSECUTIVE_FAILURES
-- default of 5 (sec2.5) as a named local constant.
--
-- enroll_pincode_monitored_products, set_pincode_tracking_state, and
-- remove_pincode_monitored_products were specified only as numbered prose
-- steps (DATA_MODEL.md sec2a/sec3a/sec3b) -- this migration is their first
-- executable form, written to match every numbered step exactly. All three
-- return jsonb with a `result` discriminator field, the same convention
-- queue_pincode_manual_check's spec already established, since the spec
-- text explicitly calls for "a distinguishable error the calling route maps
-- to HTTP" and gives no literal RETURNS clause of its own for these three.
--
-- PR #54 implementation-review round (2026-07-18), three corrections:
-- 1. Correction 2 -- set_pincode_tracking_state and
--    remove_pincode_monitored_products now perform COMPLETE-BATCH ID
--    validation (workspace/marketplace non-null and length-bounded, no
--    NULL array elements, duplicate IDs normalized, and the count of
--    existing-and-in-scope locked rows must equal the count of distinct
--    requested IDs) before any mutation -- a missing, foreign, or
--    scope-mismatched ID now rejects the ENTIRE request with a single
--    distinguishable `not_found_or_scope_mismatch` result, never a
--    silent partial success against whichever subset happened to exist.
-- 2. Correction 3 -- enroll_pincode_monitored_products now verifies
--    product IDENTITY, not just existence: an 'owned' amazon_listing_
--    item_id must belong to the caller's workspace/marketplace AND its
--    own `asin` column must match the requested ASIN (previously only
--    existence+workspace+marketplace was checked, silently accepting any
--    of the workspace's own listing IDs regardless of which product they
--    actually named); a supplied tracked_asin_id is now verified the same
--    way against tracked_asins' own `marketplace` column (confirmed by
--    name directly against the schema, not assumed); every UUID-shaped
--    input is regex-validated before any ::uuid cast, so a malformed UUID
--    returns invalid_parameters instead of an uncontrolled 22P02
--    exception; 'other'-source products can no longer carry a listing
--    reference (explicit rejection, not silent reinterpretation); and
--    duplicate ASIN objects with conflicting product_source/listing/
--    tracked-ASIN metadata are rejected outright rather than letting a
--    later DISTINCT ON silently pick an arbitrary winner.
-- 3. Correction 4 -- every RPC that takes p_marketplace_id now bounds its
--    length; every RPC that takes a caller-configured quota/limit
--    parameter (p_quota_limit, p_manual_pending_limit) now also enforces
--    a hard, code-level ceiling distinct from that configured value, so a
--    malformed environment/config value can never become an effectively
--    unlimited quota; enroll_pincode_monitored_products additionally
--    bounds the TOTAL flattened (asin, pincode) combination count, not
--    just each array's own length independently.

-- ============================================================
-- 1. enroll_pincode_monitored_products
-- ============================================================
CREATE OR REPLACE FUNCTION public.enroll_pincode_monitored_products(
  p_workspace_id   uuid,
  p_marketplace_id text,
  p_products       jsonb,
  p_quota_limit    integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_element              jsonb;
  v_pincode              text;
  v_asin                 text;
  v_product_source       text;
  v_listing_id_text      text;
  v_tracked_id_text      text;
  v_bad_listing_asin     text;
  v_bad_tracked_asin     text;
  v_conflicting_asin     text;
  v_total_combinations   integer;
  v_current_active       integer;
  v_requested_additional integer;
  -- Correction 4 (2026-07-18, PR #54 review round): hard safety ceilings --
  -- code-enforced, never configurable, distinct from p_quota_limit itself.
  -- p_quota_limit remains the caller-supplied commercial/configured value
  -- (DATA_MODEL.md sec2b -- "not invented in this spec"); it must now also
  -- be <= MAX_QUOTA_LIMIT, so a malformed env value can never become an
  -- effectively unlimited quota. The other four bound the request shape
  -- itself, independent of any commercial configuration.
  MAX_QUOTA_LIMIT          CONSTANT integer := 100000;
  MAX_MARKETPLACE_LEN      CONSTANT integer := 40;
  MAX_PRODUCTS             CONSTANT integer := 200;
  MAX_PINCODES_PER_PRODUCT CONSTANT integer := 100;
  MAX_TOTAL_COMBINATIONS   CONSTANT integer := 2000;
  UUID_RE                  CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  -- Correction 14 (original) + Correction 4 (PR #54 review round):
  -- parameter validation, before any lock or query.
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_quota_limit IS NULL OR p_quota_limit <= 0 OR p_quota_limit > MAX_QUOTA_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_quota_limit');
  END IF;
  IF p_products IS NULL OR jsonb_typeof(p_products) <> 'array' OR jsonb_array_length(p_products) = 0 THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'empty_products');
  END IF;
  IF jsonb_array_length(p_products) > MAX_PRODUCTS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_products');
  END IF;

  FOR v_element IN SELECT * FROM jsonb_array_elements(p_products)
  LOOP
    v_asin := upper(v_element->>'asin');
    v_product_source := v_element->>'product_source';
    v_listing_id_text := NULLIF(v_element->>'amazon_listing_item_id', '');
    v_tracked_id_text := NULLIF(v_element->>'tracked_asin_id', '');

    IF v_asin IS NULL OR v_asin !~ '^[A-Z0-9]{10}$' THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_asin', 'asin', v_element->>'asin');
    END IF;
    IF v_product_source IS NULL OR v_product_source NOT IN ('owned', 'other') THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_product_source', 'asin', v_asin);
    END IF;

    -- Correction 3 (2026-07-18, PR #54 review round): UUID text must be
    -- validated BEFORE any ::uuid cast -- a malformed UUID string cast
    -- directly raises an uncontrolled 22P02 exception (unhandled in this
    -- function) instead of a normal, handled invalid_parameters result.
    IF v_listing_id_text IS NOT NULL AND v_listing_id_text !~* UUID_RE THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'malformed_listing_id', 'asin', v_asin);
    END IF;
    IF v_tracked_id_text IS NOT NULL AND v_tracked_id_text !~* UUID_RE THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'malformed_tracked_asin_id', 'asin', v_asin);
    END IF;

    IF v_product_source = 'owned' AND v_listing_id_text IS NULL THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'owned_requires_listing_id', 'asin', v_asin);
    END IF;
    -- Correction 3: 'other' must not carry an owned-style listing
    -- reference while staying labelled 'other' -- contradictory input.
    -- P0 preferred behavior is explicit rejection, not silent
    -- normalization to the owned path.
    IF v_product_source = 'other' AND v_listing_id_text IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'other_source_cannot_have_listing_id', 'asin', v_asin);
    END IF;

    IF v_element->'pincodes' IS NULL OR jsonb_typeof(v_element->'pincodes') <> 'array'
       OR jsonb_array_length(v_element->'pincodes') = 0 THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'empty_pincodes', 'asin', v_asin);
    END IF;
    IF jsonb_array_length(v_element->'pincodes') > MAX_PINCODES_PER_PRODUCT THEN
      RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_pincodes', 'asin', v_asin);
    END IF;
    FOR v_pincode IN SELECT jsonb_array_elements_text(v_element->'pincodes')
    LOOP
      IF v_pincode !~ '^[1-9][0-9]{5}$' THEN
        RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_pincode', 'asin', v_asin, 'pincode', v_pincode);
      END IF;
    END LOOP;
  END LOOP;

  -- Correction 4: total expanded (asin, pincode) combination ceiling --
  -- MAX_PRODUCTS x MAX_PINCODES_PER_PRODUCT alone would still allow 20,000
  -- combinations even though each individual field is bounded; bound the
  -- ACTUAL flattened total separately.
  SELECT count(*) INTO v_total_combinations
  FROM jsonb_array_elements(p_products) AS elem
  CROSS JOIN LATERAL jsonb_array_elements_text(elem->'pincodes') AS pin(pincode);
  IF v_total_combinations > MAX_TOTAL_COMBINATIONS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_combinations', 'count', v_total_combinations);
  END IF;

  -- Correction 3: duplicate ASIN objects within one request must not be
  -- resolved by an arbitrary DISTINCT ON winner later in this function.
  -- Duplicate PINCODE lists for the same ASIN are fine and are merged via
  -- DISTINCT further down -- this check is specifically about conflicting
  -- METADATA (product_source / listing / tracked-ASIN) for the same ASIN.
  SELECT grouped.asin INTO v_conflicting_asin
  FROM (
    SELECT upper(elem->>'asin') AS asin,
           count(DISTINCT elem->>'product_source') AS distinct_sources,
           count(DISTINCT COALESCE(elem->>'amazon_listing_item_id', '')) AS distinct_listing_ids,
           count(DISTINCT COALESCE(elem->>'tracked_asin_id', '')) AS distinct_tracked_ids
    FROM jsonb_array_elements(p_products) AS elem
    GROUP BY upper(elem->>'asin')
  ) grouped
  WHERE distinct_sources > 1 OR distinct_listing_ids > 1 OR distinct_tracked_ids > 1
  LIMIT 1;

  IF v_conflicting_asin IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'conflicting_duplicate_asin_metadata', 'asin', v_conflicting_asin);
  END IF;

  -- Lock order step 1: advisory lock, held for the remainder of this
  -- transaction (DATA_MODEL.md sec2a).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Lock order step 2: lock EXISTING parent rows first, ordered by id, one
  -- query for the whole batch -- never row-by-row in a loop, which cannot
  -- guarantee ordering against a concurrent caller touching the same rows
  -- in a different order.
  PERFORM 1 FROM public.pincode_monitored_products p
  WHERE p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id
    AND p.asin = ANY (SELECT DISTINCT upper(elem->>'asin') FROM jsonb_array_elements(p_products) AS elem)
  ORDER BY p.id
  FOR UPDATE;

  -- Correction 3 (2026-07-18, PR #54 review round): the owned-listing
  -- check now verifies the listing's OWN asin column actually matches the
  -- requested ASIN, not merely that a listing with the supplied ID exists
  -- somewhere in this workspace/marketplace -- previously a caller could
  -- supply any of the workspace's own listing IDs alongside an unrelated
  -- requested ASIN and have it accepted, silently mislabeling the product.
  SELECT elem->>'asin' INTO v_bad_listing_asin
  FROM jsonb_array_elements(p_products) AS elem
  WHERE elem->>'product_source' = 'owned'
    AND NOT EXISTS (
      SELECT 1 FROM public.amazon_listing_items li
      WHERE li.id = (elem->>'amazon_listing_item_id')::uuid
        AND li.workspace_id = p_workspace_id
        AND li.marketplace_id = p_marketplace_id
        AND upper(li.asin) = upper(elem->>'asin')
    )
  LIMIT 1;

  IF v_bad_listing_asin IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'listing_verification_failed', 'asin', v_bad_listing_asin);
  END IF;

  -- Correction 3: tracked_asin_id, when supplied (an optional legacy
  -- cross-reference either product_source may independently carry), must
  -- belong to the same workspace, the same marketplace via tracked_asins'
  -- own `marketplace` column -- confirmed directly against the schema:
  -- tracked_asins has no `marketplace_id` column, only `marketplace` --
  -- and the same normalized ASIN.
  SELECT elem->>'asin' INTO v_bad_tracked_asin
  FROM jsonb_array_elements(p_products) AS elem
  WHERE NULLIF(elem->>'tracked_asin_id', '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.tracked_asins ta
      WHERE ta.id = (elem->>'tracked_asin_id')::uuid
        AND ta.workspace_id = p_workspace_id
        AND ta.marketplace = p_marketplace_id
        AND upper(ta.asin) = upper(elem->>'asin')
    )
  LIMIT 1;

  IF v_bad_tracked_asin IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'listing_verification_failed', 'asin', v_bad_tracked_asin, 'reason', 'tracked_asin_mismatch');
  END IF;

  -- Lock order step 3: lock EXISTING target rows second, ordered by id, one
  -- query for the whole batch. Brand-new products have no parent row yet at
  -- this point, hence no existing targets to lock either -- nothing to do
  -- for them here, which is correct: there is genuinely nothing to lock.
  PERFORM 1 FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  WHERE p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id
    AND p.asin = ANY (SELECT DISTINCT upper(elem->>'asin') FROM jsonb_array_elements(p_products) AS elem)
    AND t.pincode = ANY (
      SELECT DISTINCT jsonb_array_elements_text(elem->'pincodes') FROM jsonb_array_elements(p_products) AS elem
    )
  ORDER BY t.id
  FOR UPDATE;

  -- Count genuinely-new targets + re-add reactivations this batch would
  -- create (DATA_MODEL.md sec2a steps 5/6): a (product, pincode) pair whose
  -- PARENT doesn't exist yet at all (brand-new product -- always new), OR
  -- has no existing target for that pincode, OR an existing paused/failed
  -- target whose PARENT was 'removed' (any source) or 'archived' (owned +
  -- freshly-verified listing only) BEFORE this call. A paused/failed target
  -- under an already-active parent is intentionally NOT counted or
  -- reactivated here -- that is a deliberate Resume action via
  -- set_pincode_tracking_state. LEFT JOINs throughout: no parent row is
  -- written yet, so this must not require one to already exist.
  WITH req_products AS (
    SELECT DISTINCT ON (upper(elem->>'asin'))
      upper(elem->>'asin') AS asin, elem->>'product_source' AS product_source
    FROM jsonb_array_elements(p_products) AS elem
    ORDER BY upper(elem->>'asin')
  ),
  req_pincodes AS (
    SELECT DISTINCT upper(elem->>'asin') AS asin, pin.pincode
    FROM jsonb_array_elements(p_products) AS elem
    CROSS JOIN LATERAL jsonb_array_elements_text(elem->'pincodes') AS pin(pincode)
  ),
  existing_parents AS (
    SELECT p.id AS monitored_product_id, p.asin, p.status AS parent_status, rp.product_source AS req_source
    FROM public.pincode_monitored_products p
    JOIN req_products rp ON rp.asin = p.asin
    WHERE p.workspace_id = p_workspace_id AND p.marketplace_id = p_marketplace_id
  )
  SELECT count(*) INTO v_requested_additional
  FROM req_pincodes rpin
  LEFT JOIN existing_parents ep ON ep.asin = rpin.asin
  LEFT JOIN public.pincode_tracking_targets t
    ON t.monitored_product_id = ep.monitored_product_id AND t.pincode = rpin.pincode
  WHERE ep.monitored_product_id IS NULL
     OR t.id IS NULL
     OR (t.status IN ('paused', 'failed')
         AND (ep.parent_status = 'removed' OR (ep.parent_status = 'archived' AND ep.req_source = 'owned')));

  -- Quota decision (DATA_MODEL.md sec2b): current active/checking total,
  -- computed under the advisory lock so no concurrent caller can read a
  -- stale count.
  SELECT count(*) INTO v_current_active
  FROM public.pincode_tracking_targets t
  JOIN public.pincode_monitored_products p ON p.id = t.monitored_product_id
  WHERE p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id
    AND t.status IN ('active', 'checking');

  IF v_current_active + v_requested_additional > p_quota_limit THEN
    RETURN jsonb_build_object(
      'result', 'quota_exceeded',
      'currentActiveTargets', v_current_active,
      'requestedAdditionalTargets', v_requested_additional,
      'limit', p_quota_limit
    );
  END IF;

  -- Write phase, complete and atomic for the whole batch -- nothing above
  -- this point has written anything, so a quota rejection above is a true
  -- no-op, never a stray empty parent row. Order: (a) create parent rows
  -- for genuinely-new ASINs only, (b) targets -- referencing every relevant
  -- parent's PRE-restore status (existing rows are still untouched; brand-
  -- new rows just created default to 'active', which is always correct),
  -- (c) parents -- restoring removed/archived-owned rows to active. All in
  -- the same transaction as the reads above.
  INSERT INTO public.pincode_monitored_products (
    workspace_id, marketplace_id, asin, product_source,
    amazon_listing_item_id, tracked_asin_id,
    title_snapshot, image_url_snapshot, brand_snapshot
  )
  SELECT p_workspace_id, p_marketplace_id, dedup.asin, dedup.product_source,
         dedup.amazon_listing_item_id, dedup.tracked_asin_id,
         dedup.title_snapshot, dedup.image_url_snapshot, dedup.brand_snapshot
  FROM (
    SELECT DISTINCT ON (upper(elem->>'asin'))
      upper(elem->>'asin') AS asin,
      elem->>'product_source' AS product_source,
      NULLIF(elem->>'amazon_listing_item_id', '')::uuid AS amazon_listing_item_id,
      NULLIF(elem->>'tracked_asin_id', '')::uuid AS tracked_asin_id,
      elem->>'title_snapshot' AS title_snapshot,
      elem->>'image_url_snapshot' AS image_url_snapshot,
      elem->>'brand_snapshot' AS brand_snapshot
    FROM jsonb_array_elements(p_products) AS elem
    ORDER BY upper(elem->>'asin')
  ) dedup
  ON CONFLICT (workspace_id, marketplace_id, asin) DO NOTHING;

  WITH req_products AS (
    SELECT DISTINCT ON (upper(elem->>'asin'))
      upper(elem->>'asin') AS asin, elem->>'product_source' AS product_source
    FROM jsonb_array_elements(p_products) AS elem
    ORDER BY upper(elem->>'asin')
  ),
  req_pincodes AS (
    SELECT DISTINCT upper(elem->>'asin') AS asin, pin.pincode
    FROM jsonb_array_elements(p_products) AS elem
    CROSS JOIN LATERAL jsonb_array_elements_text(elem->'pincodes') AS pin(pincode)
  ),
  target_parents AS (
    SELECT p.id AS monitored_product_id, p.asin, p.status AS parent_status, rp.product_source AS req_source
    FROM public.pincode_monitored_products p
    JOIN req_products rp ON rp.asin = p.asin
    WHERE p.workspace_id = p_workspace_id AND p.marketplace_id = p_marketplace_id
  )
  INSERT INTO public.pincode_tracking_targets (workspace_id, monitored_product_id, pincode, status, next_check_at)
  SELECT p_workspace_id, tp.monitored_product_id, rpin.pincode, 'active', now()
  FROM req_pincodes rpin
  JOIN target_parents tp ON tp.asin = rpin.asin
  ON CONFLICT (monitored_product_id, pincode) DO UPDATE SET
    status = 'active',
    next_check_at = now(),
    consecutive_failures = CASE WHEN public.pincode_tracking_targets.status = 'failed' THEN 0 ELSE public.pincode_tracking_targets.consecutive_failures END,
    claimed_at = NULL, claimed_by = NULL, claim_token = NULL
  WHERE public.pincode_tracking_targets.status IN ('paused', 'failed')
    AND EXISTS (
      SELECT 1 FROM target_parents tp2
      WHERE tp2.monitored_product_id = public.pincode_tracking_targets.monitored_product_id
        AND (tp2.parent_status = 'removed' OR (tp2.parent_status = 'archived' AND tp2.req_source = 'owned'))
    );

  WITH req_products AS (
    SELECT DISTINCT ON (upper(elem->>'asin'))
      upper(elem->>'asin') AS asin,
      elem->>'product_source' AS product_source,
      NULLIF(elem->>'amazon_listing_item_id', '')::uuid AS amazon_listing_item_id,
      NULLIF(elem->>'tracked_asin_id', '')::uuid AS tracked_asin_id,
      elem->>'title_snapshot' AS title_snapshot,
      elem->>'image_url_snapshot' AS image_url_snapshot,
      elem->>'brand_snapshot' AS brand_snapshot
    FROM jsonb_array_elements(p_products) AS elem
    ORDER BY upper(elem->>'asin')
  )
  UPDATE public.pincode_monitored_products p
  SET
    product_source = CASE WHEN p.product_source = 'other' AND rp.product_source = 'owned' THEN 'owned' ELSE p.product_source END,
    amazon_listing_item_id = COALESCE(rp.amazon_listing_item_id, p.amazon_listing_item_id),
    tracked_asin_id = COALESCE(rp.tracked_asin_id, p.tracked_asin_id),
    title_snapshot = COALESCE(rp.title_snapshot, p.title_snapshot),
    image_url_snapshot = COALESCE(rp.image_url_snapshot, p.image_url_snapshot),
    brand_snapshot = COALESCE(rp.brand_snapshot, p.brand_snapshot),
    status = CASE
      WHEN p.status = 'removed' THEN 'active'
      WHEN p.status = 'archived' AND rp.product_source = 'owned' THEN 'active'
      ELSE p.status
    END,
    removed_at = CASE
      WHEN p.status = 'removed' OR (p.status = 'archived' AND rp.product_source = 'owned') THEN NULL
      ELSE p.removed_at
    END,
    removal_reason = CASE
      WHEN p.status = 'removed' OR (p.status = 'archived' AND rp.product_source = 'owned') THEN NULL
      ELSE p.removal_reason
    END
  FROM req_products rp
  WHERE p.workspace_id = p_workspace_id AND p.marketplace_id = p_marketplace_id AND p.asin = rp.asin;

  RETURN jsonb_build_object(
    'result', 'success',
    'currentActiveTargets', v_current_active,
    'requestedAdditionalTargets', v_requested_additional
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enroll_pincode_monitored_products(uuid, text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enroll_pincode_monitored_products(uuid, text, jsonb, integer) TO service_role;

-- ============================================================
-- 2. set_pincode_tracking_state
-- ============================================================
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
  -- Correction 4 (2026-07-18, PR #54 review round): hard safety ceilings,
  -- distinct from p_quota_limit, the caller-supplied commercial/configured
  -- value -- see the matching comment in enroll_pincode_monitored_products.
  MAX_QUOTA_LIMIT      CONSTANT integer := 100000;
  MAX_MARKETPLACE_LEN  CONSTANT integer := 40;
  MAX_TARGET_IDS       CONSTANT integer := 500;
BEGIN
  -- Correction 14 (original) + Correction 2/4 (PR #54 review round):
  -- parameter validation, before any lock or query.
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
  -- Correction 2: no null ID inside the array -- a NULL element would
  -- otherwise silently vanish from every downstream ANY()/IN() comparison
  -- (NULL never equals anything, including itself via `=`) rather than
  -- being rejected as the malformed input it actually is.
  IF EXISTS (SELECT 1 FROM unnest(p_target_ids) AS x WHERE x IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'null_id_in_array');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('pause', 'resume') THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_action');
  END IF;
  IF p_quota_limit IS NULL OR p_quota_limit <= 0 OR p_quota_limit > MAX_QUOTA_LIMIT THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_quota_limit');
  END IF;

  -- Duplicate IDs normalized before any counting.
  SELECT array_agg(DISTINCT x) INTO v_target_ids FROM unnest(p_target_ids) AS x;
  v_requested_count := array_length(v_target_ids, 1);

  -- Lock order step 1: advisory lock. Pausing alone cannot oversubscribe
  -- quota, but the same lock is acquired uniformly for both actions so this
  -- RPC's lock acquisition order never diverges from every other one
  -- (DATA_MODEL.md sec3a).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Lock order step 2: lock parent rows first, ordered by id, one query.
  -- Only EXISTING targets contribute a parent to this set -- a foreign or
  -- nonexistent target id simply locks nothing here; that gap is caught
  -- explicitly by the complete-batch validation below, not silently
  -- ignored.
  PERFORM 1 FROM public.pincode_monitored_products p
  WHERE p.id IN (SELECT DISTINCT t.monitored_product_id FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids))
  ORDER BY p.id
  FOR UPDATE;

  -- Lock order step 3: lock target rows second, ordered by id, one query --
  -- moved ahead of the action branch (originally duplicated inside each of
  -- pause/resume separately) so the complete-batch validation right below
  -- covers both actions from one lock pass, not two divergent ones.
  PERFORM 1 FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids) ORDER BY t.id FOR UPDATE;

  -- Correction 2 (2026-07-18, PR #54 review round) -- complete-batch ID
  -- validation, replacing the narrower "existing rows only" scope check
  -- this used to be. Count how many of the DISTINCT requested IDs (a) still
  -- exist as a locked pincode_tracking_targets row, (b) belong to the
  -- caller's stated workspace, and (c) whose locked PARENT belongs to the
  -- caller's stated workspace AND marketplace. If this is less than the
  -- number of distinct requested IDs, at least one ID was missing, foreign,
  -- or scope-mismatched -- reject the ENTIRE request, perform NO mutation,
  -- and return one distinguishable result rather than silently operating
  -- on whichever subset happened to resolve (the bug this correction
  -- exists to close: the previous version's per-branch checks only ever
  -- asserted "every FOUND row is in scope," never "every REQUESTED id was
  -- found").
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
    -- A parent is never 'paused' (three-value lifecycle, DATA_MODEL.md sec2
    -- Correction 13) -- archived/removed cannot resume, no other branch.
    IF EXISTS (
      SELECT 1 FROM public.pincode_monitored_products p
      WHERE p.id IN (SELECT DISTINCT t.monitored_product_id FROM public.pincode_tracking_targets t WHERE t.id = ANY (v_target_ids))
        AND p.status IN ('archived', 'removed')
    ) THEN
      RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'parent_archived_or_removed');
    END IF;

    -- Projected active-target count: current active/checking total, PLUS
    -- every target in this batch currently paused/failed about to become
    -- active (DATA_MODEL.md sec3a step 6).
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

  -- p_action = 'pause'. Parent and target locks, and the complete-batch ID
  -- validation, already happened once above (shared by both actions) --
  -- nothing further to lock or re-validate here.
  -- In-flight safety: a 'checking' target is never yanked out from under
  -- the worker. All-or-nothing: any selected target still checking rejects
  -- the WHOLE batch, naming which target(s), rather than silently pausing a
  -- subset (DATA_MODEL.md sec3a step 4).
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
  -- paused/failed targets already in the batch are already not-running:
  -- no-op, not an error (DATA_MODEL.md sec3a step 4's third bullet).

  RETURN jsonb_build_object('result', 'success', 'action', 'pause', 'targetCount', v_valid_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_pincode_tracking_state(uuid, text, uuid[], text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_pincode_tracking_state(uuid, text, uuid[], text, integer) TO service_role;

-- ============================================================
-- 3. remove_pincode_monitored_products
-- ============================================================
CREATE OR REPLACE FUNCTION public.remove_pincode_monitored_products(
  p_workspace_id          uuid,
  p_marketplace_id        text,
  p_monitored_product_ids uuid[],
  p_removal_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_ids     uuid[];
  v_requested_count integer;
  v_valid_count     integer;
  -- Correction 4 (2026-07-18, PR #54 review round): hard safety ceilings --
  -- see the matching comment in enroll_pincode_monitored_products.
  MAX_MARKETPLACE_LEN CONSTANT integer := 40;
  MAX_PRODUCT_IDS     CONSTANT integer := 200;
BEGIN
  -- Correction 14 (original) + Correction 2/4 (PR #54 review round):
  -- parameter validation, before any lock or query.
  IF p_workspace_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'missing_workspace_id');
  END IF;
  IF p_marketplace_id IS NULL OR length(p_marketplace_id) = 0 OR length(p_marketplace_id) > MAX_MARKETPLACE_LEN THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_marketplace_id');
  END IF;
  IF p_monitored_product_ids IS NULL OR array_length(p_monitored_product_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'empty_product_ids');
  END IF;
  IF array_length(p_monitored_product_ids, 1) > MAX_PRODUCT_IDS THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'too_many_product_ids');
  END IF;
  -- Correction 2: no null ID inside the array.
  IF EXISTS (SELECT 1 FROM unnest(p_monitored_product_ids) AS x WHERE x IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'null_id_in_array');
  END IF;
  -- Narrow, application-defined allowed-value set -- never an arbitrary
  -- free-text string written unchecked into the database.
  IF p_removal_reason IS NULL OR p_removal_reason NOT IN ('user_requested') THEN
    RETURN jsonb_build_object('result', 'invalid_parameters', 'reason', 'invalid_removal_reason');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_product_ids FROM unnest(p_monitored_product_ids) AS x;
  v_requested_count := array_length(v_product_ids, 1);

  -- Lock order step 1: advisory lock -- removal frees quota, same uniform
  -- discipline as pause (DATA_MODEL.md sec3b).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Lock order step 2: lock parent rows first, ordered by id, one query.
  PERFORM 1 FROM public.pincode_monitored_products p WHERE p.id = ANY (v_product_ids) ORDER BY p.id FOR UPDATE;

  -- Correction 2 (2026-07-18, PR #54 review round) -- complete-batch ID
  -- validation. Count how many of the distinct requested IDs actually
  -- exist (now locked) and belong to the caller's stated workspace/
  -- marketplace. A missing or foreign ID rejects the ENTIRE request with
  -- no mutation, rather than silently removing whichever subset resolved
  -- (replacing the narrower "every FOUND row is in scope" check this used
  -- to be, which never asserted "every REQUESTED id was found").
  SELECT count(*) INTO v_valid_count
  FROM public.pincode_monitored_products p
  WHERE p.id = ANY (v_product_ids)
    AND p.workspace_id = p_workspace_id
    AND p.marketplace_id = p_marketplace_id;

  IF v_valid_count <> v_requested_count THEN
    RETURN jsonb_build_object(
      'result', 'not_found_or_scope_mismatch',
      'requestedCount', v_requested_count,
      'validCount', v_valid_count
    );
  END IF;

  -- Lock order step 3: lock target rows second, ordered by id, one query.
  PERFORM 1 FROM public.pincode_tracking_targets t WHERE t.monitored_product_id = ANY (v_product_ids) ORDER BY t.id FOR UPDATE;

  -- In-flight behavior (DATA_MODEL.md sec3b step 6): 'checking' targets are
  -- left completely untouched -- the parent still moves to 'removed' in the
  -- same transaction; finalize_pincode_check re-reads the locked parent's
  -- status at finalize time and reacts correctly (sec2.7 Correction 5).
  -- Non-checking children (active/paused/failed) pause immediately.
  UPDATE public.pincode_tracking_targets t
  SET status = 'paused',
      next_check_at = NULL,
      manual_requested_at = NULL, manual_requested_by = NULL, manual_request_token = NULL
  WHERE t.monitored_product_id = ANY (v_product_ids)
    AND t.status IN ('active', 'paused', 'failed');

  -- Idempotent: an already-removed product is a no-op for that row, not an
  -- error for the whole batch. An already-archived product may still be
  -- removed (DATA_MODEL.md sec3b step 4).
  UPDATE public.pincode_monitored_products p
  SET status = 'removed',
      removed_at = now(),
      removal_reason = p_removal_reason
  WHERE p.id = ANY (v_product_ids)
    AND p.status <> 'removed';

  RETURN jsonb_build_object('result', 'success', 'productCount', v_valid_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.remove_pincode_monitored_products(uuid, text, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_pincode_monitored_products(uuid, text, uuid[], text) TO service_role;

-- ============================================================
-- 4. queue_pincode_manual_check
-- ============================================================
CREATE OR REPLACE FUNCTION public.queue_pincode_manual_check(
  p_target_id uuid,
  p_workspace_id uuid,
  p_marketplace_id text,
  p_user_id uuid,
  p_cooldown_seconds integer,
  p_manual_pending_limit integer  -- the CONFIGURED limit only -- current usage is computed inside, not passed in
)
RETURNS jsonb  -- { result: 'queued'|'already_queued'|'checking'|'invalid_status'|'cooldown'|'quota_exceeded', ... }
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lookup_product_id uuid;
  v_target  public.pincode_tracking_targets;
  v_product public.pincode_monitored_products;
  v_outstanding integer;
  -- Correction 4 (2026-07-18, PR #54 review round): hard safety ceilings --
  -- p_manual_pending_limit remains the caller-supplied commercial/
  -- configured value (DATA_MODEL.md sec2c); it must now also be <=
  -- MAX_MANUAL_PENDING_LIMIT, so a malformed env value can never become an
  -- effectively unlimited manual-check queue.
  MAX_MANUAL_PENDING_LIMIT CONSTANT integer := 10000;
  MAX_MARKETPLACE_LEN      CONSTANT integer := 40;
BEGIN
  -- Round-4 Correction 14 + Correction 4 (PR #54 review round): parameter
  -- bounds, before any lock or query. An environment-variable typo must
  -- never produce an unbounded cooldown or an effectively-unlimited
  -- manual queue.
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

  -- Round-4 Correction 2 (global lock order, sec2.0): acquire the advisory
  -- lock FIRST for this RPC (unlike finalize_pincode_check, this RPC's
  -- target/parent identity is already known from its own parameters --
  -- there's no claim-token indirection to resolve before deciding which
  -- lock to take).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_marketplace_id, 0));

  -- Non-locking lookup to identify which parent to lock (same discipline
  -- as finalize_pincode_check, sec2.7) -- also the first opportunity to
  -- reject an unknown/wrong-workspace target before taking any row lock.
  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE id = p_target_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  -- Lock order step 2: lock the PARENT first.
  SELECT p.* INTO v_product FROM public.pincode_monitored_products p
    WHERE p.id = v_lookup_product_id
    FOR UPDATE;

  -- Round-4 Correction 3: re-validate the locked parent's own
  -- workspace_id/marketplace_id actually match what the caller claimed --
  -- do not trust p_workspace_id/p_marketplace_id merely because the
  -- (trusted) route supplied them. This is the specific gap Correction 3
  -- named: p_marketplace_id controls the advisory-lock key and the
  -- outstanding-count pool below, so an unvalidated mismatch here would
  -- let a caller manipulate which quota pool a request counts against.
  IF v_product.workspace_id <> p_workspace_id OR v_product.marketplace_id <> p_marketplace_id THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'workspace_marketplace_mismatch');
  END IF;

  -- Lock order step 3: lock the TARGET second, re-validating the
  -- parent-child relationship in the same WHERE clause (Correction 3
  -- again -- the target's own workspace_id and monitored_product_id must
  -- still agree with what was just locked).
  SELECT t.* INTO v_target FROM public.pincode_tracking_targets t
    WHERE t.id = p_target_id
      AND t.workspace_id = p_workspace_id
      AND t.monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'not_found_or_wrong_workspace');
  END IF;

  -- Lock order step 4: revalidate current state, corrected status-test
  -- matrix (parent status checked FIRST and independently of target
  -- status -- an archived/removed parent rejects regardless of what the
  -- target's own status happens to be).
  IF v_product.status IN ('archived', 'removed') THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'product_archived_or_removed');
  END IF;

  IF v_target.status = 'checking' THEN
    RETURN jsonb_build_object('result', 'checking');  -- already in flight, do not create another request
  ELSIF v_target.status = 'paused' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'paused_requires_resume');
  ELSIF v_target.status = 'failed' THEN
    RETURN jsonb_build_object('result', 'invalid_status', 'reason', 'failed_requires_resume');
  END IF;
  -- Only (parent active, target active) reaches here.

  IF v_target.manual_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_queued', 'manual_request_token', v_target.manual_request_token);
  END IF;

  IF v_target.last_checked_at IS NOT NULL
     AND v_target.last_checked_at > now() - make_interval(secs => p_cooldown_seconds) THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_seconds', p_cooldown_seconds - extract(epoch FROM now() - v_target.last_checked_at)::int);
  END IF;

  -- Lock order step 5: count outstanding requests and queue atomically.
  -- The advisory lock was already acquired first (above), so this count
  -- can't race a concurrent queue_pincode_manual_check call for a
  -- DIFFERENT target in the same workspace+marketplace.
  --
  -- "Outstanding" per DATA_MODEL.md sec2c: queued (manual_requested_at set,
  -- not yet checking) OR checking (manual_requested_at set, status =
  -- 'checking'). Both count.
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
-- 5. claim_due_pincode_targets
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_due_pincode_targets(
  p_limit                  integer,   -- bounded chunk size, NOT a large up-front batch -- sec2.9
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
    -- Step 1: rank candidates. Plain read, no lock -- Postgres is free to
    -- plan this however it likes against the due-index (DATA_MODEL.md sec3).
    -- Joins the PARENT product and filters p.status='active' -- a target's
    -- own status enum has no 'archived' value (DATA_MODEL.md sec2 Correction
    -- 13), so "is this claimable" genuinely requires the parent join, not
    -- a column on the target row alone. Also filters the allowlist here
    -- (Correction 4) so non-allowlisted workspaces never even become
    -- ranking candidates. Carries monitored_product_id out of this CTE too
    -- -- needed to drive the parent-locking step below.
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
      AND p.workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (t.workspace_id = ANY (p_excluded_workspace_ids))
  ),
  ranked_ids AS (
    -- Step 2: exactly one target per workspace this fairness round (rn=1).
    -- Ordered by has_manual_request DESC, next_check_at ASC globally, then
    -- workspace_id/id only as a deterministic tie-break -- manual requests
    -- must be globally preferred, not just within their own workspace slot.
    SELECT id, monitored_product_id FROM candidates
    WHERE rn = 1
    ORDER BY has_manual_request DESC, next_check_at ASC, workspace_id, id
    LIMIT p_limit
  ),
  locked_parents AS (
    -- Lock order step 2 (sec2.0) applied for real: lock the DISTINCT
    -- eligible PARENT rows FIRST, ordered by id -- this is the real
    -- serialization point against enroll_pincode_monitored_products /
    -- set_pincode_tracking_state / remove_pincode_monitored_products / the
    -- archival reconciliation pass, every one of which also locks the
    -- parent before any target per the same global lock order. Deliberately
    -- plain FOR UPDATE, NOT SKIP LOCKED: skipping a locked parent would
    -- silently drop every one of its candidate targets from this chunk with
    -- no signal at all, whereas every parent-touching transaction in this
    -- schema is a short, single-row UPDATE -- briefly waiting for one to
    -- commit and then re-reading the fresh status is the correct, safe
    -- behavior, not a real stall risk.
    SELECT p.id, p.status, p.workspace_id
    FROM public.pincode_monitored_products p
    WHERE p.id IN (SELECT DISTINCT monitored_product_id FROM ranked_ids)
    ORDER BY p.id
    FOR UPDATE
  ),
  eligible_parents AS (
    -- Revalidate AFTER the parent lock -- status and allowlist/exclusion
    -- membership are re-checked against the fresh, now-locked value, not
    -- the unlocked read from step 1. A parent an archive/remove
    -- transaction just committed against is caught here and excluded.
    SELECT id FROM locked_parents
    WHERE status = 'active'
      AND workspace_id = ANY (p_allowed_workspace_ids)
      AND NOT (workspace_id = ANY (p_excluded_workspace_ids))
  ),
  locked_targets AS (
    -- Lock order step 3: lock the corresponding TARGET rows SECOND,
    -- ordered by id, restricted to targets whose parent survived
    -- revalidation above. FOR UPDATE OF t SKIP LOCKED is correct here --
    -- a target-row lock held by a concurrent claim/mutation is the
    -- ordinary SKIP LOCKED contention case (lose one row, not a
    -- correctness gap), unlike skipping an entire locked parent above.
    -- Revalidates the target itself too -- still 'active', still due,
    -- still actually pointing at a locked, still-active parent (same
    -- non-locking-lookup-then-lock-then-revalidate discipline as
    -- finalize_pincode_check, sec2.7).
    SELECT t.id FROM public.pincode_tracking_targets t
    WHERE t.id IN (
      SELECT r.id FROM ranked_ids r
      JOIN eligible_parents ep ON ep.id = r.monitored_product_id
    )
      AND t.status = 'active'
      AND t.next_check_at IS NOT NULL AND t.next_check_at <= now()
      AND t.monitored_product_id IN (SELECT id FROM eligible_parents)
    ORDER BY t.id
    FOR UPDATE OF t SKIP LOCKED
  )
  -- Step 7: update only targets that survived both the parent lock/
  -- revalidation and the target lock/revalidation.
  UPDATE public.pincode_tracking_targets t
  SET status = 'checking',
      claimed_at = now(),
      claimed_by = p_invocation_id,
      claim_token = gen_random_uuid()
  FROM locked_targets
  WHERE t.id = locked_targets.id
  RETURNING t.*;
  -- Returns only rows successfully updated -- if a parent was locked by a
  -- concurrent transaction and its status changed, if SKIP LOCKED dropped
  -- some targets because a concurrent invocation already held their lock,
  -- or the revalidation predicates excluded some because their
  -- eligibility changed since ranking, fewer than p_limit rows come back
  -- -- never an incorrect double-claim, never a claim of a row whose
  -- parent is no longer active.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_pincode_targets(integer, text, uuid[], uuid[]) TO service_role;

-- ============================================================
-- 6. finalize_pincode_check
-- ============================================================
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
  -- PINCODE_SCHEDULER_MAX_CONSECUTIVE_FAILURES default (sec2.5). The spec's
  -- RPC signature has no dedicated parameter for this -- documented here,
  -- next to the arithmetic that uses it, per sec2.2's "document the
  -- resulting calculation directly in code comments" discipline.
  v_max_failures    CONSTANT integer := 5;
BEGIN
  -- Correction 11 (round 3), rewritten NULL-safe per round-4 Correction 1:
  -- validate the input combination FIRST, before any lookup or write -- an
  -- invalid combination is a caller bug, not a legitimate race, and must
  -- never reach the database in any row.
  --
  -- Round-4 fix: Postgres uses three-valued logic -- `x NOT IN (...)` and
  -- `x IN (...)` both evaluate to NULL (neither TRUE nor FALSE) when x IS
  -- NULL, and an `IF` condition that evaluates to NULL is treated as FALSE
  -- by plpgsql -- meaning `IF p_check_status NOT IN (...)` with
  -- p_check_status = NULL would NOT raise, silently letting a NULL
  -- check_status fall through every branch below undetected. Every branch
  -- now starts with an explicit `IS NULL` test before any `IN (...)`
  -- comparison, so a NULL input can never silently pass through.
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

  -- Step 1: idempotency check FIRST. If this exact attempt already
  -- recorded a result (a retried finalize call after the app lost the
  -- original response, but the transaction had already committed),
  -- return it immediately -- no lookup, no lock, no insert, nothing else.
  SELECT * INTO v_existing FROM public.pincode_availability_results
    WHERE check_attempt_id = p_claim_token;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Round-4 Correction 2 (global lock order, sec2.0): a NON-LOCKING lookup
  -- identifies which parent to lock, BEFORE any row is locked -- this is
  -- what lets step 3 below lock the parent first, then the target second,
  -- rather than a target-first order (which could deadlock against other
  -- RPCs that always lock parent-then-target).
  SELECT monitored_product_id INTO v_lookup_product_id
    FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking';

  IF NOT FOUND THEN
    -- Correction 10: do NOT immediately conclude "stale." A concurrent
    -- finalize call for the SAME still-valid token may have already
    -- committed between this call's step 1 and this lookup. Re-check for
    -- the result a second time before deciding.
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;  -- legitimate concurrent duplicate -- same result, not an error
    END IF;
    -- Genuinely stale: this claim_token was reclaimed (stale-claim
    -- reclaim, sec2.4) and possibly already re-claimed by a different
    -- attempt. Do NOT insert a result, do NOT touch any target.
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  -- Step 3 (lock order step 2): lock the PARENT first. Correction 4/5 --
  -- the target's own status enum has no 'archived' value; archived/
  -- removed is a fact about pincode_monitored_products, locked here so the
  -- scheduling decision below can react to a mid-flight archive/removal
  -- correctly, and so this RPC follows the same parent-before-target order
  -- as every other RPC in this document (sec2.0).
  SELECT * INTO v_product FROM public.pincode_monitored_products
    WHERE id = v_lookup_product_id
    FOR UPDATE;

  -- Step 3 continued (lock order step 3): lock the TARGET second, and
  -- REVALIDATE against the now-locked parent -- claim_token still matches,
  -- status is still 'checking', AND monitored_product_id still equals the
  -- parent just locked.
  SELECT * INTO v_target FROM public.pincode_tracking_targets
    WHERE claim_token = p_claim_token AND status = 'checking'
      AND monitored_product_id = v_product.id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Something changed between the non-locking lookup and this lock
    -- (e.g. reclaimed in the interim) -- same re-check-then-stale
    -- discipline as above, never assume stale without checking for a
    -- legitimate concurrent duplicate first.
    SELECT * INTO v_existing FROM public.pincode_availability_results
      WHERE check_attempt_id = p_claim_token;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'stale_check_attempt' USING ERRCODE = 'P0001';
  END IF;

  -- Step 4: insert the one result row this attempt owns, now that the
  -- target lock proves this claim_token is still valid. The result is
  -- recorded regardless of parent status -- a real check ran and
  -- completed; that fact is never discarded.
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

  -- Step 5: compute the target's next state.
  IF v_product.status IN ('archived', 'removed') THEN
    -- Correction 5: parent went archived/removed while this check was in
    -- flight -- finalize to paused, never reschedule a product that's no
    -- longer active.
    v_next_status := 'paused';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures;  -- unchanged; this isn't a failure
  ELSIF p_check_status = 'blocked' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours * 2 || ' hours')::interval;  -- sec2.6
    v_consecutive := v_target.consecutive_failures;  -- blocked does not increment failures, sec2.6
  ELSIF p_check_status = 'failed' AND v_target.consecutive_failures + 1 >= v_max_failures THEN
    v_next_status := 'failed';
    v_next_check_at := NULL;
    v_consecutive := v_target.consecutive_failures + 1;
  ELSIF p_check_status = 'failed' THEN
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;  -- sec2.5, flat retry delay
    v_consecutive := v_target.consecutive_failures + 1;
  ELSE
    v_next_status := 'active';
    v_next_check_at := now() + (v_target.cadence_hours || ' hours')::interval;
    v_consecutive := 0;
  END IF;

  -- Step 6: finalize the SAME target this attempt validated in step 2 --
  -- clear all claim fields, clear manual-request fields (this was either a
  -- scheduled or manual check either way; both clear the same way).
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

  -- Step 7: insert + product lock + update commit together or not at all
  -- (implicit transaction, same function body).
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_pincode_check(uuid, text, text, text, text, text) TO service_role;

notify pgrst, 'reload schema';
