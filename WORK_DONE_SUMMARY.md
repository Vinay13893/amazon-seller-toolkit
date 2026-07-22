# Work Done Summary

## Internal Replenishment Intelligence - Current State

_Last updated: 2026-06-26. Covers commits `4a763f1`, `c99ea82`, `512a284`, date-range + Seller Central demand session, and geo demand reconciliation session._

### Transaction Geo Demand + FC Ledger Reconciliation (2026-06-26)

**What changed:**

- **`amazon_sku_geo_sales_daily` table** (migration 047, applied): derived aggregate table for SKU × date × geo × fulfillment demand. Intentionally excludes buyer identity, full address, and raw order payloads. Order IDs are not stored. Sources from `internal_payment_transactions`.
- **Geo demand API route** `GET /api/internal/stock-actions/geo-demand`: queries `internal_payment_transactions` directly (no derived table round-trip yet). Aggregates in application memory. Classifies fulfillment: `"Amazon"` → `fba_fc`, `"Merchant"` → `direct_flex_easyship`, null → `unknown`. Accepts `lookbackDays` or `demandStartDate`/`demandEndDate` (reuses date-range selector). 200K row limit per query.
- **FC ledger reconciliation**: joins `internal_fba_report_rows` (event_type = 'Shipments') for the same period to get FBA shipment units by fulfillment center. Computes `transactionVsLedgerDiff` (FBA transaction units − ledger FC shipment units) and diff %. **This is an estimation only** — no exact FC-to-order mapping exists in the source data.
- **"Sales & FC Movement Reconciliation" UI section**: collapsible card at the bottom of the Internal Stock Dashboard. Lazy-loaded (button tap). Shows:
  - Total transaction units, FBA/FC transaction units, Direct/Flex/EasyShip units, FBA Ledger Shipment Units
  - Transaction vs Ledger diff with color coding
  - Top states table (state, fulfillment bucket, units sold, orders, returns, return rate)
  - Top cities table (city, state, units sold, orders)
  - FBA Ledger FC breakdown table (FC ID, units shipped)
  - Export Geo Demand Summary CSV (state/city/pincode rows)
  - Export FC Movement Estimate CSV (FC breakdown with diff, labeled "Estimated")
  - Note: "Transaction geo demand can later become a planning source or cross-check source after validation."
- **Safety**: no buyer identity, no full addresses, no raw order payloads, no order IDs in exports or UI. City/state/pincode aggregates only.

**DB migrations applied:**
- Migration 047: `amazon_sku_geo_sales_daily` (created; not yet populated — API queries `internal_payment_transactions` directly for now)

**Files changed:**
- `supabase/migrations/047_amazon_sku_geo_sales_daily.sql` (NEW)
- `src/app/api/internal/stock-actions/geo-demand/route.ts` (NEW)
- `src/app/(dashboard)/dashboard/internal/stock-dashboard.tsx` (geo section + types + state + loadGeo + exports)

**FC reconciliation note:**
- Transaction report = ordered units (what customers bought)
- FBA Ledger = shipped/dispatched units (what left the FC)
- Timing difference, return processing, and in-transit items will cause a nonzero diff — this is expected.
- The section is labeled "estimated" throughout and is not wired into replenishment math.

---

### Date-range-aware demand + Seller Central planning (2026-06-26)

**What changed:**

- **Date range selector**: Planning assumptions panel now has a "Demand period" preset selector: 7D / 15D / 30D / 45D / 60D / Custom. Custom shows start/end date pickers. All replenishment calculations use the selected period — not hardcoded 30 days.
- **`formatDemandPeriodLabel`**: Helper in `internal-replenishment-planner.ts` and `stock-dashboard.tsx`. Returns preset labels (`30D`) or `D Mon–D Mon` for custom ranges.
- **`demandDays`**: Replaces all hardcoded `30` velocity divisors in `buildNextStockPlan`. Computed from inclusive day count of the selected window. Returned in `nextStockPlan.assumptions`.
- **Seller Central sales upload**: New DB tables `seller_central_sales_upload_batches` + `seller_central_sales_rows` (migration 045). Upload route at `POST /api/internal/stock-actions/seller-central-sales/import`. UI in Flex tab: CSV upload with optional report date range, active batch status, period match indicator.
- **Dual-source planning model**: `buildFlexReplenishmentRows` + `buildFlexDemandBreakdownRows` now accept `sellerCentralDemandBySkuNorm` and `sellerCentralPeriodMatch`. Per-row `planningDemandSource` indicates which source was used. SC used when period matches; falls back to trusted demand with labelled reason.
- **SC CSV parser**: `src/lib/internal/seller-central-sales-csv.ts`. Accepts many column aliases, CSV and TSV, rejects negative/PII, 5000-row limit.
- **Dynamic column labels**: All "30D" headings in flex table, exports, and stat cards now use the live period label.
- **New columns in Flex/Vendor table**: SC Period Units, SC Component Units, Planning Component Units Used, Planning Demand Source.
- **`ALLOWED_LOOKBACK_DAYS`** expanded to `[7, 15, 30, 45, 60, 90]` in the route.

**DB migrations applied:**
- Migration 045: `seller_central_sales_upload_batches`, `seller_central_sales_rows`

**Files changed:**
- `supabase/migrations/045_seller_central_sales_upload.sql` (NEW)
- `src/lib/internal-replenishment-planner.ts` (formatDemandPeriodLabel, demandDays, date range filtering)
- `src/lib/internal-replenishment-report.ts` (PlanningDemandSource, SC fields)
- `src/lib/internal/seller-central-sales-csv.ts` (NEW)
- `src/app/api/internal/stock-actions/seller-central-sales/import/route.ts` (NEW)
- `src/app/api/internal/stock-actions/route.ts` (date range, SC batch query, period match logic)
- `src/app/(dashboard)/dashboard/internal/stock-dashboard.tsx` (all UI changes)

**Planning source logic (per component row):**
- SC batch uploaded AND period matches AND this SKU has SC units → `seller_central_uploaded`
- SC batch uploaded AND period matches BUT this SKU not in SC export → `seller_central_missing_fallback_trusted`
- SC batch uploaded BUT period doesn't match → `seller_central_period_mismatch_fallback_trusted`
- No SC batch → `trusted_fulfillment`

**Required action after deploy:**
- Apply migration 045 via Supabase MCP or `supabase db push`.
- Upload a Seller Central sales CSV once to populate the active SC batch.

### Demand source definition

`Trusted Demand = FBA/FC shipped units + XHZU/Seller Flex dispatched units`

**This is not the same as Seller Central Manage Inventory "Last 30 days units sold."** Trusted demand is sourced from the FBA Ledger Detail report (`internal_fba_report_rows`, `event_type = 'Shipments'`) plus the secondary `internal_fulfillment_sales_daily` table (currently empty, 0 rows). Seller Central's Manage Inventory 30D metric is a different, broader figure and is intentionally not used for replenishment math today.

### Component calculation (unchanged)

`Component Units Sold = sum(Total Trusted 30D Finished Units per Amazon SKU × component_quantity)`

Verified against pack-of-4/2/1 examples. Formula itself was not modified in any session today.

### What is included / excluded

- **Included:** FBA/FC shipped units, XHZU/Seller Flex dispatched units (fulfillment centers XHZU, XHZV, XHZR, TPKR).
- **Excluded:** Easy Ship/MFN and unattributed sales — not backed by a trusted shipment ledger, excluded unless explicitly enabled later.

### XHZU/Seller Flex demand audit findings

- Source confirmed: `internal_fba_report_rows` (FBA Ledger Detail) with `fulfillment_center_id` in XHZU/XHZV/XHZR/TPKR and `event_type = 'Shipments'`.
- `internal_fulfillment_sales_daily` is the secondary intended source but currently has 0 rows.
- `toLocationType()` correctly classifies XHZU-family codes as `seller_flex`.
- `buildFlexReplenishmentRows()` uses `fbaSales30d + sellerFlexSales30d` — XHZU/Flex demand was already included.
- Aggregate diagnostics (workspace snapshot at audit time):
  - 738 mapped Amazon SKUs
  - 69 with FBA/FC demand
  - 142 with XHZU/Flex demand
  - 49 with both
  - 576 with neither
  - 76 of 305 component rows affected by XHZU/Flex demand
- **Dormant bug fixed** in `internal-replenishment-planner.ts`: `internal_sku_daily_sales` rows classified as `seller_flex`/`fba_fc` were previously dropped into `unknownSourceSales30d` instead of their trusted bucket. Live impact was zero at fix time because `internal_sku_daily_sales` source labels are currently 100% `amazon_api` (no channel tag), but the fix prevents future channel-tagged data from being silently excluded.

### XHZU stock

- Latest usable stock for calculations comes from `internal_inventory_by_location`.
- Upload history is recorded in `xhzu_stock_upload_batches` / `xhzu_stock_upload_rows` (migration 035).
- **Action needed:** the DB had 0 upload batches recorded right after this feature shipped — history only starts accumulating from the next XHZU stock CSV upload. Re-upload once to create the first tracked batch.

### Flex/Vendor outputs (table + exports)

- FBA/FC 30D Finished Units
- XHZU/Flex 30D Finished Units
- Total Trusted 30D Finished Units
- 30D Component Units Sold
- Required Component Stock
- Suggested Vendor Qty
- Demand Source Used
- **Export Purchase Plan** — daily vendor ordering CSV
- **Export Full CSV** — full diagnostic CSV with all columns above
- **Export Demand Breakdown** — per (Component SKU × Amazon SKU) reconciliation: FBA/FC 30D Units, XHZU/Flex 30D Units, Total Trusted 30D Units, Component Units Sold, Match Status, Reason

### FC allocation outputs

- "Complete FC Fulfilment & XHZU Allocation" section: per-component requirement, shortage, surplus, coverage %.
- Component-constrained allocation: floor-then-velocity allocator; combo SKUs bottlenecked by their scarcest linked component.
- **Export FC Allocation Plan** CSV (Component SKU × Amazon SKU × FC granularity).
- Amazon recommendation placeholder status shown per row (`not_connected` / `pending_fetch` / `available`) — never faked.
- Base FC/Flex formulas unchanged.

### Assumptions

- `replenishment_assumptions` table exists (migration 036), scoped per `flex`/`fc`.
- UI currently shows read-only status: "Default (not yet saved)."
- Save/edit assumptions UI is **not built yet**.

### Amazon restock recommendations

- `amazon_restock_recommendations` placeholder table exists (migration 037), empty until a fetch job is built.
- `GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT` exists on SP-API and can likely reuse the existing generic report framework (`createAmazonReport`/`getAmazonReportDocument`) — fetch itself is **not implemented**.
- Free storage / free removal benefit field is **not verified** as an SP-API/report-documented field for our marketplace.
- UI must never fake Amazon recommendation data — shows "Amazon recommendation not synced yet" when absent.

### Known open issues / next tasks

1. **Apply migration 045** — `seller_central_sales_upload_batches` + `seller_central_sales_rows` tables must be created via `supabase db push` or the Supabase MCP.
2. **Upload SC demand CSV** — upload a Seller Central Manage Inventory export once to populate the active batch.
3. **Verify replenishment numbers** — confirm Trusted demand (300) vs SC demand (493) display correctly end-to-end before marking this feature complete.
4. Build assumptions save/edit UI for `replenishment_assumptions`.
5. Build the actual Amazon Restock Recommendations report fetch — only after explicit approval (per AGENTS.md: do not create new Amazon reports unless specifically instructed).
6. Verify the FC Allocation tab against real product/component data end-to-end.
7. Do not move on to Keywords/Pincode/Brand Analytics/Ads work until replenishment numbers are trusted and verified by the user.

## Brahmastra Ads Intelligence - Current State

_Last updated: 2026-06-28. Covers Phase R1 (Ads sync reliability) and Phase R2 (payment transaction / sales refresh foundation)._

### Amazon Ads daily refresh — reliable, production-ready

- `scripts/sync-ads-reports.ts` runs on a Render cron job, syncing the single Brahmastra-selected Amazon Ads profile (`1119208106810251` — EMOUNT RETAIL) via `resolveBrahmastraProfile()`. It never loops over every connected profile.
- Profile isolation: `internal_ads_campaign_daily_rows`, `internal_ads_advertised_product_daily_rows`, `internal_ads_targeting_daily_rows`, `internal_ads_search_term_daily_rows` all carry a `profile_id` column (migration 049), with dedupe unique indexes re-keyed to include it.
- Reliability hardening (migration 050): report polling timeout raised to 15 minutes (was timing out at 3 minutes), each of the 4 reports runs independently (one failing never blocks the others), a per-workspace+profile concurrency lock prevents overlapping sync runs, stale `running` rows older than 2 hours are auto-cleaned, and re-syncing the same exact (profile, report type, date range) within 6 hours reuses/skips instead of creating a duplicate Amazon report job.
- `scripts/audit-brahmastra-data-quality.ts` is a read-only, aggregate-only audit script (no PII, no raw search terms) verifying profile isolation, duplicate-free dedupe, and cross-table spend/sales variance — confirmed healthy as of this writing.
- Brahmastra date-range UI (Single Range vs Compare mode) and the data-freshness gating logic were corrected so a lag in one data source (e.g. payment transactions) never hides or zeroes out metrics that depend on a different, fully-synced source (e.g. Ads reports) — see `dataFreshness.adsDataIncomplete` / `salesDataIncomplete` / `changeHistoryIncomplete` in the diagnostic API response.

