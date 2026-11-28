-- Seller-fulfilled availability from the read-only Listings Items API.
-- Null means the API did not confirm one unambiguous DEFAULT-channel quantity.
alter table public.amazon_listing_items
  add column if not exists mfn_available_quantity integer
  check (mfn_available_quantity >= 0);

alter table public.amazon_listing_items
  add column if not exists mfn_inventory_checked_at timestamptz;
