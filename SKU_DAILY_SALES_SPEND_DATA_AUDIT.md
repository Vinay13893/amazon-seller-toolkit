# SKU Daily Sales & Ad Spend — Data Audit (P1-A)

Status: **read-only audit, no code changes, no migrations, no production writes**
Branch: `feature/sku-daily-sales-spend-audit`
Date: 2026-07-22 (original), **amended 2026-07-22 — Review Correction Round ("Update 2")**
Author: Claude Code, on explicit founder instruction

## 0. What this document is

A read-only inspection of the *actual* tables, columns, importers, and sync jobs already in
this repository and in the live production database, done **before** any SKU Performance page
code is written. Every fact below was verified either by reading the migration/importer/sync
source in this repo, or by running a read-only `SELECT` against the production Supabase project
(`okxfwcfxxrtmijmvztdq`, "Vinay13893's Project"). No table or column name below is assumed —
every one was found by `grep`/`Read` on the actual migration/source files or confirmed to exist
via `information_schema.tables`.

No migration was applied. No row was inserted, updated, or deleted. No Amazon Ads or sales
calculation anywhere in the app was changed.

**Update 2 (this amendment) — honest disclosure of an evidence gap.** The original audit proved
SKU-count mapping coverage (112/112 distinct advertised SKUs matched) but did not prove
**spend-weighted** mapping coverage, conflated two different coverage concepts, treated per-SKU
absence as "stale" when it may just mean no activity, and understated the real SKU-normalization
inconsistency across pipelines. This round corrects all of that. Every new finding below is
either (a) freshly re-derived from source code with an exact file/line citation, or (b) explicitly
marked **BLOCKED — DB ACCESS UNAVAILABLE THIS ROUND** with the exact ready-to-run SQL provided,
never a fabricated number. See §8 for the full disclosure of what could and could not be
independently re-verified this round and why.

## 1. Context that shapes every conclusion below

This is **not** a generic multi-tenant feature audit. The entire `internal_*` table family (Ads
reports, Business Reports, settlement transactions, SKU cost master, geo-sales) that this page
would draw on is a **single-team internal operations toolkit**, gated by RLS to one specific
account (`test2026@sociomonkey.com`) or workspaces on the "Internal Tester" subscription plan —
confirmed directly in every one of those tables' RLS policies. Migration 049's own comment
states the Amazon Ads OAuth connection carries 9 advertiser profiles, but only one —
`1119208106810251` / **EMOUNT RETAIL** — is actually selected and synced for this tooling.

Querying production directly confirmed this is not theoretical (original round):

```sql
select (select count(*) from workspaces) as workspaces_total,
       (select count(*) from amazon_ads_profiles) as ads_profiles_total,
       (select count(distinct workspace_id) from internal_ads_advertised_product_daily_rows) as ads_workspaces_with_data;
-- workspaces_total=3, ads_profiles_total=9, ads_workspaces_with_data=1
```

**Exactly one workspace** (`55a321c9-7729-4662-a494-9f1f1aa86846`, workspace name `"My Workspace"`,
plan `Free`) has any real Ads-spend or Business-Report data at all. Every number in this audit —
row counts, date ranges, mapping percentages — is computed against **that** workspace, because
it is the only one with anything to audit. The "SKU Performance" page's filters (workspace,
marketplace) exist for future-proofing, but in practice this is a single-workspace,
single-marketplace (`A21TJRUUN4KGV`, Amazon.in, currency `INR`, Ads profile timezone
`Asia/Kolkata`) tool today, same as the existing Internal Stock Action Dashboard
(`/dashboard/internal`) and Brahmastra diagnostic (`/dashboard/internal/easyhome-diagnostic`) it
will sit alongside.

## 2. Source matrix