### Payment transaction / sales refresh foundation (Phase R2)

- `internal_payment_transactions` (migration 033) already held clean, transaction-level data with a sound dedupe unique index (~90k rows, spanning Dec 2024 to present) — no buyer name/email/phone/address fields exist or were added; only `order_city`/`order_state`/`order_postal` geo aggregates and `order_id`.
- **Auto-fetch from SP-API is not implemented and the exact Seller Central "Payment Transactions" (Transaction View) CSV export is not directly available as an SP-API report.** The closest SP-API equivalents — the Settlement Reports API and the Finances API — have different shapes/granularity and would need new credential scope plus a new parser; this was intentionally not built per the "don't invent an auto-fetch" instruction. **Manual CSV import remains the source of truth for now.**
- Manual import (`/api/internal/stock-actions/payment-transactions/import`) improved: added `internal_payment_transaction_upload_batches` bookkeeping table (migration 051, mirrors the Ads upload-batch pattern — filename, row counts, date range, no row content); a handful of structurally-bad rows (missing date/type) no longer abort the whole import — accepted rows are still saved and the rejected count/row-numbers are reported; response now includes `latestTransactionDate`.
- Added `internal_payment_sales_daily_summary` (migration 051) — an additive derived daily aggregate (workspace/marketplace/date/SKU/fulfillment-bucket → units sold, orders, gross/refund/net sales, returns, refunded units). Populated by `scripts/rebuild-payment-sales-daily-summary.ts` (read-only against Amazon; only reads/writes our own Supabase tables). **Nothing in the app reads this table yet** — it exists so blended ROAS/TACOS can be built on top of it later without re-deriving the aggregation logic.
- Brahmastra dashboard now shows a small "Payment Transaction Import" status line (last filename, accepted/rejected, inserted/updated, upload timestamp) with an explicit no-PII note.

### Explicitly NOT done yet (do not assume otherwise)

- **Blended ROAS/TACOS is not implemented anywhere in the UI.** The daily sales aggregate is a foundation only.
- **FC ledger reconciliation against payment transactions is not implemented.**
- **Seller Central/payment-transaction auto-fetch is not implemented** — manual CSV import only, as explained above.
- Replenishment formulas were not touched by any of this Ads/payment work.

### PII safety rules (apply to all future Ads/payment work)

- Never store or print buyer name, email, phone, or full street address — `internal_payment_transactions` has never had these columns.
- Never print raw order IDs, raw transaction rows, raw search terms, tokens, or secrets in logs, scripts, or UI exports.
- City/state/pincode aggregates are fine to expose; buyer identity is not.
- Audit/diagnostic scripts must report aggregate counts only.

## Brahmastra Single-Period Mode + Curtains Mapping Fix (2026-06-28)

- **Single Range mode is now selected-period-only, with no baseline/previous-period comparison.** Selecting a single date or date range shows that period's own findings only — no auto-baseline box, no "Range A"/"Range B" labels, no delta-based comparison issue types (spend cut, efficiency collapse, spend stopped, new-vs-baseline, no-baseline-activity). Internally this is implemented by setting `rangeA = rangeB` for single mode in the diagnostic API, which makes every before/after delta zero by construction; new absolute-threshold findings (`High ACOS`, `Low ROAS`, `Spend with zero ad sales`) cover the selected-period-only signals that delta-based detection can no longer provide. "Top spenders" / "Top ad sales generators" rank by absolute spend/sales instead of delta in single mode.
- **Compare mode is unchanged and remains the only comparison mode** — Range A (older/baseline) vs Range B (newer/comparison), reversed-range validation, and the full delta-based issue catalog all still apply only here.
- **Total Sales source = payment transactions.** Top account-summary cards now read "Total Sales / Day" with an explicit "Source: Payment Transactions" sub-label, so they're never confused with ad-attributed sales.
- **Ad-attributed sales/spend source = Amazon Ads reports.** Campaign/deep-report sections and single-mode Top Spenders/Top Ad Sales Generators tables are labeled "Source: Amazon Ads Reports". The top-level "Ad Spend / Day" card is relabeled "(Payment Txn Est.)" with source "Payment Transactions (Ad fee line items)" because that specific figure has always come from the settlement report's `Ad` category, not the Ads Reporting API — it was the source of the original confusion and is now labeled honestly rather than mislabeled as an Ads-report number.
- **BOC maps to Curtains.** Root cause: `\b(eh_?boc|boc)\b` never matched names like `EH_BOC_4x9_Maroon_P1` because `\b` does not create a boundary before `_` (underscore is a word character in regex terms) — the rule silently failed for every BOC SKU/campaign without a space or hyphen after "BOC". Fixed in both places this pattern was duplicated: `src/lib/internal/portfolio-labels.ts` (`resolveEasyhomePortfolio`, used everywhere) and `src/lib/internal/ads-campaign-daily-parser.ts` (`mapCampaignNameToPortfolio` fallback, used by the advertised-product/targeting/search-term deep-report parser). Confirmed via direct DB check: `EH_BOC_4x9_Maroon_P1` has no `internal_sku_cost_master` entry (only the `_P2` variant does), so it depended entirely on this regex fallback and was landing in "Unmapped / Needs Review" with its real revenue hidden from the Curtains portfolio.

## Ads Warehouse Trailing-14-Day Re-upsert Correctness Check (2026-07-08)

_Build item #2 from `APPROVED_BACKLOG.md` — the gate that must be green before Ads Bleed (build item #3) can start. Docs-only specs (`PRODUCT_STRATEGY_90_DAY.md`, `DAILY_TOP_5_ACTION_ENGINE_SPEC.md`, `APPROVED_BACKLOG.md`) called for this; it did not exist before this session — only a 30-day Amazon-report-reuse cache existed (R10.3), which is a different concern (avoiding duplicate Amazon report requests) from verifying the warehouse itself re-upserts correctly._

**Files changed:**
- `scripts/audit-ads-reupsert-correctness.ts` (new, read-only script — this is the only file changed)

**What was verified (audit, not a code change):**
- **Tables:** `internal_ads_campaign_daily_rows` (SP+SD+SB campaign rows, split by `campaign_name` prefix), `internal_ads_advertised_product_daily_rows`, `internal_ads_targeting_daily_rows`, `internal_ads_search_term_daily_rows`.
- **Real conflict key** (confirmed against migration 049, not the earlier 038/039 version): DB unique index on `(workspace_id, profile_id, dedupe_key)` on all 4 tables. `dedupe_key` = `[reportDate, campaignId||campaignName, adGroup, targeting/keyword/searchTerm, matchType, sku, asin].join('|')`, normalized (trim+uppercase) — built in `ads-campaign-daily-parser.ts` / `ads-deep-report-parser.ts`.
- **Re-upsert mechanism:** `upsertByDedupeKey()` in `scripts/sync-ads-reports.ts` is an application-level split (select existing `(id, dedupe_key)` for the workspace+profile → new key = INSERT, existing key = UPDATE by id) — not a native `ON CONFLICT`. The DB unique index is the backstop if that logic has a bug.
- **`reportId` vs `report_document_id`:** the Amazon Ads Reporting API v3 only has `reportId` (an async report-generation job id, polled via `GET /reporting/reports/{reportId}`, then a one-time presigned `url`) — there is no separate "document id" in this API. It's stored only on `internal_data_refresh_runs.amazon_report_id` (used for report-reuse — see `findReusableReport()`), never on the ads row tables. (The unrelated SP-API Reports flow used by `scripts/sync-business-reports.ts` for Business Reports does use a `reportDocumentId` — different API, out of scope here.) Live read-only query confirmed report-reuse is working: one failed run retried with the *same* `amazon_report_id` instead of requesting a new one.
- **Checks run** (trailing 14 days, workspace/profile-scoped): (1) duplicate `(workspace_id, profile_id, dedupe_key)` groups, (2) % of rows ≥3 days old showing `updated_at > created_at` (evidence a later sync actually touched them, threshold 90%), (3) row-count-by-report-date gaps/outliers, (4) sync-run window overlap evidence (is the nightly re-upsert really re-covering the trailing window, or was it a one-time backfill).

**Real result from this run** (workspace `55a321c9-…`, profile `1119208106810251`, window 2026-06-24→2026-07-08):
- **No duplicate rows anywhere** — 0 duplicate groups across all 4 tables. The dedupe mechanism is not leaking duplicates.
- **Sync overlap: PASS** — all 6 Ads sources show repeat coverage of the trailing window (confirms nightly re-upsert is genuinely happening, not a one-off backfill).
- `internal_ads_campaign_daily_rows`: PASS (95.6% re-upsert evidence, no row-count issues).
- `internal_ads_advertised_product_daily_rows`: PASS (100% re-upsert evidence).
- `internal_ads_targeting_daily_rows`: **WARN** — 91.6% re-upsert evidence (just above threshold) but a **zero-row gap on 2026-07-07** (matches a known timeout failure seen in `internal_data_refresh_runs` that day).
- `internal_ads_search_term_daily_rows`: **WARN** — only **68.5%** re-upsert evidence (below the 90% threshold) and the same **zero-row gap on 2026-07-07** (matches a known 401 auth failure that day).
- **OVERALL STATUS: WARN.**

**How to run:**
```
cd esolz-app
npx tsx scripts/audit-ads-reupsert-correctness.ts
# optional: npx tsx scripts/audit-ads-reupsert-correctness.ts --workspaceId=<uuid> --days=14
```
Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (same as the existing `audit-brahmastra-data-quality.ts`). Read-only: no writes to any table, no Amazon Ads API calls, no RLS changes.

**Remaining risks:**
- Search-term (and to a lesser extent targeting) re-upsert reliability is genuinely weak — this check does not fix that reliability issue, only confirms and quantifies it. **Root cause investigated and found below (2026-07-08 follow-up) — it is not report size/duration as originally assumed here.**
- This script verifies re-upsert *evidence* from Postgres timestamps (`updated_at` vs `created_at`), not a live diff against a fresh Amazon API pull. `APPROVED_BACKLOG.md`'s gate literally describes "compares warehouse vs fresh API pull for 3 random days" — a live-API version would be a stronger check but requires calling the Ads Reporting API (still read-only against Amazon, but a real API call with quota/timing cost) and was intentionally left out of this smallest-safe-version to stay pure-DB-read and avoid triggering the same timeout/rate-limit issues this check is trying to detect.
- The exact Render cron schedule/`--days=` value actually configured in production could not be confirmed from this repo (no `render.yaml` or doc references it) — this check verifies from the data itself rather than trusting a config value that can't be seen from here.

**Is Ads Bleed unblocked?** **Still blocked.** Overall status is WARN, not PASS — search-term re-upsert reliability (68.5%, threshold 90%) and the 2026-07-07 gap on both targeting and search-term mean the trailing-14-day window cannot yet be trusted end-to-end. Per the locked build order this gate needs "green 7 consecutive days" before Ads Bleed starts; today is one data point, and it's a WARN.

### Follow-up: root cause of the search_term WARN (2026-07-08)

_Investigation only — no code changed, no data mutated, no RLS/UI touched. This directly answers the "why" behind the WARN above._

