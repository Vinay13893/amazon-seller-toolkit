# SKU Performance — Product Spec (P1-A)

Status: **spec only — no UI, no API route, no migration built in this pass**
Depends on: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md` (read first — every field below cites its
source/freshness/coverage from that document, nothing here invents a new data source)

Route: `/dashboard/sku-performance`
Navigation label: **SKU Performance**
Page subtitle: **Daily Sales & Ad Spend Trends**
Audience: the internal ops team already using `/dashboard/internal` and
`/dashboard/internal/easyhome-diagnostic` — same `getInternalAccessContext()` gate, same single
workspace in practice today.

## 1. Founder questions → locked answer mechanism

| Question | Answered by |
|---|---|
| Which SKUs are growing? | 7-day sales vs. prior-7-day sales, sorted; "Sales growing with stable spend" / "Sales growing while spend falls" flags |
| Which SKUs are declining? | "Sales drop" flag |
| Which SKUs are spending more? | "Spend spike" flag, 7-day spend vs. prior-7-day spend |
| Is the additional spend producing sales? | Ad-attributed sales and TACOS shown alongside spend for the same window, never spend alone |
| Which SKU has spend but no sales? | "Spend without sales" flag |
| Which SKU's TACOS is worsening? | "TACOS deterioration" flag |
| What changed yesterday? | Dedicated "Yesterday" column set + a day-over-day delta, separate from the 7/30-day trend columns |
| Which products require attention today? | "Attention status" column, computed from the flags in §6, sorted first by default |
| Is the underlying data fresh and trustworthy? | "Data freshness" summary card + per-row "Data freshness" column + per-row "Mapping state" column |

## 2. Safe metrics vs. unsafe metrics (locked, from the Data Audit)

**Safe to display, as-is:**
- Ordered sales, units, sessions (per `internal_business_report_sku_sales_traffic`) — labeled
  "Ordered sales (order date)."
- Ad spend, ad-attributed sales (per `internal_ads_advertised_product_daily_rows`) — labeled
  "Ad-attributed sales (1-day click)."
- ACOS = ad spend ÷ ad-attributed sales, computed at query time, never read from the report's own
  per-row `acos` column (that column is Amazon's own per-ad-row figure, not a SKU-level blend).
- TACOS = ad spend ÷ total ordered sales, computed at query time, same window.
- Mapping state (mapped/unmapped/ambiguous/stale/not applicable), per SKU.
- Data freshness, per source, per SKU (never a single blended "fresh/stale" bit for the whole
  page — different sources can be fresh/stale independently, exactly as
  `buildBrahmastraDataHealth` already does for the rest of the app).
- Product/category, labeled by source (`internal_sku_cost_master.category`, 87% coverage) —
  never silently blended with Amazon's own `product_type`.

**Unsafe, excluded from V1, must not be added without a separate, explicit approval:**
- **Organic sales** (`Total sales − Ad-attributed sales`) — blocked per the Data Audit §4/§5:
  attribution-window and date-boundary alignment are not yet validated.
- **Fulfillment type as a live/recent filter** — its only source is 29 days stale and the
  intended replacement table has zero rows (Data Audit §2). May be shown **only** on data older
  than the settlement staleness cutoff, with a visible "may not reflect recent SKUs" caption, and
  must never silently apply to a "Yesterday" or "7-day" view.
- **Any 90-day figure for a SKU with less than 90 days of underlying history** — must render as
  "data starts {date}," never a zero-filled or truncated-looking chart that implies "no
  activity."
- **Currency conversion** — there is exactly one currency (INR) in the audited data; no
  conversion logic is built, and none should be added silently if a second-currency workspace
  appears later.

## 3. Top summary cards

All computed workspace+marketplace scoped, for the selected date range (default: last 7 days
complete, i.e. **excluding** today, since today's data does not exist yet in either source
table).

| Card | Formula | Note |
|---|---|---|
| Total ordered sales | Σ `ordered_product_sales` over range | |
| Units ordered | Σ `units_ordered` over range | |
| Ad spend | Σ `spend` over range | |
| Ad-attributed sales | Σ `sales` over range | labeled "(1-day click)" |
| ACOS | Ad spend ÷ Ad-attributed sales | blank (not "0%") if attributed sales = 0 |
| TACOS | Ad spend ÷ Total ordered sales | blank if total sales = 0 |
| SKUs growing | count of SKUs with the "Sales growing" flag (§6) | |
| SKUs declining | count of SKUs with the "Sales drop" flag (§6) | |
| Mapping coverage | mapped SKUs ÷ (mapped + unmapped + ambiguous) SKUs with any spend in range, as % | never divides by SKUs with zero spend — an unadvertised SKU isn't a mapping failure |
| Data freshness | worst (most stale) of: Business Report latest date, Ads latest date, Catalog `last_synced_at` — shown as the actual date/timestamp, not just a color | matches the existing `SourceHealthStatus` vocabulary (`healthy`/`stale`/…) from `brahmastra-data-health.ts` for visual consistency |

## 4. Main table columns

One row per SKU (never per ASIN — a SKU is the seller's own inventory unit and the thing the
team actually acts on; an ASIN with two SKUs, were it ever to occur, gets two rows, one per SKU,
each showing its own attributable slice — never a blended ASIN-level row that would obscure
which SKU is actually driving the number).

| Column | Source |
|---|---|
| Product image | `amazon_listing_items.image_url` |
| Product title | `amazon_listing_items.item_name` |
| Seller SKU | `amazon_listing_items.sku` (fallback: the SKU string as seen in sales/ads rows if no catalog match — see Mapping state) |
| ASIN | `amazon_listing_items.asin` |
| Yesterday sales / units / spend / ad-attributed sales / ACOS / TACOS | single-day values for the most recent complete day |
| 7-day sales / spend / ACOS / TACOS | trailing 7 complete days |
| 30-day sales / spend / ACOS / TACOS | trailing 30 complete days (or since data start, whichever is shorter — labeled) |
| Sales trend | 7-day sales vs. prior-7-day sales, as a simple up/down/flat indicator with % delta |
| Spend trend | 7-day spend vs. prior-7-day spend, same shape |
| Data freshness | per-SKU: latest date this SKU has a sales row, latest date it has a spend row (a SKU can be fresh in one source and stale in the other — show both, never collapse to one bit) |
| Mapping state | mapped / unmapped / ambiguous / stale / not applicable (§ Data Audit §3) |
| Attention status | 0+ flag chips from §6, or "OK" |

## 5. Filters

| Filter | Backing field | Note |
|---|---|---|
| Workspace | `workspace_id` | effectively fixed to the one real workspace today, but implemented generically |
| Marketplace | `marketplace_id` | effectively fixed to `A21TJRUUN4KGV` today |
| Date range | `report_date` bounds | must clamp to actual data availability and say so (§2) |
| SKU | `amazon_listing_items.sku` / raw sales-row SKU text | supports partial match |
| ASIN | `amazon_listing_items.asin` | exact or partial |
| Product/category | `internal_sku_cost_master.category` | labeled "Category" |
| Brand | `amazon_listing_items.brand` | 89% coverage — SKUs with no brand shown under an explicit "No brand on file" bucket, never dropped silently |
| Fulfillment | `internal_payment_transactions.fulfillment` | **disabled/hidden in V1** per §2 "unsafe" list, until the source is fresh; the filter control should exist in the UI shell but render disabled with a tooltip explaining why, not be silently absent (so the team knows it's coming, not forgotten) |
| Growing | Sales growing flag | |
| Declining | Sales drop flag | |
| Spend without sales | that flag | |
| High TACOS | TACOS deterioration flag | |
| Unmapped | Mapping state = unmapped | |
| Ambiguous mapping | Mapping state = ambiguous | |

## 6. Explainable V1 flags — locked formulas

No AI, no opaque scoring, per the explicit instruction. Every flag below is a plain
threshold comparison the team can recompute by hand from the table's own visible columns.
Thresholds are **proposed to reuse the existing, already-configurable
`internal_brahmastra_thresholds` table** (migration 054) where a conceptually matching
threshold already exists there, rather than inventing a second, competing threshold system —
new thresholds are proposed only where no existing column fits.

| # | Flag | Formula | Threshold | Source of threshold |
|---|---|---|---|---|
| 1 | Sales drop | `7-day sales < 0.7 × prior-7-day sales` | floor: `prior-7-day sales ≥ ₹1,000` (avoids flagging near-zero SKUs on noise) | new, proposed |
| 2 | Spend spike | `7-day spend > 1.5 × prior-7-day spend` | floor: `prior-7-day spend ≥ ₹200` | new, proposed |
| 3 | Spend without sales | `7-day spend > 0 AND 7-day ad-attributed sales = 0` | floor: `7-day spend ≥ min_ad_spend_for_action` | **reuse** `internal_brahmastra_thresholds.min_ad_spend_for_action` (default ₹100) |
| 4 | TACOS deterioration | `7-day TACOS > prior-7-day TACOS × 1.3` | floor: `7-day sales ≥ ₹1,000` (avoid ratio noise on tiny denominators); absolute severity band reuses existing warning/critical split | **reuse** `internal_brahmastra_thresholds.warning_tacos_pct` (15%) / `.critical_tacos_pct` (25%) as the absolute-level bands shown alongside the relative-deterioration flag |
| 5 | Sales growing with stable spend | `7-day sales > 1.2 × prior-7-day sales` AND `7-day spend` within ±15% of prior-7-day spend | new, proposed | new, proposed |
| 6 | Sales growing while spend falls | `7-day sales > 1.2 × prior-7-day sales` AND `7-day spend < 0.85 × prior-7-day spend` | new, proposed | new, proposed |
| 7 | Data delayed | per-SKU: `latest sales row date < "yesterday"` OR `latest spend row date < "yesterday"` for a SKU that has ever had activity in the last 30 days | matches `evaluateSyncedSource`'s existing day-count staleness pattern | reuse the *pattern*, not a specific numeric column |
| 8 | Mapping incomplete | `mapping state != mapped` | — | — |

All eight thresholds must be visible in the UI (e.g. a "How this is calculated" info affordance
next to the Attention status column), not just in this document — "keep formulas simple and
visible" is a UI requirement, not only a spec requirement.

"Sales growing" (§3 card, §5 filter) = flag 5 OR flag 6. "Sales declining" = flag 1.

## 7. Row drill-down

Per-SKU detail view, opened from a table row:

- Daily total sales chart — `internal_business_report_sku_sales_traffic.ordered_product_sales`
  by day, over the selected range, with an explicit "no data before {start date}" boundary
  marker rather than a flat zero line.
- Daily units chart — same source, `units_ordered`.
- Daily ad spend chart — `internal_ads_advertised_product_daily_rows.spend` by day.
- Daily ad-attributed sales chart — same table, `.sales`, labeled 1-day click.
- Daily ACOS — computed per day from the two charts above, blank (not 0) on days with zero
  attributed sales.
- Daily TACOS — computed per day.
- Daily data-freshness status — which days are backed by real synced rows vs. which are inside
  the selected range but before either source's earliest available date.
- Mapping evidence — the literal `advertised_sku`/`advertised_asin` values seen in the Ads rows
  for this SKU, and the catalog row (or explicit "no catalog row found") they were matched
  against, so a team member can manually verify a flagged mapping in seconds.

## 8. Explicitly out of scope for V1

- No AI/opaque scoring (explicit instruction).
- No organic-sales calculation (§2).
- No live fulfillment filter (§2, §5).
- No CSV export (deferred to P1-D per the locked implementation sequence).
- No Command Center integration (P1-D).
- No write path of any kind — this is a read-only reporting page.
