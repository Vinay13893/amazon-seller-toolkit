# SKU Performance — Implementation Plan (P1-A)

Status: **plan only — nothing in this document is built in this pass**
Depends on: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md`, `SKU_DAILY_SALES_SPEND_PRODUCT_SPEC.md`
Amended 2026-07-22 — Review Correction Round ("Update 2"): Corrections 4, 6, 8 applied (coverage-
state model for missing-row-vs-confirmed-zero; the P1-A/B/C/D sequence revised so P1-B owns
explainable-flag computation, filtering, and server-side sorting; a currency contract and a named
timezone-verification checkpoint added).

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

`get_sku_performance_summary(p_workspace_id uuid, p_marketplace_id text, p_as_of date, p_limit
integer, p_offset integer, p_sku_filter text, p_asin_filter text, p_category_filter text,
p_brand_filter text, p_growing_only boolean, p_declining_only boolean, p_spend_spike_only
boolean, p_no_attributed_sales_only boolean, p_high_tacos_only boolean, p_unmapped_only boolean,
p_identity_conflict_only boolean, p_sort text)` → one row per SKU, already filtered by every
passed filter, already sorted per `p_sort` (default: Attention-status severity, then 7-day sales
desc), already paginated by `p_limit`/`p_offset`. Per row: sales/units/spend/attributed-sales/
ACOS/TACOS for yesterday, trailing-7-day, trailing-30-day, and prior-7-day; the base sales-trend
and spend-trend states (Product Spec §6.2/§6.3); every Attention-status flag (§6.4) as a computed
boolean/enum, not left for the client to derive; mapping state (§Data Audit §3e); the three
per-SKU activity dates (§Product Spec §4); and the workspace's currency code (Correction 8, never
hardcoded by the caller).

A companion, workspace-scoped (not per-SKU) summary object — either a second RPC or a second
result set from the same call — must return: the three summary-card totals (sales/spend/
attributed-sales/ACOS/TACOS over the range), the SKUs-growing/declining counts (§Product Spec
§6.2's documented rule, not the narrower efficiency sub-flags), **the spend-weighted mapping
coverage breakdown** (mapped/unmapped/identity_conflict spend and %, per Data Audit §3b — the RPC
must compute this directly from a `SUM(spend) ... GROUP BY row_state` query, never approximate it
from a SKU-count ratio), and the three source-level freshness facts (`salesSourceLatestCompleteDate`
/ `adsSourceLatestCompleteDate` / `catalogLastSyncedAt` plus their `*State` companions, §Product
Spec §4).

`get_sku_performance_daily(p_workspace_id uuid, p_marketplace_id text, p_sku text, p_date_from
date, p_date_to date)` → the row-drill-down daily series, one row per day, each day classified
per the coverage-state model (§Correction 4 below) — never a flat zero standing in for missing
data. Bounded date range (hard ceiling, e.g. 400 days max, mirroring `get_pincode_target_results`).

**Aggregation rule carried from Data Audit §3d (Correction 2):** both RPCs sum `spend`/`sales`
**once per row** of the already-deduplicated `internal_ads_advertised_product_daily_rows` table.
Neither RPC ever groups by `source` and adds the groups back together — `source` is metadata
about which pipeline most recently wrote a row's current value, not a partition of two feeds that
need combining.

Both RPCs: `REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO service_role` only, called from Next.js
route handlers via the admin client. Never a generic RPC-name passthrough.

## 3. Correction 4 — missing row vs. confirmed zero: the coverage-state model

**Inspected:** `internal_data_refresh_runs` (migration 046/050), the Business Report and Ads
sync/importer code, and standard Amazon Reporting API behavior for zero-activity dimension rows.

**What `internal_data_refresh_runs` actually proves, precisely:** each row covers a **date
*range*** (`date_from`, `date_to`), not a single date, and records one `status` for that whole
range (`running`/`success`/`partial_success`/`failed`/`skipped`). **This table cannot prove
day-level completeness** — a `status='success'` run covering `2026-07-01..2026-07-21` asserts the
whole range synced without error; it does not independently confirm that Amazon's own report
generation had zero silent gaps for any single day inside that range. `partial_success` and
`rows_rejected` exist precisely because a run can be *incomplete* while still not being a hard
`failed` — a signal this model must respect.

**What Amazon's report semantics are trusted to prove (an assumption about an external system,
not independently tested in this audit — stated as such):** both the Business Report ("Sales and
Traffic by ASIN") and the Ads Reporting API's dimensional reports are standard Amazon reporting
products that **omit rows for dimension combinations with zero activity** rather than emitting an
explicit zero-value row — this is Amazon's documented, industry-standard behavior for these report
families, not something this codebase's own code enforces or could enforce. No controlled test
(e.g., picking a specific SKU and day known to have zero sales and confirming no row exists) was
run in this audit to independently verify it for this exact account.

**The five-state model:**

| State | Definition | Provable today from existing tables? |
|---|---|---|
| `BEFORE_HISTORY` | The requested date predates that source's earliest available date for this workspace (Data Audit §2: Ads from 2026-06-01, Business Report from 2026-06-15) | **Yes** — a simple `MIN(report_date)` bound |
| `SOURCE_NOT_COMPLETE` | The source's `internal_data_refresh_runs` row covering that date range is not `status='success'` (i.e. `failed`/`partial_success`/`running`/`skipped`, or no run recorded at all) | **Yes, at range granularity only** — cannot pinpoint which single day within a failed/partial range actually has the gap |
| `CONFIRMED_ZERO` | The covering run is `status='success'`, the date falls inside `[date_from, date_to]` of that run, AND no row exists for that SKU/date | **Provable only to the extent the range-level success signal is trusted to mean every day inside it is individually complete** — a genuine but bounded assumption, not a per-day guarantee |
| `REPORTED_VALUE` | A real row exists for that SKU/date | **Yes** — direct fact |
| `UNKNOWN` | None of the above can be established (e.g. no refresh-run row covers that date at all, for a source that has never logged runs for dates that old) | **Yes** — the honest fallback |

**Locked rule:** an unavailable date (`BEFORE_HISTORY`) is **never** zero-filled — rendered as a
labeled gap. A date inside a **successfully completed** range with no row **is** rendered as
`CONFIRMED_ZERO` (an honest, positive zero, not left ambiguously blank) — the explicit instruction
was not to "leave a successfully completed zero-activity date as misleadingly unknown when report
semantics safely prove zero," and `CONFIRMED_ZERO` is how that is satisfied. Anything that cannot
clear the bar for `SOURCE_NOT_COMPLETE`'s success check or the `BEFORE_HISTORY` bound is `UNKNOWN`
— rendered distinctly from both a real zero and a real value, never coerced to either.

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
| 500 SKUs | Hard `p_limit` ceiling (proposed default 100, max 500) and `p_offset`, applied **after** server-side filtering/sorting (Correction 6) — pagination is meaningful. |
| 90-day ranges | Window sums bounded by `report_date >=` computed from `p_as_of`, hitting the existing `(workspace_id, report_date DESC)` indexes. The daily drill-down RPC is capped and single-SKU. |
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

**P1-A — this PR (amended).** Data audit and locked metric definitions, now including the
spend-weighted mapping methodology, the auto/manual duplication proof, the normalization audit,
the coverage-state model, and the currency/timezone contract. Documentation only. No migration,
no RPC, no route, no UI. **Complete as of this amendment**, with one disclosed follow-up: re-run
the four ready-to-run queries in the Data Audit §3b/§3c/§3d/§3e once DB access is available
(§Data Audit §8).

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
per the explicit instruction. Nothing beyond P1-A is implemented in this branch.

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
- **Spend-weighted mapping coverage and value-weighted sales coverage (Correction 1) are DERIVED/
  UNKNOWN, not directly SQL-verified, as of this amendment** (Data Audit §3b/§3c/§8) — re-run the
  provided queries before citing exact percentages as independently verified.
- **The coverage-state model's day-level precision is bounded by `internal_data_refresh_runs`'
  range granularity (§3 above)** — a coverage ledger is a possible future P1-B+ enhancement, not
  required for V1.
