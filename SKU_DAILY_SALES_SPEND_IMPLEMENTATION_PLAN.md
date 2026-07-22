# SKU Performance — Implementation Plan (P1-A)

Status: **plan only — nothing in this document is built in this pass**
Depends on: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md`, `SKU_DAILY_SALES_SPEND_PRODUCT_SPEC.md`

## 1. Aggregation model decision

**Recommendation: a bounded, parameterized, `SECURITY DEFINER` SQL RPC that aggregates on the
database side at request time — not a materialized table, not a database view, not client-side
aggregation — for V1, with a documented, concrete trigger for promoting to a materialized daily
SKU fact table later.**

### Why not client-side aggregation

Explicitly ruled out by the requirement. Also structurally wrong here: the Ads source table
(`internal_ads_advertised_product_daily_rows`) is **not** one row per SKU per day — it is one
row per **campaign/ad-group/SKU/day** (a SKU running in three campaigns on the same day is three
rows). Fetching raw rows to the browser and summing there means shipping every campaign-level row
just to throw away the breakdown, for no benefit — the page never shows campaign-level detail.

### Why not a database view (plain, non-materialized)

A single `CREATE VIEW` joining the two source tables would either (a) join at the wrong
granularity — Business Report is 1 row/SKU/day, Ads is many rows/SKU/day, so a naive join
multiplies sales rows once per matching ad row — or (b) require pre-aggregating each side in a
subquery, at which point it is no longer meaningfully different from an RPC except that it can't
take bounded parameters (date range, SKU/ASIN filter, pagination limit/offset) without a wrapping
function anyway. An RPC subsumes this option cleanly.

### Why not a materialized table yet

Current real volume (§ Data Audit §1, §2): 24,608 Ads rows and 4,500 Business Report rows for
the one real workspace, both already indexed on `(workspace_id, report_date DESC)`. A `GROUP BY
sku_norm` aggregation over a 90-day, workspace-scoped window at this volume is a fast, ordinary
Postgres aggregate query — no materialization is needed to hit reasonable latency today. Building
a materialized-table refresh pipeline (with its own staleness/failure modes to then explain on
top of the two *already* separately-stale source pipelines — Data Audit §2) is unjustified
complexity for the data volume that exists right now.

**Documented promotion trigger** (not built now, written down so it isn't forgotten): if either
source table crosses roughly 2–5 million rows for a single workspace, or if the live-aggregation
RPC's p95 latency in production exceeds ~800ms, promote to a `sku_daily_performance_facts`
materialized table (SKU × date × pre-summed sales/units/spend/attributed-sales), refreshed either
nightly or immediately after each Ads/Business-Report sync run completes (reusing the existing
`internal_data_refresh_runs` bookkeeping pattern to know when a refresh is due). This is
explicitly **not P1-B scope** — P1-B ships the live-aggregation RPC only.

### Why an RPC, specifically

Matches the existing, already-reviewed convention in this codebase (see the Pincode Checker
P0-A/P0-B work: narrow, `SECURITY DEFINER`, `REVOKE ... FROM PUBLIC` + `GRANT ... TO
service_role` RPCs, called only through a small hardcoded TypeScript wrapper — never a generic
`.rpc(name, params)` passthrough). The same discipline applies here: one or two narrow RPCs,
never a raw multi-table client-side join, and every parameter (workspace, marketplace, date
range, SKU/ASIN filter, pagination limit/offset) is validated and bounded before the query runs,
exactly as `esolz-app/src/lib/pincode-monitoring/rpc.ts` already does for its domain.

## 2. Proposed RPC shape (design only, not implemented)

`get_sku_performance_summary(p_workspace_id uuid, p_marketplace_id text, p_as_of date,
p_limit integer, p_offset integer, p_sku_filter text, p_asin_filter text, p_category_filter
text, p_brand_filter text)` → one row per SKU, with sales/units/spend/attributed-sales/ACOS/TACOS
for yesterday, trailing-7-day, trailing-30-day, and prior-7-day (for trend deltas), plus mapping
state and per-source freshness dates — computed via three `GROUP BY sku_norm` CTEs (Business
Report window sums, Ads window sums, catalog metadata lookup), left-joined by normalized SKU,
never a cross-product join.

`get_sku_performance_daily(p_workspace_id uuid, p_marketplace_id text, p_sku text, p_date_from
date, p_date_to date)` → the row-drill-down daily series (§ Product Spec §7), one row per day,
bounded to a single SKU and an explicitly bounded date range (hard ceiling, e.g. 400 days max,
mirroring the ceiling style already used for `get_pincode_target_results`).

Both RPCs: `REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO service_role` only, called from Next.js
route handlers via the admin client, matching the existing convention exactly. Never a generic
RPC-name passthrough.

## 3. Performance requirements — how each is met

| Requirement | How met |
|---|---|
| 500 SKUs | The summary RPC returns one row per SKU with a hard `p_limit` ceiling (proposed default 100, max 500) and `p_offset` — never unlimited. Sorted server-side (default: Attention status, then 7-day sales desc), so pagination is meaningful, not arbitrary. |
| 90-day ranges | The summary RPC's window sums use `report_date >=` bounds computed from `p_as_of`, hitting the existing `(workspace_id, report_date DESC)` indexes on both source tables — a range-bounded index scan, not a full table scan. The daily drill-down RPC is explicitly capped (see above) and only ever scoped to one SKU at a time. |
| Multiple workspaces | Every query is `workspace_id`-scoped, matching every existing RLS-gated `internal_*` table; no cross-workspace aggregation is ever performed in one call. |
| Multiple marketplaces | `marketplace_id` is a required, explicit filter parameter on both RPCs — never inferred, never left to "whatever the joined rows happen to be" (Data Audit §6 flagged this as a risk if left implicit). |
| No N+1 | The summary RPC returns every column the main table needs in one call. The row drill-down issues exactly one additional call (the daily-series RPC) when a row is expanded — never one call per visible row. |
| No unlimited raw-row fetch to the browser | Both RPCs return pre-aggregated rows only; the Ads table's campaign/ad-group-level rows never leave the database. |

## 4. Route plan (not built in this pass)

- `GET /api/sku-performance/summary` — calls `get_sku_performance_summary`, paginated, filtered.
  Auth: reuse `getInternalAccessContext()` (same gate as `/api/internal/brahmastra-data-health`
  and the rest of `/dashboard/internal`), not a new access-control module — this page is squarely
  the same internal-tooling audience, and building a second parallel auth gate would be an
  unjustified duplication given one already exists, is tested-in-production, and matches the
  Data Audit's own finding that this is effectively single-workspace, single-team tooling today.
- `GET /api/sku-performance/[sku]/daily` — calls `get_sku_performance_daily`, one SKU, bounded
  range.
- Both routes: bounded request parameters (mirroring the exact style already used in
  `esolz-app/src/app/api/pincode-monitoring/*` — explicit `MAX_*` constants, strict positive-int
  parsing, no silent coercion), a shared `internalError()`-style response helper so no route
  leaks a raw Postgres error to the browser.

## 5. Implementation sequence (as instructed — small PRs)

**P1-A — this PR.** Data audit and locked metric definitions. Documentation only. No migration,
no RPC, no route, no UI. **Complete as of this PR.**

**P1-B — not started.** Canonical daily SKU aggregation/data API: the two RPCs in §2, their
`SECURITY DEFINER`/grant setup, the two route handlers in §4, and a test suite (SQL scratch-DB
tests for the RPCs' aggregation correctness and bounds, following the exact
`esolz-app/supabase/tests/` pattern already established for Pincode; TypeScript tests for the
route layer's parameter validation and response mapping, following the
`esolz-app/src/lib/pincode-monitoring/__tests__/` pattern). No UI. Migration is written but
**not applied to production** without separate explicit approval, matching every prior-round
convention in this repository.

**P1-C — not started.** The `/dashboard/sku-performance` page UI itself: summary cards, main
table, filters, row drill-down (§ Product Spec §3–§7), reading only from the P1-B routes — no
direct table access from the client, no new data logic introduced at the UI layer.

**P1-D — not started.** Explainable flags (§ Product Spec §6) computed and exposed (either as
additional RPC output columns or a thin derivation layer over the P1-B response — decided during
P1-D, not here), CSV export, Command Center integration.

**Do not start P1-B during this task unless explicitly instructed after this audit is reviewed** —
per the explicit instruction. Nothing beyond P1-A is implemented in this branch.

## 6. Dependencies and blockers carried forward from the Data Audit

- Catalog freshness (23 days stale) should ideally be resolved (a fresh
  `amazon_listing_items` sync) before or alongside P1-C shipping, so the page's product
  titles/images aren't visibly wrong on day one. Not a P1-B blocker — P1-B's RPCs will correctly
  label freshness regardless; it is a data-quality item, not a code item.
- Fulfillment-type filter stays hidden/disabled until either `internal_payment_transactions`
  catches up or `amazon_sku_geo_sales_daily` is actually populated (Data Audit §2, Product Spec
  §5). Tracked here so it isn't silently re-added in P1-C without re-checking freshness at that
  time.
- Timezone/date-boundary alignment between the Business Report and Ads pipelines (Data Audit §5)
  should be independently verified (comparing one real day's totals against the Amazon Ads/Seller
  Central UI directly) before P1-D's explainable flags are trusted for day-level precision — the
  7-day/30-day windows are far less sensitive to a single-day boundary error than the "Yesterday"
  column is.