| Metric | Actual source | Table | Join key | Granularity | Freshness (live, 2026-07-22) | Coverage | Known gap | Safe to display | Required label |
|---|---|---|---|---|---|---|---|---|---|
| Seller SKU | SP-API Listings Items sync | `amazon_listing_items.sku` | `(workspace_id, sku, marketplace_id)` UNIQUE | 1 row per SKU | last synced **2026-06-29** (23 days stale) | 462 SKUs, 1 workspace | Table enforces **one SKU per row**, and a **partial UNIQUE index on `(workspace_id, asin, marketplace_id)` also forbids two rows sharing an ASIN**. §3e now documents the **verified, code-evidenced** real behavior when this is hit (previously stated as an assumption — corrected) | Yes, for SKU text itself | none |
| ASIN | Same sync | `amazon_listing_items.asin` | same | same | same (23 days stale) | 462/462 rows have `asin` populated (100%) | See §3e | Yes | none |
| Product title / image | Same sync | `amazon_listing_items.item_name`, `.image_url`, `.brand` | `sku` | same | **23 days stale** | title 462/462 (100%), image 462/462 (100%), brand 412/462 (89%) | Any SKU added/renamed/re-imaged in Seller Central in the last 23 days will show stale or missing metadata. **This is a catalog-metadata freshness fact only — see §3f, it does not mean any SKU's sales/spend activity is stale** | Yes, with a visible "as of &lt;last_synced_at&gt;" caption | "Catalog data as of {date}" |
| Daily ordered sales | SP-API `GET_SALES_AND_TRAFFIC_REPORT`, ASIN/SKU granularity | `internal_business_report_sku_sales_traffic.ordered_product_sales` | `(workspace_id, marketplace_id, report_date, sku_norm\|child_asin\|parent_asin)` | 1 row/workspace/marketplace/date/SKU | latest date **2026-07-21** (fresh — yesterday) | 4,500 rows, 232 distinct SKUs, date range 2026-06-15 → 2026-07-21 (**~5.5 weeks of history**, not 90 days) | Order-date based ("Ordered Product Sales"), a **different number** from settlement Net Sales — must never be silently merged with `internal_payment_transactions` (explicit comment in migration 052) | Yes | "Ordered sales (order date)" |
| Daily units | Same report | `internal_business_report_sku_sales_traffic.units_ordered` | same | same | same | same | same | Yes | none |
| Sessions | Same report | `internal_business_report_sku_sales_traffic.sessions`, `.page_views` | same | same | same | same | Nullable column; not populated for every row (not separately re-verified per-row here) | Yes, treat NULL as "not reported," never 0 | none |
| Advertising spend | Amazon Ads Reporting API v3, `spAdvertisedProduct` report, DAILY | `internal_ads_advertised_product_daily_rows.spend` | `(workspace_id, profile_id, dedupe_key)`, `advertised_sku`/`advertised_asin` columns | 1 row/workspace/profile/date/campaign/ad-group/advertised-SKU | latest date **2026-07-21** (fresh) | 24,608 rows total for this workspace; 17,465 `source='ads_api_auto'` (automated) + 7,143 `source='manual_csv_upload'` (historical backfill); date range 2026-06-01 → 2026-07-21 (**~7.3 weeks**, not 90 days) | See attribution-window note below, and §3d for the auto/manual overlap audit | Yes | none |
| Ad-attributed sales | Same report | `internal_ads_advertised_product_daily_rows.sales` | same | same | same | same | **1-day click attribution** (`sales1d`/`purchases1d`/`unitsSoldClicks1d` — confirmed in `amazon-ads-reporting-client.ts` `REPORT_CONFIG.spAdvertisedProduct.columns`), not the 7-day/14-day window the Ads Console UI defaults to for some views | Yes, but must be labeled with the attribution window | "Ad-attributed sales (1-day click)" |
| Currency | Ads profile config | `amazon_ads_profiles.currency_code` | `profile_id` | per profile | static | all 9 profiles for this workspace are `INR` | Business Report / sales tables have **no currency column at all**. See §5/§8 Correction 8 — currency must be read from the authorized Ads profile context at request time, never hardcoded | Yes, single currency observed today | currency returned by the API from profile context, not hardcoded |
| Marketplace | Ads profile / Business Report / listing sync, each independently | `amazon_ads_profiles.marketplace_id`, `internal_business_report_sku_sales_traffic.marketplace_id`, `amazon_listing_items.marketplace_id` | — | — | — | All observed rows for this workspace are `A21TJRUUN4KGV` (Amazon.in) | Three independent marketplace_id columns, never cross-validated against each other by any existing code | Yes | none |
| Account/workspace | `workspaces.id` | every table above | `workspace_id` | — | — | 1 of 3 workspaces has real data | — | Yes | none |
| Report date / timezone | Ads report `date` column (Amazon Ads Reporting API v3, DAILY `timeUnit`); Business Report `report_date` (SP-API) | both tables' `report_date` | civil date | daily | — | — | **Neither pipeline's code explicitly converts or asserts a timezone for the `date` field.** Not independently proven — see §5/§8 Correction 8, now a required pre-production verification checkpoint | Internal-only, behind a verification checkpoint | "Dates shown in Asia/Kolkata" (assumed, not independently verified — feature gated internal-only until checked) |
| Fulfillment type | Settlement/Transaction Report | `internal_payment_transactions.fulfillment` (`'Amazon'`/`'Merchant'`) | `sku_norm` | per transaction | latest date **2026-06-23 — 29 days stale** | 56,595 `'Amazon'` + 23,445 `'Merchant'` + 9,758 `NULL` (90% populated when present) | The **only** fulfillment-type source is a table that is a month stale. The purpose-built derived table for this (`amazon_sku_geo_sales_daily.fulfillment_bucket`) has **zero rows for this workspace** | **No — not for "yesterday" or "7-day" windows.** | "Fulfillment type — last updated {29+ days ago}, may not reflect recent SKUs" |
| Product/category mapping | Two independent, non-identical sources | `amazon_listing_items.product_type`, `internal_sku_cost_master.category` | `sku_norm` (see §3e — the *actual* normalization differs per source) | — | cost master unknown last-updated cadence; catalog 23 days stale | `internal_sku_cost_master`: 400/462 SKUs (87%) have a category, all with a category once present (400/400) | Two different "category" concepts are **not the same field** and must not be silently merged | Yes, but label which source, don't blend | "Category (internal)" vs "Product type (Amazon)" — pick one, do not merge |

## 3. Join and mapping audit