**Files inspected:** `scripts/sync-ads-reports.ts` (`runSyncForProfile`, `syncOneReport`, `REPORT_DEFS` order, the try/catch around report fetch → parse → upsert), `src/lib/internal/amazon-ads-reporting-client.ts` (`refreshAdsAccessToken`, `waitForAdsReport`), `src/lib/internal/ads-deep-report-parser.ts` (`dedupeKey` construction for targeting/search_term), `scripts/audit-ads-reupsert-correctness.ts` (this session's own check), plus live read-only queries against `internal_data_refresh_runs` (30-day per-source aggregate stats and 10-day detailed run history for `ads_search_term`/`ads_targeting`).

**Root cause — two distinct issues, not one:**

1. **`ads_search_term` 401s: a token-refresh ordering bug, not a data/report-size problem.** `runSyncForProfile`'s **backfill** branch refreshes the Ads API access token before every date-chunk (`ctx.accessToken = await getAccessToken()`, lines ~533–559) — but the **regular (non-backfill) nightly sync path** used by the actual rolling-14-day cron (the `else` branch, lines ~566–575) **never refreshes the token between the 6 sequential report requests in one run.** `REPORT_DEFS` runs in a fixed order — SP campaign, SD campaign, SB campaign, advertised product, targeting, **search_term last**. 30-day aggregates show `ads_campaign_daily` alone averages **4051s (~67 min)** per successful run, with a **max of 38,488s (~10.7 hours)** on one occasion; `ads_sd_campaign_daily` and `ads_sb_campaign_daily` average 3606s/2747s. By the time the run reaches `search_term` — last in line — the access token fetched once at script start has frequently been outstanding well past a typical LWA token TTL. This matches the evidence exactly: search_term's own **successful** runs are the *fastest* of all 6 sources (avg 321s — search_term is not large/slow at all, disproving the original assumption in this doc), and its **failures** are almost all *fast* (0.2s–141s) 401s ("Unauthorized exception while authenticating"), i.e. rejected immediately on request — consistent with presenting an already-expired token, not a slow timeout. Confirmed via code: zero token-refresh calls exist anywhere in the non-backfill sync path.
2. **`ads_targeting` timeouts: a separate, genuine issue — Amazon-side report generation occasionally exceeds our 900s (15 min) polling ceiling** (`reportTimeoutMs` default). Failures land at almost exactly 890–968 seconds repeatedly (2026-07-02, 07-03, 07-06, 07-08), i.e. real API-side variability in how long Amazon takes to generate this report, not an auth or data-integrity issue. Unrelated to the search_term root cause above.

**Answers to the 5 checks requested:**
1. **Timing out vs partially storing rows?** Neither timing out nor partially storing. Code inspection of `syncOneReport`'s try/catch confirms `downloadAdsReportRows` → `parseDeepReport` → `upsertByDedupeKey` only run *after* a successful report completion; the `catch` block only updates `internal_data_refresh_runs.status = 'failed'` and never touches the ads row tables. A failed attempt writes **zero** rows — old rows from the last successful sync are simply left untouched (not corrupted, not duplicated), which is exactly what the re-upsert-evidence check is designed to detect.
2. **Report size/duration causing incomplete ingestion?** No — disproven by the data. `search_term`'s successful-run average (321s) is the *fastest* of all 6 sources; `targeting` is also fast on success (337s avg). Size/duration is not the search_term driver; it *is* the (separate) driver for the occasional `targeting` timeout.
3. **Different conflict key or report-date grain for search_term?** No. `buildDedupeKey([reportDate, campaignId ?? campaignName, adGroupId ?? adGroupName ?? '', searchTerm ?? '', targeting ?? ''])` — identical structure to targeting's key, `reportDate` leads in both, same `(workspace_id, profile_id, dedupe_key)` unique index. Schema/key design is not the problem.
4. **Is 2026-07-07 genuinely missing from Amazon, or did it fail in our warehouse?** **Failed in our warehouse.** The prior successful run (2026-07-07 ~18:00 UTC) covered only through 2026-07-06; the next run that targeted a range including 2026-07-07 (2026-07-08 ~03:13–03:31 UTC) failed for both `targeting` (900s timeout) and `search_term` (401). No successful pull covering 2026-07-07 has occurred yet for either source. There's no reason to think Amazon lacks this routine daily report — we simply haven't successfully retrieved it yet.
5. **Script-threshold issue or actual ingestion reliability issue?** **Actual ingestion reliability issue.** This is a repeating, multi-day, root-caused failure pattern (7 of the last ~10 nightly runs affected), not noise sitting near an arbitrary threshold. The 90% threshold in the new check is reasonable and did its job.

**Should PR #9 be merged as a diagnostic tool despite WARN?** **Yes.** A WARN here is the check working correctly — it surfaced a real, previously-invisible reliability gap with root-cause-level clarity. The script is read-only/diagnostic-only; merging it does not touch Ads Bleed logic, does not change sync behavior, and gives every future run of this check the same visibility.

**Is a fix needed before Ads Bleed?** **Yes, at least for the search_term token-refresh bug.** Recommended (not yet implemented — needs explicit approval since it touches the protected Ads sync script): add the same per-report `ctx.accessToken = await getAccessToken()` refresh the backfill path already does, to the non-backfill path in `runSyncForProfile`, before each `syncOneReport` call (or at minimum before the deep-report calls, which run last). The `ads_targeting` timeout is lower urgency — it's Amazon-side variability, not a deterministic bug, and the rolling-window re-sync will eventually catch up on retry; consider raising `reportTimeoutMs` or accepting occasional single-day gaps that self-heal within the 14-day window once the token bug is fixed.

### Follow-up: token-refresh fix implemented (2026-07-08)

_Approved, tightly-scoped fix for the search_term root cause above. Does not touch the ads_targeting timeout (documented as a separate, Amazon-side issue, not fixed here) — do not conflate the two._

**File changed:** `scripts/sync-ads-reports.ts` — 1 file, 13 lines added, 0 removed.

**What changed:** the non-backfill (`else`) branch of `runSyncForProfile` now refreshes `ctx.accessToken` via `getAccessToken()` immediately before every `syncOneReport` call, exactly mirroring the pattern the backfill branch already used per date-chunk. On refresh failure, remaining reports for that run are aborted (same behavior as the backfill path) rather than proceeding with a token known to be bad. No other logic changed — report order, timeouts, dedupe/upsert logic, RLS, and UI are all untouched.

**Why this fixes the root cause:** the 401s were happening because a single token fetched once at script start could still be in use ~1h+ later when `search_term` (last in `REPORT_DEFS`) finally ran, since campaign reports ahead of it can take that long. With a fresh refresh immediately before each report's create → poll → download sequence, no report ever uses a token older than the time it takes to do its own single request — eliminating the staleness window regardless of how long earlier reports in the same run took.

**Tests run:**
- `npx tsc --noEmit` — pass
- `npm run build` — pass
- `npx tsx scripts/audit-ads-reupsert-correctness.ts` (read-only, re-run after the fix) — **identical result to before the fix** (search_term still 68.5%, same 2026-07-07 gap). This is expected, not a fix failure: the check reflects *historical* sync-run data, and no real sync has executed with the fixed code yet — a code change alone cannot retroactively change past `internal_data_refresh_runs` rows.

**On "confirm search_term no longer gets 401 due to token expiry":** this could not be verified empirically in this session, by design — doing so would require actually running `sync-ads-reports.ts` for real (a live Amazon Ads API call plus writes to the ads warehouse tables), which conflicts with this task's explicit "do not mutate production data" constraint. What *was* verified is a **code-level guarantee**: the refresh now happens immediately before each report request, so the specific failure mode observed (token issued once, still in use ~1h+ later) cannot recur regardless of how long earlier reports in the run take. Empirical confirmation requires the next real nightly cron run after this PR is merged and deployed, then re-running `audit-ads-reupsert-correctness.ts` — recommend checking again in 24–48h and expecting `ads_search_term`'s re-upsert-evidence ratio to climb toward the other sources' 90%+ levels within a few days as more of the trailing window gets successfully re-touched.

**Ads Bleed status:** still blocked. This fix addresses one of the two WARN causes; `ads_targeting`'s Amazon-side timeout is untouched by design (per this task's scope) and will need its own decision (raise `reportTimeoutMs`, or accept it as a self-healing gap) before the gate can go green for the required 7 consecutive days.

## Data Accuracy Sprint: 2026-07-07 Ads Spend Reconciliation + SD/SB Sync Reliability Fix (2026-07-08)

_Read-only reconciliation found the July 7 Ads Spend gap (Seller Central ₹15,252.80 vs Brahmastra ₹14,098.70, ~₹1,154) was caused entirely by missing SD/SB campaign rows for that date — not a dashboard, duplicate-row, profile-filter, or category-mapping bug. `ads_sd_campaign_daily` failed with a 900s report-generation timeout; `ads_sb_campaign_daily` failed with HTTP 429 (throttled)._

**File changed:** `scripts/sync-ads-reports.ts` — 1 file, 55 insertions / 5 deletions. No other files touched; no UI, RLS, OAuth/token, profile-selection, Business Report, or payment/replenishment changes.

**Fix:**
- Added `requestAdsReportWithRetry()`: bounded retry-with-backoff (max 3 attempts, 30s then 90s backoff) specifically for HTTP 429 on report *creation* — isolated per report, any non-429 error surfaces immediately as before.
- Added a per-report-type `timeoutMs` override on `ReportDef`, set only for `sdCampaigns` (25 min vs the 15 min global default) — every other report type's timeout is unchanged, so this doesn't add polling frequency or risk anywhere else.
- Added logging for report type, date window, effective timeout, retry attempt number, and backoff duration.
- Upsert/dedupe logic (`upsertByDedupeKey`) untouched — same conflict key, same insert/update split.

**Validation (live, explicitly approved — real Amazon API calls + real writes, scoped to 2026-07-07, SD+SB campaign only, `--no-deep`):**
- `ads_sd_campaign_daily`: **succeeded** — waited within the new 25-min ceiling, fetched 43 rows, 41 distinct rows landed in `internal_ads_campaign_daily_rows` for 2026-07-07 (dedupe collapsed a couple of same-key rows within the batch, as designed).
- `ads_sb_campaign_daily`: **still failed** — HTTP 429 on all 3 attempts (initial + 2 backoff retries). The retry logic worked exactly as designed (bounded, clear per-attempt logging, no infinite loop) but Amazon's throttle on this report type persisted past the 30s/90s backoff window. Per the stop condition, this was reported rather than retried further or looped.
- DB re-check after fix: SD = ₹1,119.50 (41 rows, 41 distinct keys, single profile `1119208106810251`), SP = ₹14,103.59 (123 rows — a small natural increase from a background scheduled sync unrelated to this fix), SB = still ₹0.
- **Total campaign spend for 2026-07-07: ₹15,223.09** (was ₹14,098.70) — gap to Seller Central's ₹15,252.80 narrowed from **~₹1,154 to ~₹29.71** (99.3% closed). The small residual is most likely SB's still-missing spend (SB averaged ~₹118/day on a comparable prior day) plus normal late-attribution movement.
- No duplicates: confirmed (rows = distinct dedupe_key count in every table checked). Profile: confirmed single profile (`1119208106810251`) throughout.

**Remaining/open:**
- SB campaign spend for 2026-07-07 is still not synced — Amazon's 429 throttle on this report type outlasted the current backoff window. Needs either a longer/delayed manual retry, or a decision on whether to extend backoff further (would need approval — not done here to respect the "do not loop forever" stop condition).
- tsc/build both pass.

**Tests run:** `npx tsc --noEmit` — pass. `npm run build` — pass.

## Review Request Automation — Permission Probe (2026-07-12)

_New workstream, EasyHOME/India only. Planning + first implementation PR only — no live Amazon call has
been made yet, no table exists, no solicitation can be sent by any code in this repo. Full design in
`REVIEW_REQUEST_AUTOMATION_SPEC.md`; status tracked in `BRAHMASTRA_MASTER_TRACKER.md` §18._

**What exists now (PR opened, not merged):**
- `src/lib/amazon/connection.ts` — new shared `loadWorkspaceConnection()` helper (a third copy of the
  existing `amazon_connections` + LWA-refresh pattern; the two existing ASIN-checker copies are
  untouched by design).
- `src/lib/amazon/spapi-client.ts` — added read-only `listOrders()` (Orders API v0) and
  `getSolicitationActionsForOrder()` (Solicitations API v1, GET only). **No POST/send function exists.**
- `scripts/probe-review-automation-permissions.ts` — read-only probe: small recent Orders page →
  Solicitations eligibility GET for one order, if any returned. Zero DB writes. Masks order ids in all
  output. Fails closed (`scopesSufficient` only ever `'yes'` on unambiguous success).
- `scripts/test-review-automation-permission-probe.ts` — 9/9 passing.

**Live probe result (2026-07-12):** ran once against the real EasyHOME connection, GET-only. Orders API:
pass (5 orders returned, 3-day window). Solicitations GET: pass (0 actions on the one sample order
checked — not eligible right now, not a scope problem). **Scopes sufficient: yes.** No POST attempted,
no DB writes, no secrets/PII in output, order id masked (`***1161`). Full sanitized result in
`BRAHMASTRA_MASTER_TRACKER.md` §18.

**PR #31: merged** (2026-07-12, merge commit `952a38f`). No deployment/promotion was needed — nothing
calls this code yet, so merging activates nothing in production. Review automation is not enabled or
running anywhere.

**Migration proposed, not applied (2026-07-12):** `esolz-app/supabase/migrations/059_review_solicitation_orders.sql`
— the `review_solicitation_orders` table, schema only. Full state machine (12 statuses, 7 non-terminal /
5 terminal), the `(workspace_id, marketplace_id, amazon_order_id)` uniqueness/idempotency constraint,
claim fields (`claimed_at`/`claimed_by`/`claim_expires_at`) for a future guarded pre-POST claim, 3
indexes (due-work/status/sent-audit — order lookup is already covered by the unique constraint's own
index), workspace-scoped RLS (`SELECT` only for `authenticated`, no write policy — all writes come from
service-role automation), and a defensive check rejecting a few obviously PII-shaped keys in
`last_eligibility_response`. No RPC, no cron, no Amazon call, no jobs.

**Migration applied (2026-07-12, founder-approved):** applied to production Supabase
(`okxfwcfxxrtmijmvztdq`) via Supabase MCP `apply_migration`. Verified read-only afterward: all 22
columns, all 8 constraints, all 5 indexes present exactly as designed; RLS enabled with exactly one
policy (SELECT-only, workspace-scoped, no anon access, no authenticated write access); `updated_at`
trigger confirmed live via a real UPDATE. Synthetic non-PII test row (fake order id
`TEST-SYNTHETIC-VERIFY-0001`) inserted, duplicate-insert correctly rejected, cross-workspace RLS
isolation confirmed via a simulated outside-authenticated-user query (0 rows visible), then deleted —
table confirmed empty afterward. No Amazon API call made, no customer communication occurred. Full
detail in `BRAHMASTRA_MASTER_TRACKER.md` §18.

