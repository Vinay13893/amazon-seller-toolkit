-- Pincode Checker P0-A, migration 1 of 4: precondition composite-FK-target
-- constraints on two existing, in-use tables. Additive only -- both columns
-- are already unique via each table's own primary key, so exposing
-- (workspace_id, id) as a UNIQUE constraint locks no rows and rewrites no
-- data. This lets 061's new tables reference the SAME-WORKSPACE row, not
-- merely an existing row in any workspace, via a real composite foreign key.
-- See PINCODE_UNIFIED_PAGE_DATA_MODEL.md sec2 Correction 2.

ALTER TABLE public.amazon_listing_items
  ADD CONSTRAINT amazon_listing_items_workspace_id_uidx UNIQUE (workspace_id, id);

ALTER TABLE public.tracked_asins
  ADD CONSTRAINT tracked_asins_workspace_id_uidx UNIQUE (workspace_id, id);

notify pgrst, 'reload schema';
