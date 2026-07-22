# SKU Daily Sales & Ad Spend — Data Audit (P1-A)

Status: **read-only audit, no code changes, no migrations, no production writes**
Branch: `feature/sku-daily-sales-spend-audit`
Date: 2026-07-22 (original), amended 2026-07-22 — Review Correction Round ("Update 2"),
**amended again 2026-07-22 — Evidence Closeout ("Update 3"), completed with the normalization
evidence closed out during the PR #55/#56 merge-order rebase, amended again 2026-07-22 — final
API/coverage contract consistency pass ("Update 5"): §3d records a new code-inspection finding
(the manual-CSV import route never writes `internal_data_refresh_runs` rows) that directly
supports the Implementation Plan §3 coverage-state model correction**
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

**Update 2 — honest disclosure of an evidence gap.** The original audit proved SKU-count mapping
coverage (112/112 distinct advertised SKUs matched) but did not prove **spend-weighted** mapping
coverage, conflated two different coverage concepts, treated per-SKU absence as "stale" when it
may just mean no activity, and understated the real SKU-normalization inconsistency across
pipelines. That round corrected the definitions and methodology but could not obtain fresh
production numbers — this session's own Supabase MCP SQL tool remained blocked behind a
tool-permission gate for the duration of that round, so every number needing a new query was
marked **DERIVED** or **UNKNOWN — blocked**, each with the exact ready-to-run SQL, never a
fabricated number.

**Update 3 — evidence closeout.** The blocked queries from Update 2 (§3b, §3c, §3d) were run
successfully, read-only, against production by an independent reviewer, and their results were
recorded in place of the prior DERIVED/UNKNOWN markers. §3e's normalization-collision **count**
query was not part of that round.

