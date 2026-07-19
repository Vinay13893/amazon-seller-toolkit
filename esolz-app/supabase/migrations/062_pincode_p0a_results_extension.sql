-- Pincode Checker P0-A, migration 3 of 4: additive columns on the EXISTING,
-- already-populated pincode_availability_results table (016_scraping_jobs_
-- foundation.sql) so the new unified scheduler can write into it without
-- disturbing the legacy bulk-checker's own rows or its 5 downstream
-- consumers (pincode_checks is untouched, out of scope).
--
-- Deliberately NOT included here: the check_status-format CHECK constraint
-- (CHECK (check_status IN ('success','failed','blocked'))). That constraint
-- is gated on a backfill of existing rows and stays its own, separate,
-- reviewed migration per DATA_MODEL.md sec4a/sec7 -- this migration only
-- adds columns/FKs/indexes and the two CHECK constraints that are
-- structurally satisfied by every existing row today (all four new columns
-- are NULL on every legacy row).

ALTER TABLE public.pincode_availability_results
  ADD COLUMN monitored_product_id uuid,
  ADD COLUMN tracking_target_id   uuid,
  ADD COLUMN check_attempt_id     uuid,
  ADD COLUMN check_status         text;

-- RESTRICT, not SET NULL: pincode_monitored_products/pincode_tracking_targets
-- are THIS feature's own tables and are never hard-deleted in normal
-- operation (soft removal only, DATA_MODEL.md sec2/sec3b) -- a hard DELETE
-- against either is not a normal event this schema should silently absorb.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_monitored_product_fk
  FOREIGN KEY (workspace_id, monitored_product_id)
  REFERENCES public.pincode_monitored_products (workspace_id, id)
  ON DELETE RESTRICT;

-- Composite FK against the target's OWN composite identity -- proves a
-- result's tracking_target_id and monitored_product_id actually agree with
-- each other, not just that each independently belongs to the right
-- workspace (DATA_MODEL.md sec4 Correction 12).
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_tracking_target_fk
  FOREIGN KEY (workspace_id, tracking_target_id, monitored_product_id)
  REFERENCES public.pincode_tracking_targets (workspace_id, id, monitored_product_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX pincode_availability_results_check_attempt_uidx
  ON public.pincode_availability_results (check_attempt_id)
  WHERE check_attempt_id IS NOT NULL;

CREATE INDEX pincode_availability_results_tracking_target_idx
  ON public.pincode_availability_results (tracking_target_id, checked_at DESC)
  WHERE tracking_target_id IS NOT NULL;

CREATE INDEX pincode_availability_results_monitored_product_idx
  ON public.pincode_availability_results (monitored_product_id, pincode, checked_at DESC)
  WHERE monitored_product_id IS NOT NULL;

-- (A) Identity consistency: the three new ID columns travel together --
-- either a legacy row (all three NULL) or a unified-scheduler row (all
-- three NOT NULL). Trivially satisfied by every existing row today.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_identity_consistency_chk
  CHECK (
    (monitored_product_id IS NULL AND tracking_target_id IS NULL AND check_attempt_id IS NULL)
    OR
    (monitored_product_id IS NOT NULL AND tracking_target_id IS NOT NULL AND check_attempt_id IS NOT NULL)
  );

-- (B) New-row result consistency: only fires when check_attempt_id IS NOT
-- NULL -- legacy rows are entirely outside this constraint's scope. Every
-- branch below uses an explicit IS NOT NULL/IS NULL test before any IN (...)
-- comparison (NULL-safe per DATA_MODEL.md sec4 round-4 Correction 1) --
-- Postgres CHECK constraints pass on NULL, not just TRUE, so `x IN (...)`
-- alone would have silently accepted a NULL check_status.
ALTER TABLE public.pincode_availability_results
  ADD CONSTRAINT pincode_availability_results_new_row_consistency_chk
  CHECK (
    check_attempt_id IS NULL
    OR (
      check_status IS NOT NULL
      AND (
        (
          check_status = 'success'
          AND availability_status IS NOT NULL
          AND availability_status IN ('available', 'unavailable', 'unknown')
        )
        OR
        (
          check_status IN ('failed', 'blocked')
          AND availability_status IS NULL
        )
      )
    )
  );

notify pgrst, 'reload schema';
