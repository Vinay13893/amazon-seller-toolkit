# SKU Daily Sales & Ad Spend — Data Audit (P1-A)

Status: **read-only audit, no code changes, no migrations, no production writes**
Branch: `feature/sku-daily-sales-spend-audit`
Date: 2026-07-22
Author: Claude Code, on explicit founder instruction

## 0. What this document is

A read-only inspection of the *actual* tables, columns, importers, and sync jobs already in
this repository and in the live production database, done **before** any SKU Performance page
code is written. Every fact below was verified either by reading the migration/importer source
in this repo, or by running a read-only `SELECT` against the production Supabase project
(`okxfwcfxxrtmijmvztdq`, "Vinay13893's Project"). No table or column name below is assumed —
every one was found by `grep`/`Read` on the actual migration files or confirmed to exist via
`information_schema.tables`.

No migration was applied. No row was inserted, updated, or deleted. No Amazon Ads or sales
calculation anywhere in the app was changed.

## 1. Context that shapes every conclusion below

This is **not** a generic multi-tenant feature audit. The entire `internal_*` table family (Ads
reports, Business Reports, settlement transactions, SKU cost master, geo-sales) that this page
would draw on is a **single-team internal operations toolkit**, gated by RLS to one specific
account (`test2026@sociomonkey.com`) or workspaces on the "Internal Tester" subscription plan —
confirmed directly in every one of those tables' RLS policies. Migration 049's own comment
states the Amazon Ads OAuth connection carries 9 advertiser profiles, but only one —
`1119208106810251` / **EMOUNT RETAIL** — is actually selected and synced for this tooling.

