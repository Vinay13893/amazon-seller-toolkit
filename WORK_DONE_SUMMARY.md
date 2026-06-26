# Work Done Summary

## Internal Replenishment Intelligence - Current State

_Last updated: 2026-06-26. Covers commits `4a763f1`, `c99ea82`, `512a284`, and the date-range + Seller Central demand session (Task A–J)._

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