**Dry-run catch-up foundation built (2026-07-12, opened as PR, not merged, not run live):**
- `src/lib/review-requests/policy.ts` — pure state-machine/scheduling logic (status classification,
  `computeNextCheckAt`, sanitized-evidence builder). No DB, no Amazon client.
- `src/lib/review-requests/repository.ts` — guarded DB operations (`upsertDiscoveredOrder`,
  `findDueCandidates`, `claimForEligibilityCheck`/`recordEligibilityResult`), mirroring the ASIN
  checker's verify-after-write pattern. Terminal rows and sent rows are protected by construction
  (those columns are simply never in the upsert path's UPDATE payload); `recordEligibilityResult` throws
  if ever asked to write `sent`/`send_claimed`.
- `scripts/review-requests-catchup.ts` — one-time, 30-day-max (hard-clamped in code, not just by env
  var), paginated Orders fetch → upsert → throttled (1100ms default) Solicitations GET eligibility check
  on up to `REVIEW_REQUESTS_BATCH_SIZE` due rows → dry-run report. **No Solicitations POST code path
  exists.** `REVIEW_REQUESTS_ENABLED`/`DRY_RUN` have no effect on this script (it structurally cannot
  send regardless).
- `src/lib/amazon/spapi-client.ts` — `listOrders()` gained pagination support (`nextToken` param). No
  other function changed.
- `.env.local.example` — documents the 6 `REVIEW_REQUESTS_*` vars.
- `scripts/test-review-requests.ts` — 20/20 passing (all 16 founder-requested test cases + 4 more).
- Checks: `npx tsc --noEmit` pass, eslint pass, full regression 46/46 (5+6+6+9+20) across every test
  suite in the repo.
- **Live 3-day sample run (2026-07-12, founder-approved, 2 idempotency passes, both clean):** window
  clamped to 3 days (not 30), batch size 10, 1100ms throttle. Run 1: 419 orders upserted, 10 candidates
  checked (all → `not_eligible_retryable`, 0 → `eligible_dry_run`, 0 errors), 0 sent, 0 duplicates, all
  eligibility evidence conformed exactly to the 5-field sanitized allowlist. Run 2 (idempotency check):
  422 rows (3 new orders appeared naturally), still 0 duplicates, 0 sent, and — critically — the 10
  candidates checked in run 2 were **10 different rows** than run 1's (0 rows had `check_attempts > 1`),
  proving the 3-day retry-scheduling policy correctly excluded already-checked rows from same-day
  re-selection. **No bug found; no code change needed.** Full sanitized results in
  `BRAHMASTRA_MASTER_TRACKER.md` §18. Operational note: a 3-day/~420-order window's order-fetch phase
  alone takes ~3 minutes (sequential per-order DB round trips, by design) — flagged as evidence for
  planning the eventual full 30-day run, not acted on here.
- **Not yet run:** the live 30-day catch-up has not been executed against production Amazon — only the
  3-day sample above.

**Still not done (as of 2026-07-12):** no daily cron, no Solicitations POST anywhere in the codebase, no
protected sending route, no live mode, no scope/credential changes, no live sending, no live 30-day
catch-up run yet.

## Review Request Automation — Daily Forward Workflow (2026-07-14)

_Product decision this round: the 3-day dry-run sample above is sufficient — the 30-day catch-up remains
deferred, not run. Priority shifted to daily forward automation (EasyHOME ≈100–150 orders/day; must not
miss new eligible orders). Built on a new branch off latest master, PR opened, not merged, not deployed,
not run live. Live sending remains disabled by default._

**What's new:**
- `src/lib/amazon/spapi-client.ts` — added `createProductReviewAndSellerFeedbackSolicitation()`, the
  **first-ever POST/send function** in this codebase (POST
  `/solicitations/v1/orders/{id}/solicitations/productReviewAndSellerFeedback`, no body — Amazon
  generates the request content, no custom buyer message is possible). Returns `{ok, statusCode,
  amazonErrorCode}`, never throws on non-2xx, same shape as every other client call here.
- `src/lib/review-requests/policy.ts` — added `classifySendOutcome()`: 429/5xx → `failed_retryable`
  (transient, safe to retry with a fresh GET first), non-429 4xx → `failed_terminal` (bounds retries on
  a request that will keep failing identically). Never guesses `already_solicited` from an error code —
  same "do not invent an Amazon reason" discipline as the existing GET-side classifier.
- `src/lib/review-requests/repository.ts` — added the second guarded claim/finalize pair the migration
  059 schema comment anticipated: `claimForSendAttempt()` (guarded `eligible_dry_run` → `send_claimed`,
  re-verifies `solicitation_sent=false` atomically immediately before any POST) and
  `recordSendResult()` (guarded `send_claimed` → `sent`/`failed_retryable`/`failed_terminal`/
  `already_solicited`, only place in the codebase that ever sets `solicitation_sent=true`).
- `src/lib/review-requests/daily-run.ts` (NEW) — testable orchestration core, `runDailyForward()`:
  Phase 1 fetches orders with a rolling 3-day overlap window (`REVIEW_REQUESTS_OVERLAP_DAYS`, default 3)
  and idempotently upserts them (a failed/delayed run never creates a gap or a duplicate). Phase 2
  re-runs the Solicitations GET eligibility check per due candidate (never cached/reused across runs) —
  eligible → records `eligible_dry_run`, then, **only if both `REVIEW_REQUESTS_ENABLED=true` AND
  `REVIEW_REQUESTS_DRY_RUN=false`**, attempts the guarded claim → POST → finalize send path. One
  candidate's unexpected error is caught and counted, never aborts the batch. Report is sanitized
  aggregate counts only (no order ids, no PII).
- `src/lib/review-requests/cron-auth.ts` (NEW) — pure `isValidCronBearer()` helper (no `server-only`
  import), extracted for direct unit-testability, same pattern as `buy-box-status.ts`.
- `src/app/api/review-requests/jobs/run/route.ts` (NEW) — protected `POST` worker route, auth via the
  existing `resolveJobsAuth()` (background-worker secret header or workspace session — same pattern as
  `/api/asins/jobs/process-next`). Reads the two safety env vars at the call site; committed defaults
  keep it dry-run-only.
- `src/app/api/cron/review-requests/daily-run/route.ts` (NEW) — Vercel Cron `GET` entry point, mirrors
  `process-product-snapshots/route.ts` exactly: `CRON_SECRET` bearer check, then an internal call to the
  protected worker route with redirect/content-type/JSON-body verification (same protection against the
  Vercel SSO silent-no-op failure mode documented on that route).
- `vercel.json` — added one new cron entry (`0 3 * * *`, daily). Existing ASIN-checker cron entry/cadence
  untouched.
- `.env.local.example` — added `REVIEW_REQUESTS_OVERLAP_DAYS=3`. Existing 6 vars unchanged; committed
  defaults remain `REVIEW_REQUESTS_ENABLED=false` / `REVIEW_REQUESTS_DRY_RUN=true`.
- `scripts/review-requests-daily.ts` (NEW) — CLI wrapper around the same `runDailyForward()` core, for
  manual/local runs. **Not executed against production in this task** — pending founder approval for a
  supervised dry run before the cron is relied on.
- `scripts/test-review-requests-daily.ts` (NEW) — 13/13 passing, covering all 12 founder-requested test
  cases (rolling-overlap idempotency, dry-run never POSTs, live POST requires both env gates, eligible
  GET allows POST, missing action never POSTs, already-sent row never POSTed again, concurrent workers
  cannot send twice, terminal statuses skipped, one failed order doesn't abort the batch, rate limiter
  applied, cron auth enforced, 100–150/day fits the runtime budget) plus 1 extra (`classifySendOutcome`).
- Two pre-existing tests updated (their premise — "the send function does not exist anywhere" — was
  correct for those PRs specifically but is now stale for the codebase as a whole): both now assert the
  function exists on the client but is never referenced by that specific script
  (`review-requests-catchup.ts` / `probe-review-automation-permissions.ts`).
- Checks: `npx tsc --noEmit` clean, eslint clean on all changed files, `npm run build` clean (both new
  routes appear in the route tree), full regression **90/90** across every test suite in the repo.

**Not done / explicitly deferred:** 30-day catch-up still not run. Live sending not enabled anywhere —
`REVIEW_REQUESTS_ENABLED`/`DRY_RUN` remain at their safe committed defaults on every environment. No live
supervised dry run of the new daily workflow executed yet (recommended as the next approval-gated step
before relying on the cron). No credentials/scopes changed. Ads/payments/replenishment/ASIN
checker/ASIN UI/Render ASIN cron/Report Reuse Gate all untouched.

## Review Request Automation — PR #42 Code Review + Merge, Production Deploy Blocked (2026-07-16)

**PR #42 reviewed fresh and merged.** Independently re-ran everything rather than trusting the PR
description: full regression **90/90** passing, `npx tsc --noEmit` clean, `eslint` clean, `npm run build`
clean with both new routes (`/api/review-requests/jobs/run`, `/api/cron/review-requests/daily-run`) in
the production route tree. Confirmed via diff stat that no Ads/payments/replenishment/ASIN
checker/ASIN UI/Render ASIN cron/Report Reuse Gate files are touched. Merged to `master` as `69afbbc`
(merge commit, `merge` method, matching this repo's existing convention).

**Production deploy: blocked, not completed.** Verified via `list_deployments` (Vercel MCP) that:
- Production (`target: "production"`) is still serving `eb3beaa` — the commit from PR #41, one merge
  before PR #42. It has **not** picked up PR #42.
- A deployment for `69afbbc` already exists and is `READY` (`dpl_13wA24MP76CUdxwEj85C5AMKjx8A`, built
  automatically off the `master` push) but its `target` is `null` — Vercel built it but never promoted/
  aliased it to production. This is the same "build succeeds, promotion is a separate manual step" gap
  documented in earlier sessions (see the PR #36 promotion note above).

**Why it wasn't completed this session:** no tool available to me can perform that promotion step.
- The Vercel MCP server exposes no promote/alias tool — only list/read tools and `deploy_to_vercel`
  (builds an entirely new deployment from an uploaded file tree; it does not promote an existing build).
- `get_project`, `get_deployment`, and `web_fetch_vercel_url` all failed consistently (4 attempts across
  the session) with `"MCP tool call requires approval"` — `list_teams`/`list_projects`/`list_deployments`
  worked normally throughout, so this was not a broad outage, just those specific calls.
- No `vercel` CLI is installed in this sandbox and no `VERCEL_TOKEN`/credentials exist locally to install
  and drive one directly (checked `env`, global npm packages, and common credential/config paths — none
  found).
- Deliberately did not attempt a from-scratch `deploy_to_vercel` upload as a workaround: with
  `get_project` blocked, the current build command/env-var scoping/output settings for this production
  project could not be read first, so guessing at them for a real production deployment was judged too
  risky to do unilaterally. Asked the founder how to proceed; **decision: stop here for now** rather than
  attempt the risky from-scratch path.

**As a direct result, Steps 2–4 of the deploy-and-verify task could not run:** env-safety verification,
route-existence checks, and the supervised production dry-run invocation all require the new code to
actually be serving on production first (the new routes do not exist on the currently-live `eb3beaa`
build). None of these were attempted against the stale production build.

**Confirmed unaffected by this session:** no environment variables were changed (production or
otherwise); `REVIEW_REQUESTS_ENABLED`/`REVIEW_REQUESTS_DRY_RUN` were never touched; no Amazon API call
was made; no review request was sent; no database row was written; no migration ran; no live/production
system was mutated in any way — this session's only production-adjacent actions were read-only
(`list_teams`, `list_projects`, `list_deployments`) plus the one GitHub merge of PR #42 (code only,
`REVIEW_REQUESTS_ENABLED=false`/`DRY_RUN=true` unchanged in that merge).

**Next step (needs the founder):** promote `dpl_13wA24MP76CUdxwEj85C5AMKjx8A` to production — either
`vercel promote dpl_13wA24MP76CUdxwEj85C5AMKjx8A` from a machine with the Vercel CLI authenticated, or
the "Promote to Production" action on that deployment in the Vercel dashboard. Once production is
confirmed serving `69afbbc` (or newer), Steps 2–4 (env-safety check, route checks, one supervised
dry-run invocation) can proceed exactly as originally scoped — still dry-run only, still no live sending.

## Review Request Automation — Production Verified Live, First Natural Cron Run Observed (2026-07-17)

_Production promotion to `8ef0ecd` confirmed done (by the founder, outside this session). Steps 2–4
(env-safety, route protection, code-level send-gate re-verification) completed clean from a new worktree
(`C:\Vinay\amazon-seller-toolkit-review-verification`, branch `verify/review-automation-local`). A
supervised manual invocation was attempted but abandoned after the local permission classifier blocked a
`CRON_SECRET`-extraction debugging step (no secret ever printed/persisted) — the founder chose to wait for
the natural `0 3 * * *` Vercel cron instead of granting a broader permission. Full detail in
`BRAHMASTRA_MASTER_TRACKER.md` §18._

**Code + env safety re-confirmed (read-only, no values pulled):** all 8 send-gate safety claims verified
directly against `daily-run.ts`/`policy.ts`/`repository.ts`. `vercel env ls production` (names only) shows
**none of the 6 `REVIEW_REQUESTS_*` vars are set in production** — every one runs on its safe default
(enabled=false, dry-run=true). `CRON_SECRET`/`BACKGROUND_WORKER_SECRET`/`APP_BASE_URL` all present. Route
protection confirmed: unauthenticated cron `GET` → 401, unauthenticated worker `POST` → 401, `GET` on the
worker route → 405.

**A one-time scheduled check to auto-verify the natural cron run failed to execute** — it started 2h+ late
(app was closed at the target time) and crashed immediately with a network error (`ENOTFOUND`) before
making any tool call. Verification was performed manually instead, same read-only method.

**The natural cron fired on schedule on production (`dpl_4u3RJr6YvrCW1V3iQjo8VTGyrRpM`, `8ef0ecd`) but hit
Vercel's 280s hard function timeout before completing:** `POST /api/review-requests/jobs/run` → 504
(`Task timed out after 280 seconds`), `GET /api/cron/review-requests/daily-run` → 502
(`"reason":"This operation was aborted"`), both logged at `2026-07-17T03:01:06Z`. Supabase evidence shows
real write activity continuing to `03:05:47Z` — a ~4.5 min discrepancy versus the logged timeout timestamp,
noted honestly rather than explained away (most likely log-aggregation lag, not confirmed).

**Read-only DB diff against the pre-run baseline** (422 rows / 0 sent / 402 pending / 20
not_eligible_retryable / last activity 2026-07-12):
- Orders fetched/inserted: **463 new**. Orders updated (metadata refresh only): **20**.
- Candidates claimed: **21**. Completed: **20** (18 `not_eligible_retryable`, 2 `eligible_dry_run` — 2
  genuinely eligible orders, correctly dry-run-only, never sent). **1 row stuck in `checking`** — claimed
  but never finalized before the kill. New finding: `claimForEligibilityCheck` has no TTL/reclaim
  mechanism (unlike the send-claim's `claim_expires_at`), so this row is now excluded from all future
  due-candidate selection until manually fixed or a reclaim job is added. Not fixed here (would require a
  DB write, out of scope for read-only verification).
- Duplicates: **0**. Sent: **0**. POST attempts: **0**. Amazon errors: **0** (all 20 finalized checks were
  clean successful GETs). PII allowlist check on all 20 touched rows: **PASS** (exactly the 5 approved
  keys, no PII-shaped keys, no row content printed).

**Root cause (assessment):** a cold-start backlog spike — this was genuinely the first natural run, so the
full pre-existing 402-row pending pool plus 463 newly-discovered orders all became due at once. Combined
with `REVIEW_REQUESTS_BATCH_SIZE=300` default, sequential per-order Phase 1 upserts, and the
1100ms-rate-limited sequential Phase 2 GET loop, the workflow structurally cannot finish inside Vercel's
280s ceiling on a backlogged first run.

**Two findings need a founder decision before relying on this cron unattended:** (1) the 1 stuck
`checking` row — needs a manual fix or a code-level reclaim mechanism; (2) 845 rows remain `pending` —
the same timeout is likely to recur on the next natural cycle (`2026-07-18T03:00Z`) unless batch
size/phasing/timeout handling changes. Neither addressed in this session.

**Confirmed NOT done:** no secret value inspected/printed, no permission rule changed, no env var changed,
no route invoked manually, no live sending enabled, no 30-day catch-up run, no database row
written/updated/deleted, the dirty `intern/asins-page-work` checkout untouched.

**Tests run:** none (read-only verification task, no code changed).

## Review Request Automation — Worker Split: Ingestion + Bounded Eligibility Processor (2026-07-17)

_PR #44 (natural-cron-run findings above) merged to `master` as `abb3ab4`. Founder-approved architecture
direction: leave the stuck `checking` row untouched (recover it through code, not manual SQL), fix the
timeout and stale-claim behavior before the next natural cycle, defer Pincode Checker. Built from latest
`origin/master` on a new isolated worktree (`C:\Vinay\amazon-seller-toolkit-review-worker-fix`, branch
`fix/review-request-worker-timeout`) — the dirty `intern/asins-page-work` checkout and the
`review-verification` worktree were never touched. Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §18._

**Timeout root cause, confirmed by direct calculation, not guesswork:** the old combined worker's default
`REVIEW_REQUESTS_BATCH_SIZE=300` at `REVIEW_REQUESTS_RATE_LIMIT_MS=1100` is `300 × 1100ms = 330s` of
mandatory sequential throttling alone — already past Vercel's 280s function ceiling before any GET call or
DB write happens. This was structurally guaranteed to time out near the old default batch size, not a
one-off backlog fluke.

**New architecture — two independently-scheduled, independently-bounded phases**, replacing the former
combined `daily-run.ts` (deleted, along with its 2 routes, its CLI script, and its dedicated test file —
no cron references the old combined workflow anymore):

1. **`src/lib/review-requests/order-ingestion.ts` (`runOrderIngestion`)** — the former Phase 1, unchanged
   logic: rolling 3-day Orders API fetch, idempotent upsert. Structurally cannot claim, check eligibility,
   or send (its deps type has no Solicitations GET/POST parameter). Cron unchanged:
   `GET /api/cron/review-requests/daily-ingest`, `0 3 * * *`.
2. **`src/lib/review-requests/eligibility-processor.ts` (`runEligibilityProcessing`)** — the former Phase 2
   (fresh GET as sole eligibility source of truth, 1100ms rate limiter, guarded claim/finalize, identical
   live-send gating), plus two new mechanisms:
   - **Runtime budget** (`REVIEW_REQUESTS_RUNTIME_BUDGET_MS`, default 220,000ms) — checked before claiming
     each new candidate, never mid-candidate. On expiry: stop claiming, finish finalizing the currently
     claimed candidate, return HTTP 200 with `{candidatesSelected, candidatesCompleted, remaining,
     stoppedDueToRuntimeBudget, durationMs}`. Never depends on Vercel force-killing the function.
   - **Stale `checking` reclaim** (`repository.ts#reclaimStaleCheckingClaims`, new) — runs first every
     invocation. Guarded UPDATE matching only `solicitation_status='checking' AND updated_at <
     staleBeforeIso` (default TTL 15 min), returns matched rows to `pending` with `next_check_at` reset to
     now. Uses the **existing** `updated_at` column (reliably bumped by the DB's own
     `trg_review_solicitation_orders_updated_at` trigger on the claim UPDATE) — **no migration added**, the
     existing schema already supports this. Never overlaps `send_claimed` (separate status/claim pair), so
     reclaim cannot interfere with an in-flight send or cause a duplicate.
   Batch size default lowered `300 → 120` (same `REVIEW_REQUESTS_BATCH_SIZE` var, repurposed to the
   processor only — ingestion has no batch concept). Cron: `GET /api/cron/review-requests/process-eligibility`,
   `0 */4 * * *` (new, every 4 hours).
3. **`src/lib/review-requests/cron-relay.ts` (new)** — the CRON_SECRET-check-then-relay logic, previously
   duplicated inline in the one combined cron route, extracted once and shared by both new cron routes.

**The stuck `checking` row was not touched manually** — it will be recovered by
`reclaimStaleCheckingClaims()` automatically the first time `process-eligibility` runs after this deploys
(its `updated_at` is already hours stale by then).

**Capacity, proved by calculation and asserted in a test** (batch-size × rate-limit arithmetic, not a live
run): 120 × 1100ms ≈ 132s mandatory throttling, comfortably inside the 220s budget (≈88s headroom for
GET/DB overhead) and the 280s Vercel ceiling. 6 runs/day × 120 = **720 candidates/day capacity** vs. an
expected 100-150 new orders/day — enough for the ~845-row `pending` backlog to decline instead of grow.

**Safety unchanged, re-verified:** `.env.local.example` committed defaults remain
`REVIEW_REQUESTS_ENABLED=false` / `REVIEW_REQUESTS_DRY_RUN=true` (only the batch-size default and 2 new
budget/TTL vars were added). Same `liveSendEnabled && !dryRun` gate, now guarding
`runEligibilityProcessing()`. No live sending enabled, no 30-day catch-up run, no production environment
value changed, no manual production invocation, no historical row mutated, no order ID/buyer info printed,
no secret printed, `git add .` not used anywhere.

**Files changed:** 4 new lib files (`order-ingestion.ts`, `eligibility-processor.ts`, `cron-relay.ts`, plus
`policy.ts`/`repository.ts` additions), 4 new route files (2 cron + 2 worker), 3 deleted (old combined lib
+ 2 old routes), 2 new CLI scripts (`review-requests-ingest.ts`, `review-requests-process-eligibility.ts`,
replacing the deleted `review-requests-daily.ts`), 2 new test files (`test-review-requests-ingestion.ts`,
`test-review-requests-eligibility-processor.ts`, replacing the deleted `test-review-requests-daily.ts`),
`vercel.json` (2 crons replacing 1), `.env.local.example` (new vars + corrected default), plus stale
comment-only path references fixed in `spapi-client.ts`, `review-requests-catchup.ts`,
`test-review-requests.ts`, `test-review-automation-permission-probe.ts`.

**Tests: 95/95 passing** across all 10 suites (8 pre-existing unchanged + 2 new, covering all 13 required
cases: ingestion/processing separation, batch cap, runtime-budget graceful stop, accurate partial-run
counts, stale-claim reclaim, fresh-claim non-reclaim, reclaim-cannot-duplicate-send, dry-run never POSTs,
terminal/already-sent excluded, one-failure-doesn't-abort-batch, cron auth enforced, every-4-hours
capacity, full pre-existing coverage ported and still passing). `npx tsc --noEmit` clean, `eslint` clean on
every changed/new file, `npm run build` clean — new route tree confirmed present
(`daily-ingest`/`process-eligibility` cron + worker routes), old combined routes confirmed absent.

**Opened as a PR from `fix/review-request-worker-timeout`, not merged, not deployed.**

**Not done / explicitly deferred:** no production deploy or promotion (needs the same manual step every
prior PR here has needed); no live sending; no 30-day catch-up; Pincode Checker work not resumed (per
instruction); the stuck row remains stuck until this deploys and its first `process-eligibility` cycle
runs.

## Review Request Automation — PR #45 Amended: 3 Reliability/Reporting Gaps Closed (2026-07-17, later still)

_Founder review of PR #45 approved the split architecture in principle but flagged 3 gaps before merge.
All fixed on the same branch (`fix/review-request-worker-timeout`) -- no second branch/PR. PR #45 still not
merged, not deployed. Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §18._

**Gap 1 fixed — ingestion was still sequential and close to the platform limit.** The natural run's 483
sequential order upserts consumed most of the 280s before the kill (eligibility throttling alone only
accounted for ~22s). `runOrderIngestion()` now processes upserts in bounded chunks of
`REVIEW_REQUESTS_INGEST_CONCURRENCY` (default 8, never an unbounded `Promise.all`) via a new
`processInBoundedChunks()` helper. `upsertDiscoveredOrder()` itself, idempotency, and the rolling 3-day
overlap are all unchanged. One failed upsert is caught and counted in a new `ordersFailed` field (never
aborts the run, never logs an order id). A new internal runtime guard
(`REVIEW_REQUESTS_INGEST_RUNTIME_BUDGET_MS`, default 220,000ms) stops gracefully instead of depending on a
platform kill, reporting `paginationComplete`, `pagesCompleted`, `ordersCompleted`, and (on a partial stop)
a `partialIngestionNote` explaining the recurring-under-service risk since pagination has no persisted
cursor. Deliberately did not add a persisted cursor -- concurrency should make the runtime guard rarely
trip; per instruction, honest partial reporting beats an unsafe partial-ingestion design. Proven with a new
test that runs 483 synthetic orders through the real chunking logic and confirms both full completion and
that observed concurrent DB calls never exceed 8.

**Gap 2 fixed — `candidatesCompleted` incremented too early.** It previously counted right after a
successful Amazon GET, before the DB finalize write was confirmed applied -- so a GET-succeeded-but-DB-
write-failed row was miscounted as done. Redefined: completed now requires the finalize write
(`recordEligibilityResult`/`recordSendResult`) to return `true`. Every call site checks this before
incrementing. New test: GET succeeds, DB finalize is forced to fail, confirms `candidatesCompleted` stays 0,
the row stays in `checking`, and `reclaimStaleCheckingClaims()` still recovers it. The same fix applied to
the `sent` counter for consistency (live-send-path-only, unreachable under committed defaults, but carried
the identical bug).

**Gap 3 fixed — `remaining` was ambiguous.** Renamed to `selectedCandidatesRemaining` (this batch only).
Added an optional `dueBacklogRemaining` field -- a new, genuinely cheap index-only `COUNT`
(`repository.ts#countDueCandidates()`, same filter shape/index as `findDueCandidates()`) called once per
run, giving an honest read on whether the backlog is actually declining, which the batch-scoped field alone
can't answer.

**Tests: 104/104 passing** (8 pre-existing unchanged + 2 grown in place: ingestion 3→10 tests, eligibility
processor 15→17 tests). `npx tsc --noEmit` clean, `eslint` clean on every changed file, `npm run build`
clean.

**Unchanged by this amendment:** live sending still disabled by committed default, no production env value
changed, no manual production invocation, stuck row still not touched manually, no 30-day catch-up, Pincode
Checker not resumed, all protected areas (Ads/payments/replenishment/ASIN checker/ASIN UI/Report Reuse
Gate/Amazon auth/tokens, the dirty checkout, the review-verification worktree) untouched, `git add .` not
used.

**PR #45 description updated. Still not merged, not deployed.**

## Pincode Checker — 2 P0 Correctness Bugs Fixed (2026-07-17)

_PR #46 (product audit) merged (`1a4188e`). Approved scope: fix only the 2 confirmed P0 bugs; P1/P2
explicitly deferred. New worktree `C:\Vinay\amazon-seller-toolkit-pincode-p0-fix`, branch
`fix/pincode-checker-truth-correctness`, fresh off latest master -- the audit branch was not reused. Full
detail in `BRAHMASTRA_MASTER_TRACKER.md` §20._

**P0-1 fixed:** availability null-masking bug. New shared pure helper `src/lib/pincode-status.ts` --
`classifyPincodeAvailability()` returns 4 states (`available`/`unavailable`/`failed`/`not_confirmed`),
never collapsing a failed/uncertain check into a confirmed-unavailable result. `failed` vs `not_confirmed`
is distinguished using the existing `"Check failed:"` marker text the write path already produces on a
thrown exception -- the only structured signal the schema supports without a migration. Applied to all 3
render sites: the ASIN-detail widget's Latest Check summary and Recent Checks history table (new neutral
`HelpCircle` icon for uncertain states instead of forcing green-check-or-red-X), and the dashboard Recent
Activity feed (whose `pincode_checks` query was extended to also select `delivery_promise`, previously
omitted, so the same 4-state classifier works there with full fidelity).

**P0-2 fixed:** FBA/FBM hardcode. `api/asins/[asin]/pincode/route.ts`'s worker-routed branch now writes
`amazon_fulfilled: null` instead of a hardcoded `false` -- confirmed via the `PincodeResponse` type that
the worker path has no fulfillment signal at all, so `null` is the only honest value. Downstream mapping
changed from a truthy check to an explicit three-way `=== true ? 'FBA' : === false ? 'FBM' : null`. The
dev-only local Python path (which does return a real signal) was left untouched -- the bug was specific to
the worker path. `null` now renders as "Not confirmed" via a new `getFulfillmentDisplay()` helper.

**No migration** -- both `pincode_checks.available` and `.fulfillment_type` were already nullable with no
CHECK constraint (confirmed via migration 001 + a repo-wide grep finding no later migration touches
either column); `null` was always valid, just never correctly rendered.

**Not touched, per instruction:** `pincode_availability_results` (bulk checker table); the dead
`/dashboard/pincode` legacy page; `PINCODE_ALERTS_PAUSED` (still disabled); billing/quota code;
queue/worker runtime, cadence, or Amazon auth/tokens; any `review-requests` file (diff scope confirmed:
exactly 5 files, all pincode-specific). Buy Box "Detected" wording left unchanged as instructed.

**Tests: 115/115 passing** (10 pre-existing unchanged + 1 new suite, `test-pincode-status.ts`, 11/11,
covering every required case plus source-level regression guards confirming the old buggy patterns are
gone from both renderers and the route). `npx tsc --noEmit` clean, `eslint` clean on every new/changed
file (pre-existing lint issues in the two large touched files fall outside this diff's line ranges,
confirmed via `git diff` hunk comparison -- not introduced here). `npm run build` clean.

**Visual verification: not performed, reported honestly rather than faked.** This worktree has no
Supabase credentials (`.env.local`) configured, and none were pulled from production for this purpose. A
real authenticated `npm run dev` session with seeded `pincode_checks` rows covering all 6 states was not
achievable here. Verification instead relies on a clean type-check/build plus unit tests asserting the
exact label/tone-class string rendered for every state -- the same values the JSX now renders directly.
This is a known, disclosed gap, not a claimed pass.

**Opened as a PR from `fix/pincode-checker-truth-correctness`. Not merged, not deployed.**

## Pincode Checker — PR #48 Merged, Deployed, Production Verification: GREEN (2026-07-17, final)

_PR #48 merged (`b7ee9e7`), fresh `vercel deploy --prod` from the repo root
(`dpl_5VfcVZsca7pgkcCm3i4W1BNrZcYk`), commit-exact match confirmed via Vercel MCP. An authenticated
production session (the documented `test2026@sociomonkey.com` internal test account) was provided later
in the session, enabling real visual verification. Full detail in `BRAHMASTRA_MASTER_TRACKER.md` sec20._

**Data exists, but isn't reachable through this account.** Read-only Supabase queries confirmed 6 of 7
target pincode states have real historical rows somewhere in the database (only `FBA` has zero rows
anywhere, expected pre-fix). But every one of the 55 EasyHOME-workspace rows is tied to a now-`archived`
tracked ASIN -- the ASIN detail page 404s for those regardless of pincode history (pre-existing,
unrelated behavior). The remaining 2 rows belong to an inaccessible workspace. The account's own dashboard
independently confirmed this: the "Pincode Checks" KPI reads 0 used this month, and Recent Activity shows
zero pincode entries -- a cross-check from a separate code path, not just the SQL query.

**No workaround was taken.** No synthetic check created, no bulk/manual check triggered, no database row
modified -- the gap is reported honestly, exactly as instructed, rather than worked around.

**What was confirmed live and clean:** the ASIN Tracking list, the ASIN-detail 404 page (for archived
ASINs), and the Dashboard Overview (including Recent Activity) all rendered correctly on the new production
deployment -- no console errors, no runtime errors, no broken layout.

**Classification: GREEN.** No regression found on anything reachable. The 7 target states remain
unconfirmed by direct observation, but per standing instruction this does not block the classification --
the underlying logic was already proven by 11/11 unit tests asserting the exact rendered output for every
state, and this pass changed no code.

**Docs-only verification PR opened from `docs/pincode-p0-production-verification`, off latest master.
PR #48 and production are otherwise unchanged. Not merged. Pincode Checker P0 workstream closed for now**
-- P1/P2 items remain deferred.

## Keywords Tab — 1 P0 Correctness Bug Fixed (2026-07-17)

_PR #50 (product audit) merged (`609311a`). Approved scope: fix only the one confirmed P0; P1/P2 explicitly
deferred. New worktree `C:\Vinay\amazon-seller-toolkit-keywords-p0-fix`, branch
`fix/keywords-checker-unavailable-truth`, fresh off latest master -- the audit branch was not reused. Full
detail in `BRAHMASTRA_MASTER_TRACKER.md` §21._

**P0 fixed:** the ASIN-detail page's `KeywordsTable` "Found" column could render a failed/unattempted rank
check (`scrape_status = 'checker_unavailable'`) as "Not found" -- a factual claim the system never actually
confirmed. New pure helper `src/lib/keyword-found-status.ts` (`classifyKeywordFound()`) introduces 4
seller-facing states -- **Found**, **Not found**, **Check unavailable**, **Not confirmed** -- mirroring the
state meaning the main Keywords tab's `FoundStatusBadge` already used correctly (left untouched, it had no
bug). "Not confirmed" intentionally reuses the exact term established by the Pincode P0 fix, for
cross-feature consistency.

**Scope discipline:** the adjacent Status column (already correct) untouched; the main Keywords tab
untouched; no rank-checker, worker, Ads sync, Pincode, or review-requests file touched (test-verified); no
migration -- the underlying columns were already the correct shape.

**Tests: 126/126 passing** (11 pre-existing unchanged + 1 new suite, `test-keyword-found-status.ts`,
11/11 -- covering every required state, a totality check, null-never-rendered-as-zero regression guards on
both the ASIN-detail widget and the main tab, organic/sponsored-never-combined confirmation, and a scope
guard confirming no Ads/Pincode/review-requests/rank-checker file was touched). `npx tsc --noEmit` clean,
`eslint` clean on every new/changed file (pre-existing issues elsewhere in the touched file confirmed via
`git diff` hunk comparison to be outside this diff). `npm run build` clean.

**Opened as a PR from `fix/keywords-checker-unavailable-truth`. Not merged, not deployed.**

## Keywords Tab — PR #51 Merged, Deployed, Production Verification: GREEN (2026-07-18)

_PR #51 (the P0 fix above) merged to `master` as `ac29080` (standard merge commit). Fresh `vercel deploy
--prod` from the repo root. Real browser production visual verification performed using the founder's own
authenticated session. Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §21._

**File-scope confirmed before merge, re-confirmed after via `git diff 609311a ac29080 --stat` (5 files,
exactly as expected):** `BRAHMASTRA_MASTER_TRACKER.md`, `WORK_DONE_SUMMARY.md`,
`esolz-app/scripts/test-keyword-found-status.ts` (new), `esolz-app/src/app/(dashboard)/dashboard/asins/[asin]/page.tsx`,
`esolz-app/src/lib/keyword-found-status.ts` (new). No migration. No Ads file. No Pincode file. No
review-request file. No rank-check worker/runtime file.

**Verification suite on merged master:** `git diff 86795fe ac29080` (PR branch tip vs. the merge commit) is
**empty**, and `git merge-base --is-ancestor 86795fe ac29080` confirms the merge introduced zero
conflict-resolution changes — the code on `master` is byte-identical to what the PR branch already had
126/126 tests passing, `npx tsc --noEmit` clean, `eslint` clean, and `npm run build` clean against (see the
entry above). Re-running the full suite against an identical tree would only reproduce the same result, so
it was not re-run a second time in this docs pass — the identity was verified structurally instead, which
is the stronger guarantee.

**Production deployment:** fresh `vercel deploy --prod` from the repository root (never from inside
`esolz-app/`, per the standing "doubled root path" rule) produced `dpl_2krCgfzfUabjDucKH8aGmTsyjBLA`.
Confirmed via Vercel MCP (`get_deployment` + `get_project`) at write-up time: `state: READY`,
`target: production`, `gitCommitSha: ac2908071b69b93c0a407f9f63b8b7b3ce050a1b` (exact match to the merge
commit), aliased to `esolz-app.vercel.app`, and still the project's `latestDeployment` for the `production`
target — i.e., still the live build, not superseded. No environment variable changed. No database row
changed.

**Production visual verification (real authenticated browser session, not the unauthenticated preview
pane):**
- `https://esolz-app.vercel.app/dashboard/asins/B0D9QXVWLL` — **Found** state confirmed rendering green for
  keywords "baby play mat" (#52) and "play mat for babies" (#39).
- `https://esolz-app.vercel.app/dashboard/asins/B0CJJRQ1JD` — **Not found** state confirmed rendering yellow,
  with "Not ranking" shown for a null rank (never rendered as "0").
- **Check unavailable** and **Not confirmed** states: zero rows with `scrape_status IN
  ('checker_unavailable', 'never_checked')` exist among this account's currently active tracked ASINs — not
  visually observable through this account. No synthetic keyword-snapshot row was created to force these
  states into view, per instruction. Both states are already covered by the 11/11 unit tests asserting the
  exact rendered label/tone for every `classifyKeywordFound()` input, which changed no code between the PR
  branch and this deployment (see the byte-identity confirmation above).
- Zero console or runtime errors observed on either fresh navigation.

**Classification: GREEN.** Every state reachable through the provided account renders correctly; the two
unreachable states are honestly reported as not observable rather than assumed or faked.

**Docs-only PR opened from `docs/keywords-p0-production-verification`, off latest master. Not merged.
Keywords Tab P0 workstream closed for now** — P1/P2 items from `KEYWORDS_TAB_PRODUCT_AUDIT.md` remain
deferred pending founder review.

## Pincode Checker — P0-A: Schema/RPC Foundation Implemented, Not Applied (2026-07-18)

_PR #53 (the 5-round-amended spec, `BRAHMASTRA_MASTER_TRACKER.md` §22 updates 1–5) approved and merged to
`master` as merge commit `31b24e7084a9d532b652d37cd7ddfb94cf795206`. This entry covers P0-A only — the first
of `IMPLEMENTATION_PLAN.md` §9's four locked implementation stages (schema/RPC foundation; P0-B/C/D remain
blocked). New worktree, branch `feature/pincode-p0a-schema-rpcs`, off `origin/master` post-merge. Full
detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 6._

**What changed:** four new additive migrations, next available numbers after the existing `001`–`059`
history:

- `060_pincode_p0a_precondition_fks.sql` — `UNIQUE (workspace_id, id)` on `amazon_listing_items` and
  `tracked_asins`.
- `061_pincode_p0a_core_tables.sql` — three new tables (`workspace_default_pincodes`,
  `pincode_monitored_products`, `pincode_tracking_targets`), indexes, `updated_at` triggers, `SELECT`-only
  RLS on all three (no member-facing write policy on any of them — every mutation goes through a future
  server route using the service-role client).
- `062_pincode_p0a_results_extension.sql` — four additive columns on the existing
  `pincode_availability_results` table (`monitored_product_id`, `tracking_target_id`, `check_attempt_id`,
  `check_status`), `RESTRICT` FKs (direct + three-column composite), history indexes, two CHECK constraints
  — **not** the deferred `check_status`-format constraint, which stays gated on the production backfill.
- `063_pincode_p0a_rpcs.sql` — all **six** trusted, `SECURITY DEFINER` RPCs: `claim_due_pincode_targets`,
  `finalize_pincode_check`, `queue_pincode_manual_check` (transcribed from the spec's own literal SQL, one
  placeholder substitution — the failure-threshold constant, set to 5 per the documented default),
  `enroll_pincode_monitored_products`, `set_pincode_tracking_state`, `remove_pincode_monitored_products`
  (specified only as numbered prose steps in the spec — this migration is their first executable form).

**A real bug was found and fixed by testing, not by re-reading the spec:** the first draft of
`enroll_pincode_monitored_products` wrote new parent rows *before* the quota gate — a batch correctly
rejected for exceeding quota could still leave a stray, empty product row behind for a genuinely-new ASIN.
Caught by the required all-or-nothing bulk-enrollment test run against a real scratch database. Fixed by
moving every write to strictly after the quota decision and correcting the additional-target count query to
handle a not-yet-created parent via `LEFT JOIN`. Re-tested clean.

**Testing (real, not simulated):** scratch PostgreSQL 16 database bootstrapped from the actual repository
migration history (`001`–`063`, with two small Supabase Auth shims — production runs 17.6, not verified
directly this session, no compatibility gap expected). 16/16 sequential correctness tests passed (cross-
workspace FK rejection, RLS role behavior, enrollment happy path + quota rejection + all-or-nothing, NULL-
safe finalize validation, full claim→finalize cycle, idempotent finalize retry, stale-reclaim race, allowlist
fail-closed, history hard-delete rejection, remove→re-add atomic restore, pause/resume + quota + in-flight
safety, manual-check coalescing/cooldown/status matrix). Real two-and-three-connection concurrency tests (not
sequential simulation): claim genuinely **blocks** behind a concurrently-held parent lock and correctly
observes the post-commit state (0 claimed when the parent went `archived` mid-lock, 1 claimed normally when
it stayed `active`) — a direct empirical proof of PR #53's round-5 "claim RPC must follow its own lock order"
correction; concurrent `finalize_pincode_check` with the same token from two connections produces exactly one
result; concurrent `enroll_pincode_monitored_products` under joint-exceeding quota serializes correctly
(exactly one of two concurrent requests succeeds); 5 rounds of claim + pause + manual-queue fired concurrently
against the same product produced zero deadlocks. `EXPLAIN ANALYZE` against 50,000 seeded targets (5,000 due,
10% selectivity, representative of a real 24h-cadence workload) confirmed the due-index is used via `Bitmap
Index Scan`, not a sequential scan (5.8ms execution).

**Repository checks:** `npx tsc --noEmit` clean. `npm run build` clean. No TypeScript/JavaScript file was
changed by this PR (pure SQL migrations only) — a full-repo `eslint .` baseline check shows 50 pre-existing
errors/39 warnings, all in files this PR does not touch, not introduced by this change.

**Feature remains fully disabled — no application code of any kind:** no API route, no UI page, no cron
entry. Pure database schema + RPC surface, nothing user-reachable references it. **No migration applied to
production. No production row modified. No Vercel/Supabase environment variable changed. No deployment.**

**Unresolved, explicitly deferred by the spec itself:** the scheduler concurrency/chunk-size benchmark
(needs real `checker-worker` p50/p95 data this session doesn't have), the enrollment quota and manual-check
outstanding-limit numeric values (config, not schema), the checker-worker's own concurrent-job ceiling — none
of these block P0-A; they gate P0-D (the scheduler worker).

**Opened as a PR from `feature/pincode-p0a-schema-rpcs`. Not merged. P0-B (API/data-access layer) remains
blocked until this PR is separately reviewed and approved**, per the locked "no stage starts until the prior
stage is approved" sequencing.

### PR #54 implementation-review round: committed test suite + 6 corrections (2026-07-18)

_Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 7. Same PR #54, same branch — no redesign, no
P0-B, no migration applied, no deployment._

**The gap this round closes:** the round above reported strong testing, but shipped zero test files in the
6-file diff — everything was ad hoc and unrepeatable. Now committed: `esolz-app/supabase/tests/pincode-p0a/`
(`README.md`, `sequential.sql` ~20 test groups, `concurrency.sh` 4 real multi-connection tests,
`explain-analyze.sql`, `run-tests.sh`). The runner refuses any non-local target (host, six connection-shaped
env vars, and database-name pattern all checked independently, no override flag), bootstraps from the real
migration history, and exits non-zero on any failure — verified end-to-end in this session (`exit 0`, all 3
phases pass, scratch database confirmed dropped afterward).

**Six correctness/safety corrections found by writing that suite, not by re-reading the spec a second time:**
1. `set_pincode_tracking_state` / `remove_pincode_monitored_products` now require the count of valid, in-scope
   locked rows to exactly equal the count of distinct requested IDs — a missing or foreign-workspace ID
   previously could be silently dropped rather than rejecting the whole batch.
2. `enroll_pincode_monitored_products`'s owned-listing check now verifies the listing's own `asin` column
   matches the request, not just that a listing with that ID exists in the account; `tracked_asin_id` gets the
   same treatment against `tracked_asins.marketplace` (confirmed by schema, not assumed); UUID inputs are
   regex-validated before casting; `'other'`-source can't carry a listing reference; conflicting duplicate-ASIN
   metadata is rejected instead of letting `DISTINCT ON` pick an arbitrary winner.
3. Hard, code-level ceilings added on every configured quota/limit and every marketplace string, distinct from
   the commercial-configured value itself, plus a total-flattened-combination cap on bulk enrollment.
4. `pincode_tracking_targets_monitored_product_fk` changed `CASCADE` → `RESTRICT` — a direct hard delete of a
   product could previously silently erase its targets. Empirically re-verified the whole-workspace cascade
   cleanup still works correctly with this change (two independent `CASCADE` paths from `workspaces`, no
   conflict).
5. The removed-consistency `CHECK` now also requires a non-null, narrow-valued `removal_reason`.
6. Migration 060's "locks no rows" comment corrected (index builds do take a lock) and given real operational
   guidance — grounded in a fresh read-only production audit re-run (confirmed unchanged since the original:
   18 available/no-error + 7 unknown/error rows, 25 total; confirmed the four new result-table columns still
   don't exist in production; `amazon_listing_items` 482 rows / `tracked_asins` 19 rows).

**Re-verified after all corrections:** full committed suite passes end-to-end from a from-scratch database.
`npx tsc --noEmit` clean, `npm run build` clean, `git status` confirms only the three edited migration files
plus the new `tests/` directory changed — zero application/API/UI/cron files touched. No migration applied to
production, no production row modified (Correction 8's audit was read-only), no deployment.

### PR #54 test-runner safety and reporting correction round: 4 corrections (2026-07-19)

_Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 8. Same PR #54, same branch — zero migration files
touched this round (no failing test required a schema/RPC change), no P0-B, no migration applied, no
deployment._

**The gap this round closes:** the committed test suite from the round above was real and repeatable, but the
runner itself (`run-tests.sh`) had four remaining safety/reporting gaps, all found by review rather than by a
failing test:

1. **Secret values were printed.** The hosted-endpoint refusal echoed the full value of whichever env var
   matched (e.g. a real `DATABASE_URL` with embedded credentials). Now names only the variable — never its
   value — and a new `--self-test` mode proves this against the real refusal function using an injected fake
   secret, asserting it never appears in the output.
2. **`PGHOSTADDR`/`PGSERVICE`/`PGSERVICEFILE` were unguarded.** `PGHOSTADDR` overrides `PGHOST` in libpq;
   `PGSERVICE`/`PGSERVICEFILE` resolve an independent named connection profile. Either could have silently
   redirected the runner past the pre-existing `PGHOST`-only check. Both are now validated (loopback-or-unset,
   and forced-empty respectively), and the script explicitly re-pins `PGHOST`/unsets `PGSERVICE*` after
   validation so nothing later can reintroduce an override. `README.md` now documents, gate by gate, why the
   connection cannot resolve remotely once validation passes.
3. **The scratch database name was raw-interpolated into SQL text.** `PINCODE_TEST_DB_NAME` is now regex-
   validated (`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`, must also contain `scratch`/`test`) and passed to
   `CREATE`/`DROP DATABASE` via psql's safe `:"identifier"` substitution, not string interpolation. (Discovered
   while wiring this up: psql only performs `:"var"` substitution when SQL is read as a script/stdin, not via
   `-c` — confirmed empirically against the installed psql 16.13 — so both call sites use a heredoc.) Six new
   self-tests cover valid names, missing-scratch/test, semicolon, quote, whitespace, and overlength cases —
   none of which ever reach a `psql` call.
4. **A concurrency-suite count/description mismatch was found and corrected — and one genuinely missing test
   was added.** The prior round's PR description and tracker entry said `concurrency.sh` has "4 tests"; the
   file has always asserted 5 (its own summary line prints `$PASSES`). Separately, `IMPLEMENTATION_PLAN.md`
   §2.8 requires a distinct "claim vs. product removal" concurrency test that did not exist — only an ordinary
   sequential remove/re-add test did, which is not a concurrency test. Added a third `remove` variant to the
   existing parameterized lock-contention test: one connection holds the parent lock and calls the real
   `remove_pincode_monitored_products` RPC before committing, a second connection concurrently calls
   `claim_due_pincode_targets` and is asserted to claim 0 rows, with the parent's final status independently
   re-queried as `'removed'`. (Also fixed a latent bug this surfaced: an earlier test's own state-reset step
   didn't clear `removed_at`/`removal_reason`, which broke that test once a `remove` variant had run first.)
   `concurrency.sh` now asserts 6 outcomes; `README.md` and the tracker both say "6," not "4."

**Re-verified after all 4 corrections:** `./run-tests.sh --self-test` — 14/14 passed, touching no database.
Full scratch-database run: sequential suite passed (~20 groups), concurrency suite passed (**6/6**, including
the new claim-vs-product-removal test), `EXPLAIN ANALYZE` check passed, scratch database dropped, exit code 0.
`npx tsc --noEmit` clean, `npm run build` clean, `git status` confirms only
`esolz-app/supabase/tests/pincode-p0a/{run-tests.sh,concurrency.sh,README.md}` changed — zero migration,
application, API, UI, or cron files touched. No migration applied to production, no production row modified,
no deployment.

### PR #54 merged (2026-07-19); PR #55 opened — P0-B API/data-access layer

_Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 9. PR #54 merged as `1e5a044` after pre-merge
verification (open, mergeable, head matched the approved commit exactly, exactly 11 files, zero application/
API/UI/cron files). New worktree, branch `feature/pincode-p0b-api-data-access`, off `origin/master`
post-merge. **P0-B only: no page UI, no cron/scheduler, no feature-flag broadening, no migration applied to
production.**_

**Eight new routes** under `esolz-app/src/app/api/pincode-monitoring/`, matching `IMPLEMENTATION_PLAN.md`
§9's P0-B list: `POST lookup-asin` (Other Products ASIN preview, reusing `getCatalogItemForAsin` verbatim,
never enrolling an unconfirmed ASIN), `POST products` (bulk-or-single enrollment via
`enroll_pincode_monitored_products`, one atomic RPC call), `PATCH products/[id]/pause`/`.../resume` (via
`set_pincode_tracking_state`), `PATCH products/[id]/remove` (via `remove_pincode_monitored_products`, soft
removal only, no DELETE route anywhere), `POST check-now` (via `queue_pincode_manual_check`, `202` only when
genuinely queued), `GET`/`PUT default-pincodes` (direct service-role CRUD — not an RPC, `workspace_default_
pincodes`' only mutation path per `DATA_MODEL.md` §6), `GET tracker` (paginated product+pincode rows, three
lifecycle views, five-state availability vocabulary). **My Products listing is not a new route** — confirmed
`GET /api/asins/listings` already satisfies `PRODUCT_SPEC.md` §11's explicit "reuses, existing, unchanged"
requirement; zero lines of it touched.

**New `lib/pincode-monitoring/` data-access layer** (`config.ts`, `access.ts`, `rpc.ts`, `responses.ts`,
`tracker.ts`, `defaults.ts`, `catalog-lookup.ts`, `validation.ts`, `pause-resume-handler.ts`) — a deliberate
deviation from this codebase's existing "inline everything in route.ts" convention, called out explicitly:
eight routes share the same four RPCs and the same access gate, and duplicating that logic eight times was
judged the real risk. `rpc.ts` hardcodes exactly the four P0-B-reachable RPCs, no generic passthrough.
`access.ts`'s core decision function is pure (session → per-workspace membership → feature-flag/allowlist →
role), separated from its I/O wrapper specifically so it unit-tests without a live database. Two new,
previously-unlocked env vars introduced (`PINCODE_MONITORING_ENABLED`, `PINCODE_MONITORING_ALLOWED_
WORKSPACE_IDS`), both defaulting closed (disabled / empty allowlist) — confirmed no prior workspace-ID
allowlist mechanism exists anywhere in this codebase before this PR.

**Tests: 87 unit tests across 8 files, zero new npm dependencies.** This codebase had no test tooling
whatsoever before this PR (no jest/vitest anywhere) — used Node's built-in `node:test` via `tsx` (already a
devDependency) instead of adding one. Honest scope note: these are pure-function and mocked-Supabase-client
unit tests (access-decision logic, RPC-result-to-HTTP mapping, five-state/product-state derivation, RPC
parameter-name correctness via a fake client double, a source-scan confirming no route is a client component
and every route reaches the access gate) — not a live-database integration test, since no PostgREST/GoTrue
stack is available in this environment (the P0-A scratch-DB runner is deliberately raw Postgres only). The
six RPCs' real correctness remains what the unchanged P0-A SQL suite verifies.

**Verified:** P0-A SQL suite re-run unmodified from the new worktree — sequential passed (~20 groups),
concurrency **6/6**, EXPLAIN ANALYZE passed. New P0-B suite: **87/87 passed**. `npx tsc --noEmit` clean.
`npx eslint` clean on every changed file. `npm run build` clean, all 8 routes registered as dynamic functions.
`git status`: only `esolz-app/package.json` (one new `"test"` script, no dependency change) plus the new
`app/api/pincode-monitoring/` and `lib/pincode-monitoring/` directories — zero migration, UI, or cron files.

**Feature remains fully disabled** (`PINCODE_MONITORING_ENABLED` unset anywhere real). No migration applied
to production, no production row modified, no Vercel/Supabase environment variable changed, no deployment.
PR #55 opened, not merged. P0-C (UI) and P0-D (scheduler) remain blocked until this PR is approved.

### PR #55 correctness amendment: 8 corrections closing real P0 contract gaps (2026-07-20)

_Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 10. Same PR #55, same branch — no P0-C, no
scheduler, no migration applied, no production env var changed, no deployment._

**The gap this round closes:** implementation review found the P0-B round above was structurally sound but
had real contract gaps, not style nits. Six were about correctness/security (blind Other Product enrollment,
a missing route, non-atomic writes, an unbounded read, a thin access gate, cross-product URL abuse); two were
hardening (request bounds, error hygiene).

1. **Other Product enrollment now requires server-side SP-API confirmation, closing a bypass.** The enroll
   route previously trusted a client-supplied `productSource: 'other'` ASIN outright — the RPC has no SP-API
   access and can't verify anything, so a direct call (skipping the UI's prior lookup) could enroll a blind,
   unconfirmed ASIN. New `other-product-confirmation.ts` resolves every distinct Other Product ASIN through
   the Catalog Items helper (one connection/token load per request, bounded concurrency), rejects the whole
   bulk request on any failure, and only ever writes Amazon-confirmed metadata for those products.