Querying production directly confirms this is not theoretical:

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
| Seller SKU | SP-API Listings Items sync | `amazon_listing_items.sku` | `(workspace_id, sku, marketplace_id)` UNIQUE | 1 row per SKU | last synced **2026-06-29** (23 days stale) | 462 SKUs, 1 workspace | Table enforces **one SKU per row**, and a **partial UNIQUE index on `(workspace_id, asin, marketplace_id)` also forbids two rows sharing an ASIN** — this table structurally cannot represent a real "one ASIN, two SKUs" (e.g. FBA+FBM variants) situation; a second SKU for an already-present ASIN would be silently rejected by the sync upsert, not surfaced as a conflict | Yes, for SKU text itself | none |
| ASIN | Same sync | `amazon_listing_items.asin` | same | same | same (23 days stale) | 462/462 rows have `asin` populated (100%) | See "one SKU per ASIN" constraint above | Yes | none |
| Product title / image | Same sync | `amazon_listing_items.item_name`, `.image_url`, `.brand` | `sku` | same | **23 days stale** | title 462/462 (100%), image 462/462 (100%), brand 412/462 (89%) | Any SKU added/renamed/re-imaged in Seller Central in the last 23 days will show stale or missing metadata | Yes, with a visible "as of &lt;last_synced_at&gt;" caption | "Catalog data as of {date}" |
| Daily ordered sales | SP-API `GET_SALES_AND_TRAFFIC_REPORT`, ASIN/SKU granularity | `internal_business_report_sku_sales_traffic.ordered_product_sales` | `(workspace_id, marketplace_id, report_date, sku_norm\|child_asin\|parent_asin)` | 1 row/workspace/marketplace/date/SKU | latest date **2026-07-21** (fresh — yesterday) | 4,500 rows, 232 distinct SKUs, date range 2026-06-15 → 2026-07-21 (**~5.5 weeks of history**, not 90 days) | Order-date based ("Ordered Product Sales"), a **different number** from settlement Net Sales — must never be silently merged with `internal_payment_transactions` (explicit comment in migration 052) | Yes | "Ordered sales (order date)" |
| Daily units | Same report | `internal_business_report_sku_sales_traffic.units_ordered` | same | same | same | same | same | Yes | none |
| Sessions | Same report | `internal_business_report_sku_sales_traffic.sessions`, `.page_views` | same | same | same | same | Nullable column; not populated for every row (not separately re-verified per-row here) | Yes, treat NULL as "not reported," never 0 | none |
| Advertising spend | Amazon Ads Reporting API v3, `spAdvertisedProduct` report, DAILY | `internal_ads_advertised_product_daily_rows.spend` | `(workspace_id, profile_id, dedupe_key)`, `advertised_sku`/`advertised_asin` columns | 1 row/workspace/profile/date/campaign/ad-group/advertised-SKU | latest date **2026-07-21** (fresh) | 24,608 rows total for this workspace; 17,465 `source='ads_api_auto'` (automated) + 7,143 `source='manual_csv_upload'` (historical backfill); date range 2026-06-01 → 2026-07-21 (**~7.3 weeks**, not 90 days) | See attribution-window note below | Yes | none |
| Ad-attributed sales | Same report | `internal_ads_advertised_product_daily_rows.sales` | same | same | same | same | **1-day click attribution** (`sales1d`/`purchases1d`/`unitsSoldClicks1d` — confirmed in `amazon-ads-reporting-client.ts` `REPORT_CONFIG.spAdvertisedProduct.columns`), not the 7-day/14-day window the Ads Console UI defaults to for some views. Comparing this page's ACOS to a Console screenshot on a different attribution setting will not match — must be labeled | Yes, but must be labeled with the attribution window | "Ad-attributed sales (1-day click)" |
| Currency | Ads profile config | `amazon_ads_profiles.currency_code` | `profile_id` | per profile | static | all 9 profiles for this workspace are `INR` | Business Report / sales tables have **no currency column at all** — currency is only ever recorded on the Ads profile, never on a sales row. INR is assumed for sales too (same Amazon.in marketplace, same seller account) but this is an **inference, not a stored fact** | Yes, single fixed currency today | "All figures in INR" (hardcoded label, not derived per-row) |
| Marketplace | Ads profile / Business Report / listing sync, each independently | `amazon_ads_profiles.marketplace_id`, `internal_business_report_sku_sales_traffic.marketplace_id`, `amazon_listing_items.marketplace_id` | — | — | — | All observed rows for this workspace are `A21TJRUUN4KGV` (Amazon.in) | Three independent marketplace_id columns, never cross-validated against each other by any existing code | Yes | none |
| Account/workspace | `workspaces.id` | every table above | `workspace_id` | — | — | 1 of 3 workspaces has real data | — | Yes | none |
| Report date / timezone | Ads report `date` column (Amazon Ads Reporting API v3, DAILY `timeUnit`); Business Report `report_date` (SP-API) | both tables' `report_date` | civil date | daily | — | — | **Neither pipeline's code explicitly converts or asserts a timezone for the `date` field.** Amazon's Ads Reporting API returns `date` in the advertiser account's own timezone (`Asia/Kolkata` per the one synced profile); the Business Report's date semantics were not independently re-derived from Amazon's docs in this audit pass. Both *should* land on the same Asia/Kolkata civil day for this single-marketplace, single-timezone workspace, but this was **not proven** by comparing a known day's totals against an external source — see §5 | Yes, for a single-timezone workspace like this one | "Dates shown in Asia/Kolkata" (assumed, not independently verified) |
| Fulfillment type | Settlement/Transaction Report | `internal_payment_transactions.fulfillment` (`'Amazon'`/`'Merchant'`) | `sku_norm` | per transaction | latest date **2026-06-23 — 29 days stale** | 56,595 `'Amazon'` + 23,445 `'Merchant'` + 9,758 `NULL` (90% populated when present) | The **only** fulfillment-type source is a table that is a month stale. The purpose-built derived table for this (`amazon_sku_geo_sales_daily.fulfillment_bucket`) has **zero rows for this workspace** despite existing and being documented as "populated on-demand ... via the geo-demand API route" | **No — not for "yesterday" or "7-day" windows.** Only safe on ranges entirely before the settlement staleness cutoff, with an explicit staleness caption | "Fulfillment type — last updated {29+ days ago}, may not reflect recent SKUs" |
| Product/category mapping | Two independent, non-identical sources | `amazon_listing_items.product_type` (89% coverage... actually see below), `internal_sku_cost_master.category` | `sku_norm` | — | cost master unknown last-updated cadence; catalog 23 days stale | `internal_sku_cost_master`: 400/462 SKUs (87%) have a category, all with a category once present (400/400) | Two different "category" concepts (Amazon `product_type` taxonomy vs. an internally-defined `category` on the cost master) are **not the same field** and must not be silently merged into one filter value | Yes, but label which source, don't blend | "Category (internal)" vs "Product type (Amazon)" — pick one, do not merge |