### 3a. SKU-count mapping coverage (original evidence, unchanged, re-labeled)

**This is a count of distinct SKUs, not a measure of spend.** Renamed explicitly per Correction 1
so it is never confused with spend-weighted coverage (§3b).

Confirmed by reading `esolz-app/src/lib/internal/amazon-ads-reporting-client.ts`
(`REPORT_CONFIG.spAdvertisedProduct.columns` includes `advertisedAsin`, `advertisedSku` as
first-class report columns) and `esolz-app/scripts/sync-ads-reports.ts`
(`deepReportRowFor(...)` writes both `advertised_asin` and `advertised_sku` straight from the
Amazon report row, no derivation): **the join is direct, Amazon-reported SKU → SKU text match**
against `amazon_listing_items.sku`.

```sql
-- All-time distinct (advertised_sku, advertised_asin) pairs vs. the catalog table
with ads as (
  select distinct advertised_sku, advertised_asin
  from internal_ads_advertised_product_daily_rows
  where workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846'
),
li as (
  select sku, asin from amazon_listing_items where workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846'
)
select count(*) as distinct_ads_sku_asin_pairs_alltime,
       count(*) filter (where li.sku is null) as unmatched_by_sku,
       count(*) filter (where ads.advertised_asin is distinct from li.asin) as sku_matched_but_asin_mismatch
from ads left join li on li.sku = ads.advertised_sku;

-- Result (verified live, original round): distinct_ads_sku_asin_pairs_alltime=112, unmatched_by_sku=0, sku_matched_but_asin_mismatch=0
```

**112 distinct advertised SKUs, all-time, all 112 matched by exact SKU text to
`amazon_listing_items`, zero mismatched ASINs.** `advertised_sku` was never `NULL` in this
dataset.

**Mapped SKU-count coverage = 112/112 = 100%.** This is a count of distinct SKU identities. It
does **not** by itself prove what fraction of ad *spend* is mapped — a single unmapped SKU could
in principle carry a disproportionate share of spend. §3b addresses that directly.

### 3b. Spend-weighted mapping coverage (Correction 1)

