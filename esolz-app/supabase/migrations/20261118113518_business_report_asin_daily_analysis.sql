-- One analysis row per workspace, marketplace, calendar day, and child ASIN.
-- The source remains the detailed SKU-grain audit table populated by SP-API.

create index if not exists internal_business_report_sku_sales_traffic_asin_date_idx
  on public.internal_business_report_sku_sales_traffic (
    workspace_id, marketplace_id, child_asin, report_date desc
  )
  where child_asin is not null and btrim(child_asin) <> '';

create or replace view public.internal_business_report_asin_daily
with (security_invoker = true)
as
select
  workspace_id,
  marketplace_id,
  report_date,
  child_asin as asin,
  min(parent_asin) filter (where parent_asin is not null and btrim(parent_asin) <> '') as parent_asin,
  count(distinct sku_norm) filter (where sku_norm is not null and btrim(sku_norm) <> '')::integer as sku_count,
  array_agg(distinct sku order by sku) filter (where sku is not null and btrim(sku) <> '') as skus,
  sum(ordered_product_sales) as ordered_product_sales,
  sum(ordered_product_sales_b2b) as ordered_product_sales_b2b,
  sum(units_ordered)::bigint as units_ordered,
  sum(units_ordered_b2b)::bigint as units_ordered_b2b,
  sum(total_order_items)::bigint as total_order_items,
  sum(total_order_items_b2b)::bigint as total_order_items_b2b,
  min(source_report_id) as source_report_id,
  max(updated_at) as last_synced_at
from public.internal_business_report_sku_sales_traffic
where child_asin is not null and btrim(child_asin) <> ''
group by workspace_id, marketplace_id, report_date, child_asin;

revoke all on table public.internal_business_report_asin_daily from anon, authenticated;
grant select on table public.internal_business_report_asin_daily to authenticated;

comment on view public.internal_business_report_asin_daily is
  'One analysis row per workspace, marketplace, report date, and child ASIN. Sales and units are summed across all seller SKUs attached to the ASIN. Reads use the source table RLS via security_invoker.';