## 3. Join and mapping audit

**Question asked: is Ads spend associated with seller SKU directly, or through some other
canonical mapping?**

Confirmed by reading `esolz-app/src/lib/internal/amazon-ads-reporting-client.ts`
(`REPORT_CONFIG.spAdvertisedProduct.columns` includes `advertisedAsin`, `advertisedSku` as
first-class report columns) and `esolz-app/scripts/sync-ads-reports.ts`
(`deepReportRowFor(...)` writes both `advertised_asin` and `advertised_sku` straight from the
Amazon report row, no derivation): **the join is direct, Amazon-reported SKU → SKU text match**
against `amazon_listing_items.sku`. There is no intermediate campaign/ad-group/product-ad ID
join required or used anywhere in the existing codebase — Amazon's own Ads report already
carries the advertiser's SKU string per row.

Evidence, run read-only against production for the one real workspace:

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

-- Result: distinct_ads_sku_asin_pairs_alltime=112, unmatched_by_sku=0, sku_matched_but_asin_mismatch=0
```

**112 distinct advertised SKUs, all-time, all 112 matched by exact SKU text to
`amazon_listing_items`, zero mismatched ASINs.** `advertised_sku` was never `NULL` in this
dataset (checked separately).

### Mapping states, quantified

| State | Count / % (all-time, this workspace) | Definition used |
|---|---|---|
| mapped | 112 / 112 = **100%** | `advertised_sku` matches exactly one `amazon_listing_items.sku` row, and the row's `asin` agrees with `advertised_asin` |
| unmapped | 0 / 112 = **0%** | `advertised_sku` present but no matching catalog row |
| ambiguous | 0 / 112 = **0%** | Not currently reachable in production — see structural note below |
| stale | not separately measurable today | `amazon_listing_items` itself is 23 days stale as a whole; a per-row "this catalog entry predates this ad row" flag does not exist |
| not applicable | n/a | No non-SKU-attributable ad spend exists in the `spAdvertisedProduct` report shape used here (keyword/search-term/targeting reports are separate tables, never blended into the SKU-level figure) |

**Important structural caveat — this 0% "ambiguous" is not a guarantee, it is what today's
data happens to show.** `amazon_listing_items` has a hard DB constraint,
`UNIQUE (workspace_id, asin, marketplace_id) WHERE asin IS NOT NULL`, meaning **the catalog
table itself cannot store two SKUs against the same ASIN** — a real FBA+FBM duplicate-listing
scenario for the same product would either be silently dropped on sync (losing one SKU's
catalog row entirely) or would need to have been prevented upstream. No FBA/FBM duplicate-ASIN
case was found in the live 462-row catalog, but the schema does not defend against one arising
later, and there is no `ambiguous` state a future join could ever actually return **while this
constraint holds**, because at most one candidate SKU can exist per ASIN in this table by
construction. The audit therefore cannot prove ambiguity is impossible in the underlying Amazon
account — only that it is unrepresented in this DB table today. **Do not allocate spend
arbitrarily across multiple SKUs, per the explicit instruction — if this constraint is ever hit
in practice (a sync silently drops a second SKU for one ASIN), that SKU's ad spend would show as
`unmapped`, not be split.**

### Sales ↔ spend ↔ catalog coverage (this workspace, all-time)

```sql
-- sales_sku_count=232, ads_sku_count=112, listing_sku_count=462
-- sales_skus_with_spend=107, sales_skus_without_spend=125
-- sales_skus_in_catalog=229 (3 sales-SKUs missing from the catalog table)
-- spend_skus_without_sales_row=5, ads_skus_in_catalog=112 (100%)
```

- 232 SKUs had at least one sale in the ~5.5-week Business Report window.
- 107/232 (46%) also had ad spend in that window; 125/232 (54%) had none — organic-only or not
  advertised. (This is the *opposite* of "spend without sales" — shown here only to establish
  the query pattern; the actual "spend without sales" flag definition is in the Product Spec.)
- 229/232 (98.7%) of sales-SKUs exist in the catalog table; **3 do not** — a small, real,
  named gap (their title/image/brand would be unavailable and must render as "Unknown product",
  never fabricated).
- 5/112 (4.5%) ad-spend SKUs have **zero matching sales rows anywhere in the ~5.5-week window**
  — real, concrete "spend but no sales (ever, in-window)" candidates.
- 112/112 (100%) ad-spend SKUs exist in the catalog.

## 4. Data-truth rule verification

Per the explicit instruction, the following are kept as **separate, never-merged facts** in
every source table read above: total ordered sales (`internal_business_report_sku_sales_traffic
.ordered_product_sales`), ad-attributed sales (`internal_ads_advertised_product_daily_rows
.sales`), ad spend (`.spend`), units (`.units_ordered` vs. Ads' own `units`/`unitsSoldClicks1d`),
ACOS/TACOS (not stored anywhere — both must be *computed*, never read from a stored `acos`
column, because a stored `internal_ads_advertised_product_daily_rows.acos` value is
Amazon's own per-row ACOS for that ad row only, not a SKU-level blended figure — see Product
Spec §"Locked formulas").

**Organic sales.** Per the explicit instruction: `Organic sales = Total sales − Ad-attributed
sales` is **NOT computed or displayed anywhere in this audit's proposed page**, because its two
preconditions are not yet satisfied:
1. **Attribution-window alignment** — Ads uses a 1-day click window (§2); total sales is a full
   day's ordered sales with no attribution window at all (every order counts, regardless of ad
   click). These are not the same measurement basis, and subtracting one from the other
   produces a number with no clean interpretation without a documented, approved methodology.
2. **Date-boundary alignment** — not independently proven (§5).

This is called out explicitly in the Product Spec's "Unsafe metrics" list, not silently omitted.

**Never coerce missing→zero.** No RPC or view is designed yet (P1-B, not built in this audit),
so this rule is a **requirement carried into the Implementation Plan**, not something to verify
against existing code — there is no existing SKU Performance query to check. It is stated here
as a locked constraint the P1-B aggregation must satisfy.

## 5. Timezone, currency, report-date, attribution-window, cancellation/return findings

- **Marketplace / currency**: single marketplace (`A21TJRUUN4KGV`, Amazon.in), single currency
  (`INR`) for the one real workspace. No multi-currency logic exists anywhere in the sales/ads
  tables audited — there is no currency column on any sales or ads row, only on
  `amazon_ads_profiles`.
- **Timezone**: `Asia/Kolkata`, read from `amazon_ads_profiles.timezone` for the synced profile.
  **Not independently re-derived or asserted in the sync code for either pipeline** — the Ads
  Reporting API's `date` column and the Business Report's `report_date` are trusted as-is from
  Amazon. Given a single-timezone, single-marketplace account, misalignment risk is low but
  **unverified**, not verified-safe.
- **Report date definition**: Business Report `ordered_product_sales` is **order-date** based
  (confirmed by migration 052's own comment, which explicitly contrasts it with Settlement Net
  Sales, a *different* number, settlement/refund-date based). Ads report `date` is the report's
  own per-row date at `timeUnit: 'DAILY'` granularity (confirmed in
  `amazon-ads-reporting-client.ts`).
- **Ads attribution window**: **1-day click** for the `spAdvertisedProduct` report
  (`sales1d`/`purchases1d`/`unitsSoldClicks1d` columns — confirmed directly in
  `REPORT_CONFIG.spAdvertisedProduct.columns`). Not 7-day, not 14-day. Any comparison to a
  screenshot from Amazon Ads Console using a different attribution setting will not match, and
  the page must label this explicitly (§2 matrix, "Ad-attributed sales" row).
- **Sales report definition**: "Ordered Product Sales" — an order placed on that date, at its
  ordered value, independent of later cancellation. The report/table has **no cancellation or
  return column** at all (`internal_business_report_sku_sales_traffic` has no
  `cancelled`/`returned`/`refund` field). Cancellations and returns are therefore **not
  reflected** in this sales figure and the page must not claim otherwise.
- **Cancellation/return treatment**: only tracked in `internal_payment_transactions` (which has
  `promotional_rebates`, and order-level rows that would include refund transaction types) — a
  **29-day-stale, settlement-based, different-methodology source** (§2). No attempt is made in
  this audit or in the proposed V1 page to reconcile ordered-sales vs. settlement-with-returns;
  they must stay visibly separate, matching the Business Report table's own stated design intent.
- **Date-boundary alignment between Business Report and Ads report**: **not independently
  verified**. Both draw on Amazon APIs for the same account/marketplace and both are presumed
  Asia/Kolkata, but no query in this audit cross-checked a specific day's totals against a
  third source (e.g. the Amazon Ads/Seller Central UI directly) to confirm the civil-day
  boundaries genuinely line up. This is flagged as an open validation item, not resolved here.

## 6. Duplicate-risk / cross-marketplace findings

- **FBA/FBM duplicate listings**: not observed in the live 462-row catalog (0 ASIN collisions —
  structurally impossible to observe given the table's own UNIQUE constraint, see §3). Real-world
  risk is **structural, not evidenced** — flagged, not dismissed.
- **Missing listing mapping**: 3 of 232 sales-SKUs (1.3%) absent from `amazon_listing_items`
  (§3) — small, real, named.
- **Stale listing mapping**: the entire catalog table is 23 days stale as a single fact (no
  per-row staleness signal beyond the one shared `last_synced_at` high-water mark observed:
  `2026-06-29 10:54:15+00`).
- **Cross-marketplace mapping risk**: not observable today — every row across every table for
  this workspace uses the identical `marketplace_id`. No cross-marketplace test case exists in
  production data to exercise this risk; the join logic does not explicitly filter on
  `marketplace_id` being equal on both sides in any of the ad-hoc queries above by construction,
  and this **must be added explicitly** in the P1-B RPC (never rely on it being implicitly true
  because it happens to be true today).
- **Unmapped Ads rows**: 0 in the live data (§3), but the P1-B aggregation must still handle the
  case (never crash, never drop, must classify as `unmapped` and exclude from any per-SKU roll-up
  while still counting toward a workspace-level "unmapped spend" total).
- **Ambiguous Ads rows**: 0 in the live data and currently unreachable given the schema
  constraint (§3) — still a required, explicit, testable code path in P1-B, not assumed away.

## 7. Result

# **GO WITH RESTRICTIONS**

**Why GO, not BLOCKED:** every metric the founder asked the page to answer has a real,
identifiable, mostly-fresh source today. The SKU→Ads mapping — the single biggest risk called
out in the task — is verified clean on 100% of live production rows (112/112 mapped, 0 unmapped,
0 ambiguous), with a direct, simple SKU-text join, not a fragile multi-hop mapping.

**Why WITH RESTRICTIONS, not a clean GO:**

1. **90-day range is not fully backed by data.** Ads history starts 2026-06-01 (~7.3 weeks of
   data today); Business Report SKU history starts 2026-06-15 (~5.5 weeks). A 90-day filter
   selection must show a real "data starts {date}" boundary, never a silently-zero-filled chart.
2. **Catalog metadata (`amazon_listing_items`) is 23 days stale.** Product titles/images/brands
   for anything added or changed in the last 3+ weeks will not reflect reality. Must be labeled,
   and P1-B should trigger (or the audit should recommend triggering) a fresh
   `amazon_listing_items` sync before/alongside shipping the page.
3. **Fulfillment-type data is not currently trustworthy for recent windows** — its only source
   is 29 days stale, and the purpose-built replacement table has zero rows. Per the founder's own
   "fulfillment, only when trustworthy" instruction: **the fulfillment filter must not ship in
   V1** until either the settlement sync catches up or `amazon_sku_geo_sales_daily` is actually
   populated.
4. **Organic sales must not be computed or shown**, per the explicit instruction — both stated
   preconditions (attribution-window methodology, date-boundary alignment) are unresolved (§4,
   §5).
5. **The "one ASIN → one SKU" mapping guarantee is a database constraint on today's data, not a
   proof about Amazon's real catalog.** The RPC design (P1-B) must still implement and test an
   `unmapped`/`ambiguous` path even though it is unreachable in current data, so a future
   duplicate-listing scenario degrades safely (spend excluded from per-SKU rollup, never
   arbitrarily split) instead of crashing or silently misattributing.
6. **Timezone/date-boundary alignment between the two report pipelines is assumed, not proven.**
   Documented as an open item; does not block V1 for a single-timezone workspace, but must not be
   asserted as "verified."

No migration is proposed or required by this document. This audit produces no schema changes.