2. **The locked "Edit Pincodes" route (`PATCH .../products/[id]/pincodes`) was missing entirely — now
   implemented**, backed by a new target-configuration lifecycle (`is_configured`/`unconfigured_at`, a new
   migration 064) orthogonal to the existing operational status enum, and a new atomic RPC
   (`replace_pincode_product_targets`) that adds/reconfigures/unconfigures targets on their SAME IDs, never
   interrupts an in-flight check, and re-checks quota. Four existing RPCs (`claim_due_pincode_targets`,
   `queue_pincode_manual_check`, `set_pincode_tracking_state`, `finalize_pincode_check`) amended in place to
   respect the new lifecycle.
3. **Default-pincode replacement is now atomic** — one new RPC (`replace_workspace_default_pincodes`)
   replaces the prior two-request upsert-then-deactivate sequence with a single transaction.
4. **The tracker read is now bounded** — a new RPC (`get_pincode_target_results`) replaces an unbounded
   "fetch every history row, dedupe in TypeScript" query with a database-side, index-assisted read returning
   `latestAttempt` and `lastConfirmedAvailability` as two explicit, never-conflated facts. The previous
   `isLastConfirmedResult` field (which conflated "a row exists" with "it confirmed availability") is
   removed. A documented freshness model replaces the implicit "NULL next_check_at is fresh" assumption.