**Final closeout (during the PR #55/#56 merge-order rebase) — the §3e normalization-collision
count is now also resolved.** Run successfully, read-only, against production: zero normalization
collisions across all four sources (Ads, Sales, Catalog, Cost master), individually and combined,
using the canonical candidate `trim(SKU).toUpperCase()`. Canonicalization recovers zero additional
matches over the exact-string joins already in use. Every blocked query from Update 2 is now
resolved. The verdict is unchanged: **GO WITH RESTRICTIONS**. See §8 for the full, final
disclosure of what is closed and what honestly remains genuinely open (timezone/date-boundary
alignment, catalog staleness, fulfillment-data staleness, organic sales' exclusion — none of
which a read-only audit query resolves).

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

### 3b. Spend-weighted mapping coverage (Correction 1) — RESOLVED, directly SQL-verified

**Update 3: the query below was run successfully, read-only, against production by an independent
reviewer (this session's own Supabase MCP tool remained blocked — see §8).** Workspace
`55a321c9-7729-4662-a494-9f1f1aa86846`, marketplace `A21TJRUUN4KGV`. The logical derivation from
Update 2 (row-level mapping state is a pure function of which already-proven-mapped SKU a row
belongs to, so 100% SKU-count mapping implies 100% spend-weighted mapping) is now confirmed by a
direct query, not merely inferred:

```sql
-- Same query proposed in Update 2, now executed
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
)
-- windowed as: all history, last 30 complete days, last 7 complete days, latest complete day
```

| Window | Dates | Rows | Distinct SKUs | Total spend | Mapped spend | Unmapped spend | Conflict spend | Mapped spend % |
|---|---|---|---|---|---|---|---|---|
| All history | 2026-06-01 → 2026-07-21 | 24,608 | 112 | ₹727,626.91 | ₹727,626.91 | ₹0 | ₹0 | **100%** |
| Last 30 complete days | 2026-06-22 → 2026-07-21 | 14,303 | 110 | ₹432,127.53 | ₹432,127.53 | ₹0 | ₹0 | **100%** |
| Last 7 complete days | 2026-07-15 → 2026-07-21 | 3,288 | 95 | ₹103,341.35 | ₹103,341.35 | ₹0 | ₹0 | **100%** |
| Latest complete day | 2026-07-21 | 467 | 92 | ₹15,028.24 | ₹15,028.24 | ₹0 | ₹0 | **100%** |

**Mapped spend % = 100% in every window, unmapped and identity-conflict spend = ₹0 in every
window — directly SQL-verified, not merely derived.** Row counts sum correctly (all-history's
24,608 rows matches the total row count already established in §2), and the mapped-rows/
mapped-spend totals equal the window totals exactly, confirming zero unmapped/conflict rows at
both the row-count and spend-value level.

### 3c. Value-weighted sales catalog coverage (Correction 1) — RESOLVED, directly SQL-verified

**Update 3: run successfully, read-only, against production by an independent reviewer.** The
original audit only proved *SKU-count* coverage (229/232 = 98.7% of sales-active SKUs exist in
the catalog, §3a's sibling finding), which could not safely be assumed to also mean ~98.7% by
*value* — the 3 missing SKUs could in principle carry disproportionate sales. Now measured
directly:

| | Total | Linked to catalog | Missing from catalog | Coverage % |
|---|---|---|---|---|
| Ordered sales (₹) | 61,464,612.18 | 61,440,420.18 | 24,192.00 | **99.9606%** |
| Units | 51,170 | 51,151 | 19 | **99.9629%** |

- 232 sales SKUs total, 229 catalog-mapped, 3 missing (unchanged SKU-count fact from §3a/§3f).
- The 3 missing SKUs' combined sales value (₹24,192.00) and units (19) turn out to be a small
  fraction of the total — **value-weighted coverage (99.96%) is actually slightly higher than
  SKU-count coverage (98.7%)**, meaning in this account the missing SKUs are, if anything,
  lower-volume ones. This is a real, directly-measured fact for this account, not a general
  guarantee — it is exactly why SKU-count coverage was not treated as a safe stand-in for value
  coverage in Update 2, and now that the direct number is available, both are reported side by
  side per the instruction to keep them separate rather than merge them.

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

**Overlap date range, duplicated-row/spend/sales counts — Update 3: RESOLVED, directly
SQL-verified.** Run successfully, read-only, against production by an independent reviewer:

| Source | Date range | Rows | Spend | Attributed sales |
|---|---|---|---|---|
| `manual_csv_upload` | 2026-06-01 → 2026-06-14 | 7,143 | ₹219,846.32 | ₹1,096,705.57 |
| `ads_api_auto` | 2026-06-15 → 2026-07-21 | 17,465 | ₹507,780.59 | ₹2,314,253.82 |

**Cross-source overlap: 0 overlapping dates, 0 duplicate `dedupe_key` values, 0 duplicate rows,
₹0 duplicate spend, ₹0 duplicate attributed sales.** The two sources' date ranges are cleanly
adjacent (manual ends 2026-06-14, auto begins the very next day, 2026-06-15) with no shared date
at all — the manual upload was a one-time historical backfill for the period before automated
syncing began, not an overlapping parallel feed. The row counts (7,143 + 17,465 = 24,608) and
spend (₹219,846.32 + ₹507,780.59 = ₹727,626.91) sum exactly to the all-history totals already
verified in §3b, independently cross-confirming both results.

**Stated plainly, per the instruction:**
- **Current production data has no source-date overlap.**
- **Current production data has no duplicate dedupe keys.**
- **Therefore there is no current double-counting evidence.**
- **This is a fact about today's data, not a schema guarantee** — the structural proof above
  (shared parser, source-unfiltered upsert-by-id) is what makes duplication actually impossible
  *if* the two paths ever did overlap in the future (e.g. a manual re-upload covering a date range
  the automated sync already has); the clean date-adjacency observed here is a separate, additional
  fact specific to this account's history, not the reason duplication is prevented.
- **P1-B must still sum the canonical table once and must never separately sum source
  partitions together** — this rule does not relax now that overlap is confirmed absent; it
  remains the correct implementation regardless of whether the sources ever overlap.

**Conservative P1-B aggregation rule (still required — restated, not relaxed by this result):**
the
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

**New finding (Update 5) — the manual-CSV import route never writes `internal_data_refresh_runs`
rows at all.** Confirmed by direct code search: `grep -n "internal_data_refresh_runs"
esolz-app/src/app/api/internal/ads-deep-reports/import/route.ts` returns **zero** matches. Only
the automated sync script (`esolz-app/scripts/sync-ads-reports.ts`) writes refresh-run rows (10
write sites: lines 327, 334, 343, 364, 395, 405, 420, 427, 526, 544). This means every one of the
7,143 `manual_csv_upload` rows (2026-06-01 → 2026-06-14, above) was imported without ever creating
a corresponding `internal_data_refresh_runs` row for that date range. Consequence for the
Implementation Plan §3 coverage-state model: no date in that manual-backfill window can ever reach
`CONFIRMED_ZERO` or `SOURCE_NOT_COMPLETE`, since both require a refresh-run row that this import
path structurally never produces — an absent SKU/date in that window is `UNKNOWN` unless a
separate upload-coverage ledger (not built today) proves the CSV's complete date/SKU universe.

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

**Collision/conflict quantification — RESOLVED, directly SQL-verified.** Run successfully,
read-only, against production by an independent reviewer, using the canonical candidate
`trim(SKU).toUpperCase()` on each source's raw SKU column:

| Source | Rows | Raw distinct SKUs | Canonical distinct SKUs | Raw SKUs whose text changes under canonicalization | Source-level collisions |
|---|---|---|---|---|---|
| Ads (`internal_ads_advertised_product_daily_rows`) | 24,608 | 112 | 112 | 107 | **0** |
| Sales (`internal_business_report_sku_sales_traffic`) | 4,500 | 232 | 232 | 203 | **0** |
| Catalog (`amazon_listing_items`) | 462 | 462 | 462 | 404 | **0** |
| Cost master (`internal_sku_cost_master`) | 400 | 400 | 400 | 367 | **0** |

**Combined across all four sources: canonical keys containing multiple different raw SKUs = 0.**
Even though most raw SKU values change text under canonicalization (107–404 of each source's
distinct SKUs have some case/whitespace difference from their canonical form), **no two distinct
raw SKU strings ever collapse onto the same canonical key, in any single source or across all
four combined.** This is the reason the Round 1 raw-text exact-string join already achieved 100%
matching (§3a) — the same logical SKU is stored with an *identical* raw string everywhere it
appears, even when that raw string itself is non-canonical (mixed case, surrounding whitespace),
so canonicalizing it doesn't move it relative to any other SKU's identity.

**Mapping effect of canonicalization vs. exact-match (all directly verified):**

| Join | Exact-string matches | Canonical matches | Canonical-only matches (recovered by normalizing) | ASIN conflicts |
|---|---|---|---|---|
| Ads → catalog | 112 | 112 | **0** | 0 |
| Sales → catalog | 229 | 229 | **0** | 0 |
| Cost master → catalog | 302 | 302 | **0** | — |

Canonicalization recovers **zero** additional matches over exact-string matching in any of these
three joins, for this account's current data — confirming the Round 1/Update 2 raw-text join was
not silently missing any real matches that a normalized join would have caught.

**Locked conclusion, per the explicit instruction:**
- **Current production data has zero normalization collisions**, at the per-source level and
  combined across all four sources.
- **Canonicalization does not improve current mapping** — every join above already matches
  exactly the same set of SKUs with or without normalization.
- **Raw SKU is preserved for display and evidence** — canonicalization is a join-safety measure,
  never a display transformation; the seller-facing SKU text shown on the page is always the raw
  value.
- **P1-B may use `trim(SKU).toUpperCase()` as a defensive canonical join key** — not because
  today's data needs it (it doesn't change any result), but because it is a cheap, directly-tested
  safety margin against a future SKU that does have incidental whitespace/case divergence between
  sources.
- **P1-B must detect and reject/quarantine any future canonical collision** — if a future sync
  ever produces two distinct raw SKUs that canonicalize to the same key, the aggregation must
  flag this explicitly (e.g. as a new `normalization_collision` mapping state) rather than
  silently picking one or blending their figures.
- **Never merge two different raw SKU identities silently** — canonicalization is a join key
  only; it must never cause two SKUs a seller considers different inventory units to be reported
  as one row.

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
- 229/232 (98.7%) of sales-SKUs exist in the catalog table **by SKU-count**; **3 do not** — §3c
  now shows the *value*-weighted coverage is actually higher (99.96%), directly SQL-verified, not
  assumed equal to the SKU-count figure.
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
- **Missing listing mapping**: 3 of 232 sales-SKUs (1.3% by count, 0.04% by value — §3c, directly
  verified this round: ₹24,192.00 of ₹61,464,612.18 total ordered sales).
- **Stale listing mapping**: whole-table staleness only (23 days); no per-row signal (§3e).
- **Cross-marketplace mapping risk**: not observable today (single marketplace); the P1-B RPC
  must still filter `marketplace_id` explicitly on every join, never rely on today's implicit
  single-marketplace reality.
- **Unmapped / identity-conflict Ads rows**: 0 in live data by both SKU-count (§3a) and
  spend-value (§3b, directly verified this round across all four windows). Both states remain
  required, tested P1-B code paths regardless — today's clean data is not a schema guarantee.
- **Cross-source (manual/auto) duplication**: 0 overlapping dates, 0 duplicate `dedupe_key`
  values, ₹0 duplicate spend/sales — directly verified this round (§3d). Structurally prevented
  by code independent of this result holding.

## 7. Result

# **GO WITH RESTRICTIONS** (unchanged verdict across all three rounds — the Update 3 evidence
closeout confirms, rather than contradicts, everything the verdict already rested on; no double
counting or other material accuracy blocker was found)

**Why GO, not BLOCKED:** the SKU→Ads mapping — the single biggest risk called out in the original
task — is verified clean by **both** SKU-count (112/112, §3a) **and spend value, in every window,
directly SQL-verified** (100% mapped spend, ₹0 unmapped/conflict spend, §3b). Sales-catalog
coverage is verified clean by **both** SKU-count (98.7%) **and sales value (99.96%, §3c)**.
Auto/manual duplication is **both structurally proven prevented by the actual upsert code AND
confirmed absent in production data today** (0 overlapping dates, 0 duplicate keys, §3d). The
catalog's real duplicate-ASIN behavior is an exact, cited code fact (§3e).

**Why WITH RESTRICTIONS, not a clean GO:**

1. 90-day range is not fully backed by data (~5.5–7.3 weeks of real history).
2. Catalog metadata is 23 days stale (§2, §3e) — **this is a metadata-freshness fact only, never
   to be conflated with SKU sales/spend activity freshness** (Correction 3 — see Product Spec).
3. Fulfillment-type data is not currently trustworthy for recent windows — filter ships disabled.
4. Organic sales must not be computed or shown (§4) — still excluded, unchanged.
5. `identity_conflict` (replacing "ambiguous") is a concrete, reachable state the P1-B RPC must
   implement and test even though it is unobserved (0 rows, 0 spend, directly verified) in
   current data (§3e).
6. Timezone/date-boundary alignment **remains genuinely unverified** — this evidence-closeout
   round resolved the spend/coverage/overlap numbers but did **not** touch the timezone question,
   which stays a named pre-production checkpoint (§5, Correction 8) blocking production
   enablement of day-level features specifically, not the whole page.
7. **Resolved this round:** spend-weighted mapping coverage and value-weighted sales-catalog
   coverage, previously DERIVED/UNKNOWN, are now directly SQL-verified (§3b, §3c) — both confirm
   the original derivation/expectation exactly, with no surprises.
8. **Resolved this round:** cross-source duplication, previously an open quantitative question,
   is now directly confirmed absent in production (§3d) — 0 overlapping dates, 0 duplicate keys.
   The conservative P1-B aggregation rule (sum the canonical table once, never re-sum by `source`)
   is retained regardless, since it is the structurally correct implementation independent of
   whether overlap exists.
9. **Resolved during the PR #55/#56 merge-order rebase closeout:** the SKU-normalization
   **collision count** query (§3e) — the one item Update 3 left open — has now been run
   successfully, read-only, against production: **zero normalization collisions** across all four
   sources, individually and combined, and canonicalization recovers zero additional matches over
   the exact-string joins already in place. Every blocked/open query from this audit's review
   round is now resolved.

## 8. Evidence closeout — what is resolved, what honestly remains open

**Resolved (Update 3 + final closeout):** the Update 2 correction round identified genuine gaps in
the *methodology* (SKU-count vs. spend-weighted coverage conflation, an unproven
duplication-prevention claim, an unquantified normalization inconsistency) and fixed all of them
at the definitional level, but could not obtain fresh production numbers — this session's own
Supabase MCP SQL tool (`execute_sql`, `list_tables`) remained blocked behind a tool-permission gate
for that entire round, confirmed tool-specific (a different tool on the same server,
`list_projects`, worked). All four originally-blocked queries — §3b spend-weighted mapping, §3c
value-weighted sales coverage, §3d auto/manual overlap, and §3e's normalization-collision count —
have now been **run successfully, read-only, against production by an independent reviewer**, and
every DERIVED/UNKNOWN marker tied to them has been replaced with the direct result. All four
results **confirm** what the Update 2 methodology predicted or flagged as a risk to check — no
surprise, no double-counting, no normalization collision, no material accuracy problem surfaced.

**Honestly still open, not glossed over — these are freshness/verification facts, not blocked
queries, and a read-only audit query does not resolve them:**
- **Timezone/date-boundary alignment** (§5) — remains a named pre-production checkpoint, requiring
  a real cross-check against the Amazon Ads/Seller Central UI, not a database query.
- **Catalog metadata staleness** (23 days, §2/§3e) — a live sync freshness fact.
- **Fulfillment-data staleness** (29 days, §2) — same.
- **Organic sales' exclusion** (§4) — still excluded; its two preconditions (attribution-window
  methodology, date-boundary alignment) are unaffected by any of this audit's evidence closeouts.

No migration is proposed or required by this document. This audit produces no schema changes.