**Logical derivation (valid, but not a substitute for a direct query):** row-level mapping state
depends *only* on which of the 112 distinct `advertised_sku` values a row belongs to (the mapping
state is a function of the SKU string alone, not of the row's date or amount). Since §3a already
proved, exhaustively, that **all 112** distinct SKUs are mapped with zero unmapped and zero
ASIN-mismatched, **every row** in `internal_ads_advertised_product_daily_rows` for this workspace
must belong to a mapped SKU. It follows that mapped-spend share = 100% of total spend, in every
time window, as a logical corollary — not because spend was separately summed and compared.

**What could not be independently verified this round:** the exact currency totals (₹ mapped
spend, ₹ unmapped spend, ₹ conflict spend) per window, and the row-count breakdown, require a
fresh `SUM(spend) ... GROUP BY row_state` query. **This query could not be run this round — the
Supabase MCP read-only SQL tool was gated behind a tool-permission approval that remained blocked
for the duration of this session despite an explicit approval attempt (see §8 for the full
disclosure).** The query below is the exact one that must be run before this percentage is
reported as independently spend-verified, not merely logically derived:

```sql
-- READY TO RUN, NOT YET RUN THIS ROUND — see §8
with base as (
  select
    a.report_date, a.advertised_sku, a.advertised_asin, a.spend, a.sales,
    li.sku as catalog_sku, li.asin as catalog_asin,
    case
      when a.advertised_sku is null then 'unmapped'
      when li.sku is null then 'unmapped'
      when li.asin is distinct from a.advertised_asin then 'identity_conflict'
      else 'mapped'
    end as row_state
  from internal_ads_advertised_product_daily_rows a
  left join amazon_listing_items li
    on li.workspace_id = a.workspace_id and li.sku = a.advertised_sku
  where a.workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846'
),
windows as (
  select 'all_history' as window_name, base.* from base
  union all select 'last_30_days', base.* from base where report_date >= current_date - interval '30 days'
  union all select 'last_7_days', base.* from base where report_date >= current_date - interval '7 days'
  union all select 'yesterday', base.* from base where report_date = current_date - interval '1 day'
)
select window_name, count(*) total_rows,
  count(*) filter (where row_state='mapped') mapped_rows,
  count(*) filter (where row_state='unmapped') unmapped_rows,
  count(*) filter (where row_state='identity_conflict') conflict_rows,
  sum(spend) total_spend,
  sum(spend) filter (where row_state='mapped') mapped_spend,
  sum(spend) filter (where row_state='unmapped') unmapped_spend,
  sum(spend) filter (where row_state='identity_conflict') conflict_spend,
  round(100.0 * sum(spend) filter (where row_state='mapped') / nullif(sum(spend),0), 2) mapped_spend_pct,
  round(100.0 * sum(spend) filter (where row_state='unmapped') / nullif(sum(spend),0), 2) unmapped_spend_pct,
  round(100.0 * sum(spend) filter (where row_state='identity_conflict') / nullif(sum(spend),0), 2) conflict_spend_pct,
  count(distinct advertised_sku) filter (where row_state='mapped') distinct_sku_mapped,
  count(distinct advertised_sku) filter (where row_state='unmapped') distinct_sku_unmapped,
  count(distinct advertised_sku) filter (where row_state='identity_conflict') distinct_sku_conflict
from windows group by window_name;
```

**Best-confidence statement given available evidence:** mapped spend % is **derived at 100%** for
all four windows (all-history / 30-day / 7-day / yesterday) by the logical argument above, with
**0% unmapped and 0% identity-conflict spend derived the same way**. This is reported as
**DERIVED, not directly SQL-verified this round** — flagged honestly rather than presented with
false precision. A P1-A follow-up action (§8) is to run the query above the moment DB access is
restored and replace this derivation with a direct result.

### 3c. Value-weighted sales catalog coverage (Correction 1)

**Also blocked this round for the same reason as §3b.** The original audit only proved
*SKU-count* coverage (229/232 = 98.7% of sales-active SKUs exist in the catalog, §3a's sibling
finding). It did not weight this by sales value, and the 3 missing SKUs could in principle
represent a large or small share of total ordered sales — unknown without a direct query.

```sql
-- READY TO RUN, NOT YET RUN THIS ROUND — see §8
with sales as (
  select sku_norm, sum(ordered_product_sales) as sales_amount, sum(units_ordered) as units
  from internal_business_report_sku_sales_traffic
  where workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846' and sku_norm is not null
  group by sku_norm
),
listing as (
  select distinct upper(trim(sku)) as sku_norm from amazon_listing_items
  where workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846' and sku is not null
)
select
  sum(sales.sales_amount) as total_ordered_sales,
  sum(sales.sales_amount) filter (where listing.sku_norm is not null) as sales_linked_to_catalog,
  sum(sales.sales_amount) filter (where listing.sku_norm is null) as sales_from_missing_catalog_skus,
  round(100.0 * sum(sales.sales_amount) filter (where listing.sku_norm is not null) / nullif(sum(sales.sales_amount),0), 2) as pct_sales_with_catalog_metadata,
  sum(sales.units) as total_units,
  sum(sales.units) filter (where listing.sku_norm is not null) as units_linked_to_catalog,
  round(100.0 * sum(sales.units) filter (where listing.sku_norm is not null) / nullif(sum(sales.units),0), 2) as pct_units_with_catalog_metadata
from sales left join listing on listing.sku_norm = sales.sku_norm;
```

**Not reported as a number this round.** Unlike §3b, there is no equivalent airtight logical
shortcut here (3 missing SKUs could plausibly carry disproportionate sales value, so 98.7%
SKU-count coverage cannot be safely assumed to imply ~98.7% value coverage). This is recorded as
**UNKNOWN, blocked on DB access**, not estimated.

### 3d. Auto (`ads_api_auto`) vs. manual-CSV-upload overlap and duplication audit (Correction 2)

**The actual logical identity column, inspected directly rather than assumed:** `dedupe_key`,
built by `buildDedupeKey()`. Two separate implementations exist in this codebase — one per
report shape — and both were read directly:

- `esolz-app/src/lib/internal/ads-campaign-daily-parser.ts:148-170` (campaign-level reports):
  `[reportDate, campaignId ?? campaignName, adGroupName, targeting, matchType, advertisedSku,
  advertisedAsin, searchTerm]`, each part `.trim().toUpperCase()`, joined by `|`.
- `esolz-app/src/lib/internal/ads-deep-report-parser.ts:131-133,248` (the advertised-product
  deep report — the one this page's spend/attributed-sales figures come from):
  `[reportDate, campaignId ?? campaignName, adGroupId ?? adGroupName ?? '', advertisedSku ?? '',
  advertisedAsin ?? '']`, each part `.trim().toUpperCase()`, joined by `|`.

**Is `dedupe_key` source-independent? Yes — proven, not assumed.** The automated sync
(`esolz-app/scripts/sync-ads-reports.ts:429-430`) downloads the Ads Reporting API's JSON rows and
calls `jsonRowsToCsv(jsonRows)` to convert them to CSV text, then feeds that CSV through the
**exact same parser functions** (`parseAdsCampaignDailyReport` / `parseDeepReport`,
`sync-ads-reports.ts:437,472`) used by the manual-CSV-upload import routes
(`esolz-app/src/app/api/internal/ads-deep-reports/import/route.ts`). Both paths call the same
`buildDedupeKey()` on the same field set with the same normalization. There is no
source-conditional branch anywhere in the dedupe-key construction.

**Does the importer/upsert prevent cross-source duplication? Yes — proven by direct code
inspection of the actual write path, not assumed.** Both the automated sync
(`upsertByDedupeKey()`, `sync-ads-reports.ts:287-321`) and the manual-CSV import route
(`ads-deep-reports/import/route.ts:186-222`) use the **identical pattern**:
1. `SELECT id, dedupe_key FROM <table> WHERE workspace_id = ? AND profile_id = ?` — **not**
   filtered by `source` — building a map of every existing `dedupe_key` regardless of which
   source wrote it.
2. For each new row: if its `dedupe_key` is already in that map, **UPDATE the existing row by
   `id`** (`.upsert(row, { onConflict: 'id' })`) — overwriting all its columns, including
   `source` itself. If not, **INSERT** a new row.

**Which record is retained, or can both coexist?** Exactly one row per `dedupe_key` can ever
exist — this is structurally guaranteed by the SELECT-by-dedupe_key-then-branch logic above, not
merely by a database constraint (there is in fact no `UNIQUE` constraint enforcing this at the DB
level for this exact column combination in a way that would reject a duplicate INSERT outright —
the application code itself is what prevents it, by always checking first). Whichever sync ran
**most recently** for a given logical row wins: its field values (including `source`) overwrite
whatever was there before. Two rows for the same logical entity, one tagged `manual_csv_upload`
and one tagged `ads_api_auto`, **cannot coexist** — the later one always replaces the earlier one
in place.

**Where exact equivalence cannot be proven — schema differences between the two paths, stated
explicitly per the instruction:** the deep-report `dedupe_key` falls back from `campaignId` to
`campaignName` when `campaignId` is absent (`ads-deep-report-parser.ts:248`,
`campaignId ?? campaignName`). The automated JSON path's Amazon Ads API request explicitly
includes `campaignId` as a report column (`amazon-ads-reporting-client.ts`,
`REPORT_CONFIG.spAdvertisedProduct.columns`), so the auto path's `campaignId` should always be
present. **Whether a manually-downloaded Amazon Ads Console CSV export always includes a Campaign
Id column was not independently confirmed in this audit** — no sample manual-upload CSV file
exists in this repository to inspect, and this fact cannot be established from the application
code alone. **If a manual CSV export ever omits Campaign Id while the automated JSON path
supplies a real one, their computed `dedupe_key`s for the same real-world campaign/ad-group/SKU/
day would diverge (one keyed by campaign name, the other by campaign ID)**, and the two rows
would **not** collide on the SELECT-by-dedupe_key check — both would be retained as separate
rows, which **would** double-count that row's spend and attributed sales if summed naively.

**Overlap date range, duplicated-row/spend/sales counts:** the *structural* proof above shows
duplication is prevented **when both paths compute identical keys**. The **quantitative**
question — did this codebase's manual-upload backfill (7,143 rows, `source='manual_csv_upload'`)
and the automated sync (17,465 rows, `source='ads_api_auto'`) ever actually cover overlapping
report dates, and if so did their `campaignId` presence differ enough to produce two keys for one
real row — requires a direct query and **could not be run this round** (§8). Ready-to-run query:

```sql
-- READY TO RUN, NOT YET RUN THIS ROUND — see §8
select
  (select min(report_date) from internal_ads_advertised_product_daily_rows where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and source='manual_csv_upload') as manual_min_date,
  (select max(report_date) from internal_ads_advertised_product_daily_rows where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and source='manual_csv_upload') as manual_max_date,
  (select min(report_date) from internal_ads_advertised_product_daily_rows where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and source='ads_api_auto') as auto_min_date,
  (select max(report_date) from internal_ads_advertised_product_daily_rows where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and source='ads_api_auto') as auto_max_date;
-- If the two ranges overlap, additionally re-run a same-day count grouped by source to see
-- whether BOTH sources have rows for the same report_date (which the dedupe-key logic above
-- would already have collapsed to one row each if their keys matched) -- a same-day presence of
-- both sources' rows for a date range is expected and NOT itself evidence of a problem, since
-- the current row for that date+SKU is simply whichever source synced it most recently.
```

**Conservative P1-B aggregation rule (required, since exact equivalence is not proven):** the
P1-B aggregation RPC must **never** assume `source` is a safe partition to sum across separately
(i.e., never compute "manual total + auto total" as if they were additive — they are not two
parallel datasets, they are one deduplicated dataset that happens to record which source wrote
each row's *current* value). The RPC must sum `spend`/`sales` **once per row of the single
`internal_ads_advertised_product_daily_rows` table**, exactly as the table stands after
dedupe-key upserts — never re-derive a "combined" total from the two `source` values as if they
were separate feeds needing addition. This is already the physically correct behavior of a plain
`SUM(spend) ... WHERE workspace_id = ? AND report_date BETWEEN ? AND ?` query with no `GROUP BY
source` — the risk this correction protects against is a *future* implementation mistake (e.g.
someone building two separate cards for "manual spend" and "auto spend" and adding them), not a
defect in the straightforward sum.

### 3e. SKU normalization and identity-conflict audit (Correction 7)

**Canonical join key used by this audit's own mapping query (§3a): raw, unnormalized SKU text**
(`amazon_listing_items.sku = internal_ads_advertised_product_daily_rows.advertised_sku`, no
`UPPER()`/`TRIM()` applied on either side). This worked (100% match) only because the live data
happens to have no case/whitespace divergence between the two raw columns — it is not proof that
raw-text matching is safe in general.

**The actual normalization formulas in use, read directly from source — they are NOT
consistent across pipelines:**

| Source | Persisted `sku_norm`? | Exact formula (file:line) |
|---|---|---|
| `internal_business_report_sku_sales_traffic.sku_norm` | Yes | `row.sku.toLocaleUpperCase('en-US')` — uppercase only, **no trim** (`esolz-app/scripts/sync-business-reports.ts:154`) |
| `internal_sku_cost_master.sku_norm` | Yes | `normalizedKey(sku)` = `sku.toLocaleUpperCase('en-US')` — same formula as above (`esolz-app/src/lib/internal/sku-component-mapping-parser.ts:76-78`, called from `esolz-app/src/app/api/internal/stock-actions/cost-master/import/route.ts:39`) |
| `seller_central_sales_rows.amazon_sku_norm` | Yes | `skuRaw.toUpperCase().slice(0, 200)` — uppercase + **200-char truncation**, no explicit trim call (`esolz-app/src/lib/internal/seller-central-sales-csv.ts:139`) |
| `internal_ads_advertised_product_daily_rows` — `dedupe_key` component | **No persisted `sku_norm` column at all** | `.trim().toUpperCase()` — trim + uppercase, but only ever used *inside* the joined `dedupe_key` string, never exposed as its own field (`esolz-app/src/lib/internal/ads-deep-report-parser.ts:131-132`) |
| Same table — cost-master category lookup (transient, in-memory, never persisted) | No | `advertisedSku.trim().toUpperCase().replace(/\s+/g, ' ')` — trim + uppercase + **internal-whitespace collapse**, a **third, different** formula from the same file (`esolz-app/src/lib/internal/ads-deep-report-parser.ts:329`) |
| `amazon_listing_items.sku` (the catalog table this audit joins everything against) | **No normalization of any kind** | Raw string, exactly as returned by SP-API (`esolz-app/supabase/migrations/007_amazon_account_data_foundation.sql`) |

**Conclusion: Seller SKU is treated inconsistently across these pipelines.** At least three
distinct normalization formulas exist (`toLocaleUpperCase` no-trim; `.trim().toUpperCase()`
ASCII; `.trim().toUpperCase().replace(/\s+/g,' ')`), plus one pipeline (the catalog table itself
— the join target every other source is matched against) applies **none at all**. This is a real
inconsistency, not a hypothetical one. It happened not to matter in the live data checked (no
divergent casing/whitespace was observed), but a P1-B aggregation RPC must **pick one canonical
normalization** (recommended: `.trim().toUpperCase()`, matching the Ads dedupe-key formula, since
that is the pipeline supplying the spend side of the join and the one most directly under this
feature's control) and apply it **consistently on both sides of every join**, rather than
inheriting whichever inconsistent convention each source happened to use.

**Collision/conflict quantification — blocked this round, ready query provided (§8):**

```sql
-- READY TO RUN, NOT YET RUN THIS ROUND — see §8
-- 1) Normalization collisions within the catalog table itself
select upper(trim(sku)) as sku_norm, count(*) as raw_variants, array_agg(distinct sku) as raw_skus
from amazon_listing_items
where workspace_id = '55a321c9-7729-4662-a494-9f1f1aa86846'
group by 1 having count(distinct sku) > 1;

-- 2) Sales-SKU / Ads-SKU sets that normalize together but are not exact-match identical
with sales_skus as (
  select distinct sku, upper(trim(sku)) as sku_norm from internal_business_report_sku_sales_traffic
  where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and sku is not null
),
ads_skus as (
  select distinct advertised_sku as sku, upper(trim(advertised_sku)) as sku_norm from internal_ads_advertised_product_daily_rows
  where workspace_id='55a321c9-7729-4662-a494-9f1f1aa86846' and advertised_sku is not null
)
select s.sku as sales_raw_sku, a.sku as ads_raw_sku, s.sku_norm
from sales_skus s join ads_skus a on a.sku_norm = s.sku_norm
where s.sku is distinct from a.sku;
```

**Mapping/identity states — revised per the explicit instruction to drop "ambiguous" unless it
has a concrete, reachable definition:**

| State | Definition | Reachable today? |
|---|---|---|
| `mapped` | `advertised_sku` (normalized) matches exactly one catalog SKU (normalized), and the catalog row's `asin` agrees with `advertised_asin` | Yes — 112/112 observed |
| `unmapped` | `advertised_sku` present, normalized form matches no catalog SKU | Yes (0 observed, but a real, ordinary reachable state — e.g. a brand-new SKU advertised before the next catalog sync) |
| `identity_conflict` | `advertised_sku` (normalized) matches a catalog SKU, but that catalog row's `asin` does **not** agree with `advertised_asin` | **Concrete and reachable** (unlike the old "ambiguous" label) — e.g. a SKU relisted under a different ASIN after the catalog's last sync would produce exactly this state. 0 observed all-time, but not schema-forbidden the way a duplicate-ASIN row was |
| `stale_metadata` | The matched catalog row's data predates a known change (title/brand/image) | **Not currently provable per-row** — `amazon_listing_items` exposes only one shared `last_synced_at` high-water mark for the whole sync run, not a per-row staleness signal distinct from that. Table-wide staleness (23 days) is known; row-specific staleness is not |
| `not_applicable` | No SKU-attributable spend exists outside the `spAdvertisedProduct` report shape used here | n/a — keyword/targeting/search-term reports are separate tables, never blended into SKU-level figures |

The word "ambiguous" is retired from this audit's vocabulary — `identity_conflict` replaces it
with a state that is concretely defined and actually reachable by ordinary account activity (a
relist), not one that is structurally unreachable given today's schema.

**Verified real listing-sync upsert/duplicate-ASIN behavior — corrected from an assumption to a
directly-cited code fact, per the explicit instruction.** The Round 1 audit said a second SKU for
an already-present ASIN "would be silently rejected by the sync upsert" without citing the actual
code. That claim is now verified exactly:

`esolz-app/src/app/api/amazon/sync/listings/process/route.ts:203-211`:
```ts
try {
  await admin.from('amazon_listing_items').upsert(row, { onConflict: 'workspace_id,sku,marketplace_id' })
  pageUpserted++
} catch {
  console.error('[listings/process] listing upsert failed')
}
```

The `upsert`'s `onConflict` target is the **SKU-based** unique constraint
`(workspace_id, sku, marketplace_id)`. A second SKU for an ASIN that's already attached to a
*different* SKU does **not** conflict on that target — Postgres attempts a plain `INSERT`, which
then collides with the **separate** partial unique index
`amazon_listing_items_asin_marketplace_uidx (workspace_id, asin, marketplace_id) WHERE asin IS
NOT NULL` that the `upsert()` call did not declare as its conflict target. This raises a genuine
Postgres unique-violation error (`23505`), which this specific `try/catch` **catches and
discards** — `console.error` only, no rethrow, `pageUpserted` is not incremented, and the loop
continues to the next item. **The real, verified behavior: the second SKU's catalog row is
silently dropped (never written), the first-synced SKU for that ASIN is what remains on file, and
nothing surfaces this failure to any caller or UI.** This confirms the original audit's
characterization was directionally correct, but it is now backed by an exact file/line citation
and the precise mechanism, not an assumption.

### 3f. Sales/spend/catalog coverage (original evidence, unchanged)

```sql
-- sales_sku_count=232, ads_sku_count=112, listing_sku_count=462
-- sales_skus_with_spend=107, sales_skus_without_spend=125
-- sales_skus_in_catalog=229 (3 sales-SKUs missing from the catalog table)
-- spend_skus_without_sales_row=5, ads_skus_in_catalog=112 (100%)
```

- 232 SKUs had at least one sale in the ~5.5-week Business Report window.
- 107/232 (46%) also had ad spend in that window; 125/232 (54%) had none.
- 229/232 (98.7%) of sales-SKUs exist in the catalog table **by SKU-count**; **3 do not** — see
  §3c for why this cannot be assumed to also mean 98.7% *sales value* coverage.
- 5/112 (4.5%) ad-spend SKUs have zero matching sales rows anywhere in the ~5.5-week window.
- 112/112 (100%) ad-spend SKUs exist in the catalog by SKU-count (§3a).

## 4. Data-truth rule verification

Per the explicit instruction, the following are kept as **separate, never-merged facts** in
every source table read above: total ordered sales, ad-attributed sales, ad spend, units, and
ACOS/TACOS — both computed at query time, never read from a stored per-row `acos` column (Amazon's
own per-ad-row figure, not a SKU-level blend — see Product Spec).

**Organic sales.** `Organic sales = Total sales − Ad-attributed sales` is **NOT computed or
displayed** anywhere in this audit's proposed page, because both preconditions remain unmet:
1. **Attribution-window alignment** — Ads uses 1-day click; total sales has no attribution window.
2. **Date-boundary alignment** — not independently proven (§5, §8 Correction 8).

**Never coerce missing→zero.** Carried into the Implementation Plan (§Correction 4's coverage
model) as a locked P1-B constraint, since no RPC exists yet to verify against.

## 5. Timezone, currency, report-date, attribution-window, cancellation/return findings

- **Marketplace / currency**: single marketplace (`A21TJRUUN4KGV`), single currency (`INR`)
  observed. Per Correction 8: currency must be sourced from the authorized Ads profile/account
  context at request time, never hardcoded as an unchangeable application assumption. If a
  requested aggregation ever spans more than one currency, the API must **reject** the
  aggregation outright — never sum mixed currencies, never silently convert.
- **Timezone**: `Asia/Kolkata`, read from `amazon_ads_profiles.timezone`. **Remains unverified**
  — neither pipeline's code independently re-derives or asserts this. Per Correction 8, this is
  now a named **pre-production verification checkpoint**: the Yesterday column, day-over-day
  deltas, and any day-specific alert flag must not be enabled outside internal/disabled status
  until a real cross-check (comparing one known day's totals against the Amazon Ads/Seller
  Central UI directly) is performed and recorded. P1-B may still be *built* with an explicit
  `asOf` date parameter — the checkpoint blocks production-facing enablement of day-level
  features, not RPC construction.
- **Report date definition**: Business Report `ordered_product_sales` is order-date based,
  explicitly distinct from Settlement Net Sales (migration 052's own comment). Ads report `date`
  is the report's own per-row date at `timeUnit: 'DAILY'` granularity.
- **Ads attribution window**: 1-day click for `spAdvertisedProduct` (§2).
- **Sales report definition / cancellations**: "Ordered Product Sales" reflects the order as
  placed; the table has no cancellation/return column. Cancellations/returns are only visible in
  the 29-day-stale settlement table, and the two are never reconciled.
- **Date-boundary alignment between Business Report and Ads report**: still not independently
  verified — folded into the Correction 8 checkpoint above rather than left as a vague caveat.

## 6. Duplicate-risk / cross-marketplace findings

- **FBA/FBM duplicate listings**: not observed in the live 462-row catalog. §3e now documents the
  **exact, verified** upsert behavior when this is hit (silent drop of the second SKU's row, via
  a caught, discarded Postgres unique-violation), replacing the earlier assumption-based
  characterization.
- **Missing listing mapping**: 3 of 232 sales-SKUs (1.3% by count, unknown % by value — §3c).
- **Stale listing mapping**: whole-table staleness only (23 days); no per-row signal (§3e).
- **Cross-marketplace mapping risk**: not observable today (single marketplace); the P1-B RPC
  must still filter `marketplace_id` explicitly on every join, never rely on today's implicit
  single-marketplace reality.
- **Unmapped / identity-conflict Ads rows**: 0 in live data by SKU-count (§3a); spend-weighted
  confirmation blocked this round (§3b). Both states remain required, tested P1-B code paths.

## 7. Result

# **GO WITH RESTRICTIONS** (unchanged verdict — no new evidence this round revealed double
counting or another material accuracy blocker; see §8 for what remains to re-verify before this
verdict is treated as fully closed on the spend-weighted question specifically)

**Why GO, not BLOCKED:** the SKU→Ads mapping — the single biggest risk called out in the original
task — remains verified clean by SKU-count on 100% of live production rows (112/112, §3a), the
auto/manual duplication risk is now **structurally proven prevented by the actual upsert code**
(§3d, not assumed), and the catalog's real duplicate-ASIN behavior is now an exact, cited code
fact rather than an assumption (§3e).

**Why WITH RESTRICTIONS, not a clean GO — carried forward and extended:**

1. 90-day range is not fully backed by data (~5.5–7.3 weeks of real history).
2. Catalog metadata is 23 days stale (§2, §3e) — **this is a metadata-freshness fact only, never
   to be conflated with SKU sales/spend activity freshness** (Correction 3 — see Product Spec).
3. Fulfillment-type data is not currently trustworthy for recent windows — filter ships disabled.
4. Organic sales must not be computed or shown (§4).
5. `identity_conflict` (replacing "ambiguous") is a concrete, reachable state the P1-B RPC must
   implement and test even though it is unobserved in current data (§3e).
6. Timezone/date-boundary alignment remains an unverified, now-named pre-production checkpoint
   (§5, Correction 8) — blocks production enablement of day-level features specifically, not the
   whole page.
7. **New this round:** spend-weighted mapping coverage and value-weighted sales-catalog coverage
   are reported as logically **derived** (§3b) or explicitly **unknown** (§3c), not directly
   SQL-verified, due to a DB-access blocker this round (§8). This does not change the verdict —
   the underlying SKU-count evidence remains strong and the derivation for §3b is airtight — but
   it must be closed out with a direct query before being cited as independently verified.
8. Cross-source (`ads_api_auto` vs `manual_csv_upload`) duplication is **structurally prevented by
   code** (§3d), but the exact historical overlap date range and whether the two paths' schema
   differences (Campaign Id presence) were ever actually exercised in a way that produced diverged
   keys remains an open, ready-to-run query (§3d, §8).

## 8. Full disclosure — this round's DB-access blocker

During this correction round, the read-only Supabase MCP SQL tool (`execute_sql`, and separately
`list_tables`) returned `MCP tool call requires approval` on every attempt, including a trivial
`SELECT 1`, both before and after an explicit approval was requested and granted through the
conversation. A different tool on the same MCP server (`list_projects`) succeeded, confirming this
was a tool-specific permission gate, not a connectivity failure, and not something resolvable by
retrying the identical call. Per this session's own instruction not to re-attempt an already-denied
tool call indefinitely, further retries were stopped after confirming the gate was specific to the
SQL-execution tools.

**Consequence:** every fresh number this correction round asked for that required a *new* SQL
query (spend-weighted mapping %, value-weighted sales coverage, auto/manual overlap date range and
row counts, normalization-collision counts) could **not** be obtained. Everywhere this happened,
this document states so explicitly, provides the exact ready-to-run query, and — where a valid
logical derivation from already-verified facts exists (§3b only) — reports that derivation clearly
labeled as such rather than presenting it with the same confidence as a direct query result.
Everywhere no such derivation exists (§3c, the quantitative parts of §3d and §3e), the fact is
reported as **UNKNOWN**, not estimated or assumed.

**Follow-up action, carried into the Implementation Plan as a P1-A closeout item:** re-run the
four ready-to-run queries above (§3b, §3c, §3d, §3e) the moment Supabase MCP access is available
in a session, and replace the DERIVED/UNKNOWN markers with direct results before treating the
spend-weighted and value-weighted coverage questions as closed.

No migration is proposed or required by this document. This audit produces no schema changes.