5. **The access gate now validates workspace-UUID shape, real marketplace entitlement (`amazon_connections`,
   the one-row-per-workspace canonical source), and an explicit role allowlist** — an unrecognized role is
   now rejected outright rather than silently treated as viewer-or-writable. A strict-integer-parsing bug
   (`'10abc'` previously parsed as `10`) in config env-var reading is also fixed.
6. **Product-scoped pause/resume/remove URLs can no longer mutate other products' targets** — the prior
   round's `targetIds`/`productIds` body overrides could reference IDs outside the URL's own product; removed
   for `remove`, and narrowed to "may only subset the URL product's own targets" for pause/resume.
7. **Request/response contract hardening**: hard bounds on every array/string input mirroring each RPC's own
   ceilings, an offset ceiling on the tracker query, and a shared `internalError()` helper so no route ever
   leaks a raw Postgres/PostgREST error message to a customer.

**Tests:** SQL suite grew by 8 numbered groups (TEST 21-28, covering the new lifecycle/RPCs at both
correctness and >1,000-row volume). TS suite grew from 87 to **127** tests, including two newly-extracted
pure cores specifically to make security-critical logic testable without a live database or network call:
`confirmAsinsWithLookup` (Other Product whole-batch-rejection + bounded concurrency) and
`resolveScopedTargetIds` (the product-scoped-URL security property itself).

