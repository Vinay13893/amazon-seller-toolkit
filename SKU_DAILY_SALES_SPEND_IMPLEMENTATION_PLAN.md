# SKU Performance — Implementation Plan (P1-A / P1-B)

Status: **§1–§7 below are the original P1-A plan (locked design, amended through Update 5). P1-B
has now been BUILT against this plan** — see "P1-B build note (2026-07-23)" at the end of §6 for
where the actual implementation matches this document exactly and the small number of places it
had to make an explicit decision the plan left open. Full detail:
`BRAHMASTRA_MASTER_TRACKER.md` §23 update 6.
Depends on: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md`, `SKU_DAILY_SALES_SPEND_PRODUCT_SPEC.md`
Amended 2026-07-22 — Review Correction Round ("Update 2"): Corrections 4, 6, 8 applied (coverage-
state model for missing-row-vs-confirmed-zero; the P1-A/B/C/D sequence revised so P1-B owns
explainable-flag computation, filtering, and server-side sorting; a currency contract and a named
timezone-verification checkpoint added). Amended again 2026-07-22 — Evidence Closeout ("Update 3"):
the spend-weighted mapping and value-weighted sales-coverage numbers referenced here are now
directly SQL-verified (Data Audit §3b/§3c) rather than derived/blocked. Amended again 2026-07-22 —
final API/coverage contract consistency pass ("Update 5"): the coverage-state model's internal
contradiction (`SOURCE_NOT_COMPLETE` and `UNKNOWN` both claiming "no covering run") is resolved
with an explicit five-state decision order (§3); the summary RPC's date-range contract, canonical
cross-source SKU universe, and pagination/summary-count separation are corrected to match the
Product Spec (§2). Amended again 2026-07-23 — **P1-B built** ("Update 6"): migration
`065_sku_performance_p1b_rpcs.sql` implements both RPCs exactly as designed in §2/§3 below, plus a
TypeScript data layer and two read-only routes. Not applied to production; P1-C not started.

## 1. Aggregation model decision

**Recommendation: a bounded, parameterized, `SECURITY DEFINER` SQL RPC that aggregates on the
database side at request time — not a materialized table, not a database view, not client-side
aggregation — for V1, with a documented, concrete trigger for promoting to a materialized daily
SKU fact table later.** (Unchanged from the original round; reasoning below carried forward.)

### Why not client-side aggregation

Explicitly ruled out by the requirement. The Ads source table
(`internal_ads_advertised_product_daily_rows`) is **not** one row per SKU per day — it is one row
per campaign/ad-group/SKU/day. Fetching raw rows to the browser and summing there means shipping
every campaign-level row just to throw away the breakdown.

### Why not a database view (plain, non-materialized)

Would either join at the wrong granularity or require the same pre-aggregating subqueries an RPC
already does cleanly, without an RPC's ability to take bounded parameters.

### Why not a materialized table yet

Current real volume (Data Audit §1–§2): 24,608 Ads rows and 4,500 Business Report rows for the
one real workspace, both already indexed on `(workspace_id, report_date DESC)`. A `GROUP BY
sku_norm` aggregation at this volume is an ordinary, fast Postgres aggregate query.

**Documented promotion trigger** (not built now): ~2–5 million rows per workspace, or p95 RPC
latency in production exceeding ~800ms → promote to a `sku_daily_performance_facts` materialized
table, refreshed nightly or after each sync run completes. Explicitly **not P1-B scope**.

### Why an RPC, specifically

Matches the existing, reviewed convention in this codebase (Pincode Checker P0-A/P0-B: narrow,
`SECURITY DEFINER`, `REVOKE ... FROM PUBLIC` + `GRANT ... TO service_role`, called only through a
small hardcoded TypeScript wrapper — never a generic `.rpc(name, params)` passthrough).

## 2. Proposed RPC shape (design only, not implemented)

**Revised per Correction 6 — P1-B's RPCs now own explainable-flag computation, filtering, and
sorting, not just raw aggregation.** They must return everything the Product Spec's summary
cards, table, filters, and Attention status need — the UI (P1-C) never recomputes a flag.

**Revised again per Update 5 Correction 2 (selected date-range contract) — the summary RPC must
accept an explicit date range, not only `p_as_of`:**

`get_sku_performance_summary(p_workspace_id uuid, p_marketplace_id text, p_date_from date,
p_date_to date, p_as_of date, p_limit integer, p_offset integer, p_sku_filter text, p_asin_filter
text, p_category_filter text, p_brand_filter text, p_growing_only boolean, p_declining_only
boolean, p_spend_spike_only boolean, p_no_attributed_sales_only boolean, p_high_tacos_only
boolean, p_unmapped_only boolean, p_identity_conflict_only boolean, p_sort text)` → one row per
SKU, already filtered by every passed filter, already sorted per `p_sort` (default: Attention-
status severity, then 7-day sales desc), already paginated by `p_limit`/`p_offset`. Per row:
sales/units/spend/attributed-sales/ACOS/TACOS for yesterday, trailing-7-day, trailing-30-day, and
prior-7-day; the base sales-trend and spend-trend states (Product Spec §6.2/§6.3); every
Attention-status flag (§6.4) as a computed boolean/enum, not left for the client to derive;
mapping state (§Data Audit §3e); the three per-SKU activity dates (§Product Spec §4); and the
workspace's currency code (Correction 8, never hardcoded by the caller).

`p_date_from`/`p_date_to` are the **selected, complete-day range** the summary cards and
selected-range sales/spend metrics operate over (Product Spec §3) — hard bounded, the RPC must
reject `p_date_from > p_date_to`, and must never silently accept a `p_date_to` in the future
relative to the workspace's marketplace-local today. `p_as_of` is a **separate** parameter: the
anchor date for the fixed comparison windows (Yesterday, trailing-7-days, prior-7-days, trailing-
30-days, day-over-day delta) — explicit, marketplace-timezone-aware, and never silently derived
from the database's `CURRENT_DATE` (Correction 8, carried forward). The two stay independent: a
caller can change the selected range for the cards/table without changing which day "Yesterday"
or the trailing/day-over-day windows are computed against.

The response must return, alongside the per-row/summary data: `requestedDateFrom`,
`requestedDateTo` (echoing the caller's input verbatim), `effectiveDateFrom`, `effectiveDateTo`
(the range actually used, after clamping to real source-history boundaries), `asOf`,
`salesHistoryStartsAt`, `adsHistoryStartsAt` (the real `MIN(report_date)` per source, so the
caller can tell whether/where the requested range was clamped), `wasRangeClamped` (boolean), and
`clampReason` (populated only when `wasRangeClamped` is true — e.g.
`requested_start_before_ads_history`). The RPC never silently zero-fills the portion of a
requested range that predates available history — it reports the clamp instead.

**Revised again per Update 5 Correction 3 (canonical SKU universe) — the driving SKU universe for
this RPC is a union across sources, not `amazon_listing_items` alone:** the set of SKUs the
summary RPC aggregates over must begin from a `UNION` of canonical SKU identities present in the
requested scope across `internal_business_report_sku_sales_traffic`,
`internal_ads_advertised_product_daily_rows`, `amazon_listing_items`, and
`internal_sku_cost_master` (the last one where category/cost metadata is relevant to a requested
filter) — never only from `amazon_listing_items`. Required behavior: a sales-only SKU (present in
Business Report data, absent from the catalog) remains visible; an Ads-only SKU remains visible; a
catalog-only SKU (tracked in `amazon_listing_items`, zero activity in the window) may remain
visible; a SKU with no catalog match renders as "Unknown product" rather than being dropped; a
missing catalog row never causes real sales/spend to disappear from the summary. The raw SKU
string is retained for display; a canonical join key (candidate: `trim(sku).toUpperCase()`, per
Data Audit §3e — verified zero normalization collisions in production) is used **only for
matching** across sources, never for merging distinct raw SKUs into one displayed identity. Any
future canonical-key collision across genuinely distinct raw SKUs is surfaced as
`identity_conflict` (§Product Spec mapping-state vocabulary) — never silently merged. When the
same canonical identity appears across multiple sources, the **displayed raw SKU** is chosen by a
fixed precedence: (1) the catalog (`amazon_listing_items`) raw SKU, (2) the Business Report raw
SKU, (3) the Ads raw SKU, (4) the cost-master raw SKU — first source present, in that order. The
row also returns which sources the canonical identity was actually found in (mapping/source-
presence evidence), so the UI can explain why a SKU has no catalog match or why a displayed value
came from a lower-precedence source.

A companion, workspace-scoped (not per-SKU) summary object — either a second RPC or a second
result set from the same call — must return: the three summary-card totals (sales/spend/
attributed-sales/ACOS/TACOS over the **selected `p_date_from`/`p_date_to` range**, not just
`p_as_of`), the SKUs-growing/declining counts (§Product Spec §6.2's documented rule, not the
narrower efficiency sub-flags), **the spend-weighted mapping coverage breakdown** (mapped/
unmapped/identity_conflict spend and %, per Data Audit §3b — the RPC must compute this directly
from a `SUM(spend) ... GROUP BY row_state` query, never approximate it from a SKU-count ratio),
and the three source-level freshness facts (`salesSourceLatestCompleteDate`
/ `adsSourceLatestCompleteDate` / `catalogLastSyncedAt` plus their `*State` companions, §Product
Spec §4).

**Revised again per Update 5 Correction 4 (pagination vs. summary counts) — every card/count in
the companion summary object above must be computed over the full filtered SKU scope (the
canonical union above, after every passed filter, before `p_limit`/`p_offset` is applied), never
over only the current page of returned rows.** Total sales, total spend, the growing/declining
counts, and the mapping-coverage breakdown are all full-scope aggregates. Separately, the response
must return explicit counts describing the page itself: `totalSkuCountBeforeFilters` (size of the
canonical union in the requested scope, no filters applied), `totalMatchingSkuCountAfterFilters`
(size after every passed filter, before pagination), `returnedSkuCount` (rows actually returned
this call, ≤ `p_limit`), `limit`, `offset`, and `hasMore` (`offset + returnedSkuCount <
totalMatchingSkuCountAfterFilters`). Filtering and sorting happen server-side, entirely before
pagination is applied — never paginate first and filter the page afterward.

`get_sku_performance_daily(p_workspace_id uuid, p_marketplace_id text, p_sku text, p_date_from
date, p_date_to date)` → the row-drill-down daily series, one row per day, each day classified
per the coverage-state model (§3 below) — never a flat zero standing in for missing
data. Bounded date range (hard ceiling, e.g. 400 days max, mirroring `get_pincode_target_results`).

**Aggregation rule carried from Data Audit §3d (Correction 2):** both RPCs sum `spend`/`sales`
**once per row** of the already-deduplicated `internal_ads_advertised_product_daily_rows` table.
Neither RPC ever groups by `source` and adds the groups back together — `source` is metadata
about which pipeline most recently wrote a row's current value, not a partition of two feeds that
need combining.

Both RPCs: `REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO service_role` only, called from Next.js
route handlers via the admin client. Never a generic RPC-name passthrough.

## 3. Correction 4 — missing row vs. confirmed zero: the coverage-state model

**Amended by Update 5 Correction 1 (2026-07-22): the five-state model below previously had an
internal contradiction — both `SOURCE_NOT_COMPLETE` and `UNKNOWN` independently claimed "no
covering refresh-run row exists" as a qualifying condition, which cannot both be true for the same
date/source under a single top-to-bottom priority order. Resolved below with an explicit
deterministic decision order; "no covering run at all" now belongs to `UNKNOWN` alone.**

**Inspected:** `internal_data_refresh_runs` (migration 046/050), the Business Report and Ads
sync/importer code, and standard Amazon Reporting API behavior for zero-activity dimension rows.
Also inspected for this amendment: `esolz-app/src/app/api/internal/ads-deep-reports/import/
route.ts` (the manual-CSV Ads import route) — confirmed by direct code search to contain **zero**
references to `internal_data_refresh_runs`; only the automated sync script
(`esolz-app/scripts/sync-ads-reports.ts`, 10 write sites) logs refresh-run rows at all. Manual-
CSV-imported Ads dates therefore have **no refresh-run row of any kind**, successful or otherwise
— this is load-bearing for the manual-CSV rule below.

**What `internal_data_refresh_runs` actually proves, precisely:** each row covers a **date
*range*** (`date_from`, `date_to`), not a single date, and records one `status` for that whole
range (`running`/`success`/`partial_success`/`failed`/`skipped`), plus `rows_rejected`. **This
table cannot prove day-level completeness** — a `status='success', rows_rejected=0` run covering
`2026-07-01..2026-07-21` asserts the whole range synced without error; it does not independently
confirm that Amazon's own report generation had zero silent gaps for any single day inside that
range. `partial_success` and `rows_rejected` exist precisely because a run can be *incomplete*
while still not being a hard `failed` — a signal this model must respect.

**What Amazon's report semantics are trusted to prove (an assumption about an external system,
not independently tested in this audit — stated as such):** both the Business Report ("Sales and
Traffic by ASIN") and the Ads Reporting API's dimensional reports are standard Amazon reporting
products that **omit rows for dimension combinations with zero activity** rather than emitting an
explicit zero-value row — this is Amazon's documented, industry-standard behavior for these report
families, not something this codebase's own code enforces or could enforce. No controlled test
(e.g., picking a specific SKU and day known to have zero sales and confirming no row exists) was
run in this audit to independently verify it for this exact account.

**The five-state model — evaluated in this exact order, first match wins:**

1. **`REPORTED_VALUE`** — a real source row exists for the exact (workspace, marketplace, source,
   SKU, report date). Wins **regardless of refresh-run history** — a row that was actually
   imported is a fact, whatever the sync bookkeeping says about the run that produced it.
2. **`BEFORE_HISTORY`** — the date predates the earliest available history boundary for that
   source/scope (Data Audit §2: Ads from 2026-06-01, Business Report from 2026-06-15), proved by a
   simple `MIN(report_date)` bound. An in-history date with a missing row is **never** classified
   as `BEFORE_HISTORY`, no matter how sparse that source's data is around it.
3. **`CONFIRMED_ZERO`** — no SKU row exists, but at least one **fully successful, accepted**
   refresh run covers the date for the **exact source scope**: for Ads,
   `internal_data_refresh_runs` rows matching `workspace_id`, `marketplace_id`, `profile_id`
   (where applicable), `source = 'ads_advertised_product'`, the date inside `[date_from,
   date_to]`, `status = 'success'`, and `rows_rejected = 0` (or an equivalent accepted-complete
   condition); for Business Reports, the equivalent match on `workspace_id`, `marketplace_id`,
   `source = 'business_report_sp_api'`, the date inside `[date_from, date_to]`, `status =
   'success'`, `rows_rejected = 0`. A later failed retry over the same range does **not** erase a
   date's `CONFIRMED_ZERO` standing from an earlier successful run — previously imported successful
   data is not retroactively invalidated by a subsequent failure. Note, however, that current
   *source-health* status (e.g. `brahmastra-data-health.ts`'s `stale`/`failed`) may separately show
   the most recent sync attempt failed — **coverage evidence for a specific past date and current
   pipeline health are different facts**, and this model only asserts the former.
4. **`SOURCE_NOT_COMPLETE`** — one or more refresh-run rows cover the date for the exact source
   scope, but **none of them is an accepted successful run**: covering attempts exist, but every
   one is `failed`-only, `partial_success`-only, `skipped`-only, `running`-only, or a `status =
   'success'` run with `rows_rejected > 0` where completeness cannot otherwise be established. The
   distinguishing feature from `UNKNOWN` is that covering attempts **do exist** — the pipeline
   tried and did not fully succeed, as opposed to never having run at all.
5. **`UNKNOWN`** — no source row exists for the SKU/date, **and no refresh-run row of any kind
   covers that date** for the exact source scope. This is the **only** state that means "no
   covering run" — `SOURCE_NOT_COMPLETE` never applies here, because `SOURCE_NOT_COMPLETE`
   requires covering attempts to exist.

**Manual-CSV-specific rule (historical Ads backfill dates):** the manual-CSV Ads import route
never writes `internal_data_refresh_runs` rows (confirmed above), so no manual-CSV-imported date
can ever reach `CONFIRMED_ZERO` or `SOURCE_NOT_COMPLETE` — both require a refresh-run row that
manual CSV imports structurally never create. For these dates: a real row is `REPORTED_VALUE`; an
absent SKU/date is `UNKNOWN`, **unless** an explicit upload-coverage ledger (not built today)
proves the complete date/SKU universe the CSV was meant to cover. It is never valid to infer
`CONFIRMED_ZERO` merely because the CSV contains other rows for that same date — the presence of
some rows for a date says nothing about whether the upload was a complete extract for every SKU
active that day.

**Locked rule:** an unavailable date (`BEFORE_HISTORY`) is **never** zero-filled — rendered as a
labeled gap. A date with an accepted successful covering run and no row **is** rendered as
`CONFIRMED_ZERO` (an honest, positive zero, not left ambiguously blank). A date with covering
attempts that never fully succeeded is `SOURCE_NOT_COMPLETE`, rendered distinctly from a confirmed
zero. A date with no covering evidence at all is `UNKNOWN`, rendered distinctly from both a real
zero and a real value. None of the five states is ever coerced into another to simplify the UI.

**Live-production note:** the real workspace's `internal_data_refresh_runs` data currently
contains **both** successful and failed refresh attempts over overlapping date ranges for the same
source (a failed retry does not remove the row logged by an earlier successful run). P1-B's
`CONFIRMED_ZERO`/`SOURCE_NOT_COMPLETE` queries must therefore evaluate **existence of at least one
accepted successful covering run** as a question distinct from **the latest source-health
status** — checking only "is the source currently healthy" would misclassify dates that synced
successfully before a later, unrelated failure.

**P1-B prerequisite recorded, since day-level completeness is not provable today:** the
`get_sku_performance_daily` RPC's day classification is only as precise as
`internal_data_refresh_runs`' range-level granularity allows. If day-level precision is ever
required (e.g., to defend a specific day's `CONFIRMED_ZERO` against a challenge), a coverage
ledger — one row per source per **date** (not per range) confirming that date's sync outcome —
would need to be added. **Not built in P1-A or assumed necessary for P1-B's V1** (range-level
`SOURCE_NOT_COMPLETE`/`CONFIRMED_ZERO` is judged sufficient for a first version), but written down
here so the limitation is never silently forgotten.

## 4. Performance requirements — how each is met

| Requirement | How met |
|---|---|
| 500 SKUs | Hard `p_limit` ceiling (proposed default 100, max 500) and `p_offset`, applied **after** server-side filtering/sorting (Correction 6) — pagination is meaningful. `totalSkuCountBeforeFilters`/`totalMatchingSkuCountAfterFilters`/`returnedSkuCount`/`hasMore` (Update 5 Correction 4) let the caller distinguish page size from true scope size without an extra count query. |
| 90-day ranges | The selected-range cards/table are bounded by the explicit `p_date_from`/`p_date_to` (Update 5 Correction 2), hard-bounded and clamped to real source history rather than accepted unbounded. The fixed comparison windows (Yesterday/trailing-7/prior-7/trailing-30) are bounded by `report_date >=` computed from the separate `p_as_of` anchor, hitting the existing `(workspace_id, report_date DESC)` indexes. The daily drill-down RPC is capped and single-SKU. |
| Multiple workspaces | Every query `workspace_id`-scoped; no cross-workspace aggregation in one call. |
| Multiple marketplaces | `marketplace_id` a required, explicit filter parameter on both RPCs — never inferred. |
| No N+1 | The summary RPC returns every column + flag the table/cards need in one call. Row drill-down issues exactly one additional call. |
| No unlimited raw-row fetch to the browser | Both RPCs return pre-aggregated, pre-flagged rows only; Ads campaign/ad-group-level rows never leave the database. |
| No client-side flag/filter/sort computation (Correction 6) | Every filter parameter and the default sort are RPC inputs/outputs, not post-processing in the route handler or the browser. |

## 5. Route plan (not built in this pass)

- `GET /api/sku-performance/summary` — calls `get_sku_performance_summary` (+ its companion
  workspace-summary result), paginated, filtered, sorted. Auth: reuse `getInternalAccessContext()`
  (same gate as `/api/internal/brahmastra-data-health`), not a new access-control module.
- `GET /api/sku-performance/[sku]/daily` — calls `get_sku_performance_daily`, one SKU, bounded
  range.
- Both routes: bounded request parameters (mirroring `esolz-app/src/app/api/pincode-monitoring/*`
  — explicit `MAX_*` constants, strict positive-int parsing, no silent coercion), a shared
  `internalError()`-style response helper.
- **Correction 8 — currency contract:** the summary route returns `currencyCode` sourced from
  `amazon_ads_profiles.currency_code` for the resolved profile/workspace, never a hardcoded
  `'INR'` constant in application code. If the underlying aggregation would need to span more than
  one distinct currency for the requested scope, the RPC must return a rejection result (not a
  summed number) and the route must surface a clear `currency_mismatch` error — never sum
  mismatched currencies, never silently convert.
- **Correction 8 — timezone/day-level checkpoint:** `p_as_of` is an explicit, caller-supplied
  date parameter (never `CURRENT_DATE` computed silently inside the RPC in some unstated
  timezone), so P1-B can be built and tested without resolving the open timezone-alignment
  question. However, the "Yesterday" column, any day-over-day delta, and any day-specific alert
  in the **UI** must remain behind an internal-only/disabled gate (mirroring
  `PINCODE_MONITORING_ENABLED`-style feature flags already used elsewhere in this codebase) until
  the verification described in the Data Audit §5/§8 is actually performed and recorded — this is
  a P1-C/production-enablement gate, not a P1-B build blocker.

## 6. Implementation sequence (revised — Correction 6)

**P1-A — this PR (amended twice).** Data audit and locked metric definitions, now including the
spend-weighted mapping methodology (directly SQL-verified), the auto/manual duplication proof
(structural + directly confirmed absent in production data), the normalization audit, the
coverage-state model, and the currency/timezone contract. Documentation only. No migration, no
RPC, no route, no UI. **Complete as of this amendment (Update 5).** The Data Audit §3e SKU-
normalization-collision count query (flagged as an open follow-up through Update 3) was run and
closed in Update 4 — zero normalization collisions found across all four sources, individually and
combined. This amendment (Update 5) closes a separate, later-discovered gap: the coverage-state
model's internal contradiction (§3), the summary RPC's missing date-range contract (§2 Correction
2), the catalog-only SKU universe (§2 Correction 3), and the pagination-vs-summary-count
conflation (§2 Correction 4) are all corrected here. No further P1-A follow-up is currently known
outstanding.

**P1-B — not started.** Canonical daily SKU aggregation RPCs **and** explainable-flag computation,
filtering, and server-side sorting (§2 above) — moved into this stage per Correction 6, resolving
the original sequence's contradiction (flags cannot be a P1-D afterthought if the Attention-status
column, Growing/Declining filters, and default sort all depend on them from the first version of
the page). SQL scratch-DB tests (aggregation correctness, the coverage-state model's boundary
cases, the mapping-state truth table, the ACOS/TACOS zero-denominator truth table) following the
`esolz-app/supabase/tests/` pattern; TypeScript tests for the route layer following the
`esolz-app/src/lib/pincode-monitoring/__tests__/` pattern. No UI. Migration written but **not
applied to production** without separate explicit approval.

**P1-C — not started.** The `/dashboard/sku-performance` page UI: summary cards, main table,
filters, row drill-down (§Product Spec) — **rendering only** what P1-B's RPCs return. No flag
computation, no client-side filtering/sorting, no new data logic at the UI layer (Correction 6).
This is also the natural point to resolve the catalog-freshness and timezone-verification items
carried in §7 below, before the Yesterday/day-level UI is enabled for real use.

**P1-D — not started, narrowed by Correction 6.** CSV export and Command Center/Actions
integration **only** — explainable flags are no longer P1-D scope, they moved to P1-B above.

**Do not start P1-B during this task unless explicitly instructed after this audit is reviewed** —
per the explicit instruction that applied through Update 5. **Superseded by explicit founder
instruction on 2026-07-23: build P1-B.**

**P1-B build note (2026-07-23).** Built exactly as designed above, in migration
`065_sku_performance_p1b_rpcs.sql` plus `esolz-app/src/lib/sku-performance/` and
`esolz-app/src/app/api/sku-performance/`. SQL scratch-DB tests and TypeScript route-layer tests both
follow the patterns named above (`esolz-app/supabase/tests/pincode-p0a/` and
`esolz-app/src/lib/pincode-monitoring/__tests__/`), all passing. No UI. Migration written but **not
applied to production**. Full detail, including the small number of implementation decisions this
plan left open (Ads rows' missing `marketplace_id` column, the dual SKU-count/spend-weighted mapping-
coverage return, source-health classification living in TypeScript rather than SQL, and
`workspaceId` never being an accepted route parameter), is recorded in `BRAHMASTRA_MASTER_TRACKER.md`
§23 update 6 rather than duplicated here.

## 7. Dependencies and blockers carried forward

- Catalog freshness (23 days stale) should ideally be resolved before or alongside P1-C shipping.
  Not a P1-B blocker.
- Fulfillment-type filter stays hidden/disabled until its source data is fresh.
- **Timezone/date-boundary verification (Correction 8) is now a named, explicit checkpoint**,
  not a vague caveat: before the Yesterday column, day-over-day deltas, or any day-specific flag
  is enabled outside internal/disabled status, someone must compare one real day's totals against
  the Amazon Ads/Seller Central UI directly and record the result. P1-B may be built against an
  explicit `p_as_of` parameter without waiting on this; production UI enablement of day-level
  features waits on it.
- **Spend-weighted mapping coverage and value-weighted sales coverage (Correction 1) are now
  directly SQL-verified** (Data Audit §3b/§3c): 100% mapped spend in every window, 99.96%
  value-weighted sales-catalog coverage. No further follow-up needed on these two specifically.
  The §3e SKU-normalization-collision **count** was run and closed in Update 4: zero collisions
  found across all four sources (Business Report, Ads, catalog, cost master), individually and
  combined, using the canonical candidate `trim(sku).toUpperCase()` — canonicalization recovers no
  additional matches over exact-string joins. No further follow-up remains on this item.
- **The coverage-state model's day-level precision is bounded by `internal_data_refresh_runs`'
  range granularity (§3 above)** — a coverage ledger is a possible future P1-B+ enhancement, not
  required for V1.
- **The summary RPC's date-range contract, canonical cross-source SKU universe, and
  pagination-vs-summary-count separation (Update 5 Corrections 2–4) are now specified in §2
  above** — this was a docs-only contract correction; no RPC/route/UI exists yet to build against
  it, so there is nothing further to reconcile in code as of this amendment.
