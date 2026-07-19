-- Pincode Checker P0-A, migration 1 of 4: precondition composite-FK-target
-- constraints on two existing, in-use tables. Additive-only in the sense
-- that no existing column, row, or data value changes -- but this is NOT a
-- lock-free operation, and the round-6 correction below fixes a prior
-- misleading comment that called it one.
--
-- Correction (2026-07-18, PR #54 review round): "locks no rows" was
-- imprecise and could mislead an operator into treating this as risk-free
-- at any scale. What is actually true: (workspace_id, id) is already
-- logically unique on both tables (via each table's own PRIMARY KEY on
-- `id` alone, which is already unique per-table, so no two rows can share
-- an id let alone a (workspace_id, id) pair) -- so this ALTER TABLE ...
-- ADD CONSTRAINT ... UNIQUE cannot ever find or reject a duplicate. What
-- it DOES do, like any ADD CONSTRAINT UNIQUE without USING an existing
-- index: build a new B-tree index over the full table, and hold an
-- ACCESS EXCLUSIVE lock on the table for the duration of that build (this
-- form of ADD CONSTRAINT does not support CONCURRENTLY -- Postgres has no
-- "ADD CONSTRAINT ... UNIQUE CONCURRENTLY"; the closest lock-minimizing
-- pattern is CREATE UNIQUE INDEX CONCURRENTLY followed by ADD CONSTRAINT
-- ... UNIQUE USING INDEX, which trades a longer total wall-clock window
-- for avoiding the exclusive lock -- not used here because, per the sizes
-- below, the plain form's lock window is already negligible).
--
-- Confirmed production table sizes (read-only audit, 2026-07-18, PR #54
-- review round -- see BRAHMASTRA_MASTER_TRACKER.md sec22 update 7 for the
-- full audit record): `amazon_listing_items` 482 rows, `tracked_asins` 19
-- rows. At this size the index build and the ACCESS EXCLUSIVE lock it
-- requires are sub-second; this is not a large-table migration and does
-- not need CONCURRENTLY's extra complexity to be safe. This sizing is
-- re-confirmed as current at apply time, not assumed to still hold if
-- applied much later.
--
-- Operational guidance for whoever applies this migration (still NOT
-- applied by this PR -- P0-A ships schema/RPCs only, see the PR
-- description and BRAHMASTRA_MASTER_TRACKER.md sec22):
-- 1. Recommended low-traffic application window: any time is low-risk at
--    482/19 rows, but if applied alongside a larger future migration in
--    the same window, prefer off-peak hours as a general discipline for
--    any ACCESS EXCLUSIVE-taking DDL against these two tables, since both
--    are read on nearly every authenticated page load in the app.
-- 2. Preflight duplicate check (expected to return zero rows, verifying
--    the "already unique via PK" reasoning above rather than assuming it):
--      SELECT workspace_id, id, count(*) FROM public.amazon_listing_items
--        GROUP BY workspace_id, id HAVING count(*) > 1;
--      SELECT workspace_id, id, count(*) FROM public.tracked_asins
--        GROUP BY workspace_id, id HAVING count(*) > 1;
-- 3. Statement/lock-timeout strategy: wrap the ALTER TABLE statements with
--    a bounded lock_timeout so a stuck lock acquisition fails fast and
--    loud instead of queueing behind (and blocking) other transactions
--    indefinitely -- e.g. `SET LOCAL lock_timeout = '5s';` immediately
--    before each ALTER TABLE, inside the same migration transaction.
-- 4. No production application in this PR -- P0-A is reviewed as a whole
--    before any of its four migrations are applied anywhere.
--
-- This lets 061's new tables reference the SAME-WORKSPACE row, not merely
-- an existing row in any workspace, via a real composite foreign key. See
-- PINCODE_UNIFIED_PAGE_DATA_MODEL.md sec2 Correction 2.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.amazon_listing_items
  ADD CONSTRAINT amazon_listing_items_workspace_id_uidx UNIQUE (workspace_id, id);

ALTER TABLE public.tracked_asins
  ADD CONSTRAINT tracked_asins_workspace_id_uidx UNIQUE (workspace_id, id);

notify pgrst, 'reload schema';