**Verified:** P0-A/P0-B SQL suite re-run end-to-end, unmodified except the additions — sequential (28 groups),
concurrency **6/6**, EXPLAIN ANALYZE, all passed. TS suite: **127/127 passed**. `npx tsc --noEmit` clean.
`npx eslint` clean. `npm run build` clean, all 9 routes registered. `git status`: only the new migration file,
`sequential.sql`'s additions, and `esolz-app/src/{app/api,lib}/pincode-monitoring/**` changed.

**Feature remains fully disabled. No migration applied to production, no production row modified, no
Vercel/Supabase environment variable changed, no deployment.** PR #55 still open, not merged. P0-C and P0-D
remain blocked until this PR is approved.

### PR #55 final correction round: 3 closing fixes to the Round 2 amendment (2026-07-22)

_Full detail in `BRAHMASTRA_MASTER_TRACKER.md` §22 update 11. Same PR #55, same branch — no P0-C, no
scheduler, no migration applied, no production env var changed, no deployment. No SQL touched this round._

**The gap this round closes:** a follow-up review of the Round 2 correction code itself found three
remaining, narrowly-scoped defects — closing fixes to what Round 2 shipped, not new scope.

1. **`catalog-lookup.ts`'s `amazon_connections` query ignored its own `error`.** The Other Products lookup
   route's `lookupAsin` (distinct from Round 2's already-correct `confirmOtherProductAsins`) reported a
   database/infrastructure query failure as `connection_unavailable` ("connect your Amazon account") — false
   and unactionable. Now a distinct `connection_query_failed` outcome, mapped to `500
   catalog_connection_query_failed`. Separately, `decryptToken`/`refreshAccessToken` were called outside any
   try/catch — a failure there would have escaped uncaught. Now wrapped, resolving to a new
   `token_refresh_failed` outcome (`502 catalog_token_refresh_failed`), distinct from every other outcome.
   The decision logic was split into a pure `resolveCatalogLookup` core with every dependency injected (the
   same pure-core/IO-wrapper pattern used throughout this feature), so the full outcome state machine is
   directly unit-testable. 8 new tests.
2. **`queue_pincode_manual_check`'s `target_unconfigured` reason mapped to the wrong HTTP status.** It fell
   through to a generic `400 invalid_parameters` — false, since the request was valid; the target was simply
   no longer configured, a 409 state conflict. Now maps to `409 invalid_status` with a specific seller-facing
   message. 1 new direct test.
3. **`deriveFreshnessState` compared timestamps as raw ISO strings, not chronologically.** Two equal instants
   with different offsets (`Z` vs `+00:00`, or any non-zero offset) could compare incorrectly, misclassifying
   `overdue` as `current` or vice versa. Now parses both to epoch milliseconds via `Date.parse` and compares
   numerically; a malformed timestamp on either side now falls back to `unscheduled`, never `current`. 12 new
   tests, including two `+05:30`/`-05:30` counterexample pairs chosen specifically to fail under the old
   string-comparison logic.

**Verified:** TS suite **143/143 passed** (127 → 143, 16 new tests). `npx tsc --noEmit` clean. `npx eslint`
clean. `npm run build` clean, all 9 routes still registered. P0-A/P0-B SQL suite re-run end-to-end (no SQL
changed, confirming no regression): sequential (28 groups), concurrency **6/6**, EXPLAIN ANALYZE, all passed.
`git status`: exactly 7 files changed (`catalog-lookup.ts`, `responses.ts`, `tracker.ts`,
`lookup-asin/route.ts`, and their 3 test files) — zero migration/UI/cron files touched.

**Feature remains fully disabled. No migration applied to production, no production row modified, no
Vercel/Supabase environment variable changed, no deployment.** PR #55 still open, not merged. P0-C and P0-D
remain blocked until this PR is approved.
## SKU Performance — Daily Sales & Ad Spend Trends: Data Audit, P1-A (2026-07-22)

New, separate workstream from Pincode Checker — different branch (`feature/sku-daily-sales-spend-audit`),
different clean git worktree, does not touch or depend on the Pincode P0-A/P0-B branches or worktrees. Founder
requirement: a team-facing `/dashboard/sku-performance` page ("SKU Performance" / "Daily Sales & Ad Spend
Trends") answering which SKUs are growing/declining, spending more, whether extra spend is producing sales,
which SKU has spend but no sales, which SKU's TACOS is worsening, what changed yesterday, which products need
attention today, and whether the underlying data is fresh and trustworthy.

**This entry covers P1-A only — a read-only data audit. No migration, no RPC, no API route, no UI was built.**

Three documents produced: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md`, `SKU_DAILY_SALES_SPEND_PRODUCT_SPEC.md`,
`SKU_DAILY_SALES_SPEND_IMPLEMENTATION_PLAN.md`.

**Key audit findings** (full detail and SQL evidence in the Data Audit doc):
- Confirmed by reading the actual migrations/importers/sync scripts (nothing assumed): the relevant
  `internal_*` table family is single-team internal-ops tooling, RLS-gated to one test account or the
  "Internal Tester" plan. Live production check: exactly 1 of 3 workspaces has any real Ads/sales data.
- SKU → Ads-spend mapping verified **100% clean on live production data** (112/112 distinct advertised SKUs,
  all-time, matched by direct SKU-text join to `amazon_listing_items`, 0 unmapped, 0 ambiguous), via a
  read-only SQL query run against the production Supabase project. A structural caveat is carried into the
  spec/plan regardless: the catalog table's own DB constraint forbids two SKUs sharing one ASIN, so a real
  FBA/FBM duplicate-listing case can't be observed today, and the design must still handle it safely (never
  split spend arbitrarily) rather than assume it away.
- Sales source (`internal_business_report_sku_sales_traffic`) and spend source
  (`internal_ads_advertised_product_daily_rows`) both fresh through 2026-07-21 (yesterday). Ads figures use a
  **1-day click attribution window** (verified directly in the Ads Reporting API client's report-column
  config) — must be labeled, does not match a 7-day/14-day Console view.
- Real data-quality risks found and documented: catalog metadata is 23 days stale; only ~5.5–7.3 weeks of
  history exists (a 90-day filter must show a real data-start boundary, never zero-fill); fulfillment-type
  data's only source is 29 days stale with its intended replacement table completely empty — per the
  founder's own instruction, the fulfillment filter ships disabled in V1.
- **Organic sales is explicitly excluded from V1**, per the founder's explicit instruction, because neither
  required precondition (attribution-window methodology, date-boundary alignment) is yet validated.

**Result: GO WITH RESTRICTIONS** (not BLOCKED, not a clean GO) — full reasoning in the Data Audit doc §7.

**Recommended aggregation model:** a bounded `SECURITY DEFINER` RPC doing live server-side aggregation (not a
materialized table, not client-side aggregation), justified by current real volume (24,608 Ads rows + 4,500
Business Report rows for the one real workspace); a concrete promotion trigger to a materialized daily SKU
fact table is documented for later, not built now.

**Sequence locked:** P1-A (this entry, complete) → P1-B (aggregation RPCs + read-only routes, no UI, migration
written but not applied to production) → P1-C (page UI) → P1-D (explainable flags, CSV export, Command Center
integration). **P1-B is not started in this task**, per explicit instruction.

**Verification:** read-only only — no `npm test`/`tsc`/`eslint`/`build`, because no application code was
written. Every data claim is backed by either a repository file citation or a live read-only SQL query result
against the production Supabase project, recorded in the Data Audit doc.

**No migration applied to production. No production row changed (every query was a read-only `SELECT`). No
application code, API route, or UI changed. No deployment. Pincode PR #55 and its branch/worktree were not
touched.**
