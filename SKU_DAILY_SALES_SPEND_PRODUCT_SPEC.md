# SKU Performance — Product Spec (P1-A)

Status: **spec only — no UI, no API route, no migration built in this pass**
Depends on: `SKU_DAILY_SALES_SPEND_DATA_AUDIT.md` (read first — every field below cites its
source/freshness/coverage from that document, nothing here invents a new data source)
Amended 2026-07-22 — Review Correction Round ("Update 2"): Corrections 3, 5, 6 applied (source
freshness vs. SKU activity separated; flag truth tables and zero-denominator behavior locked;
flags/filtering/sorting moved into P1-B, this document now specifies what P1-C *renders*, not
what it *computes*). Amended again 2026-07-22 — final API/coverage contract consistency pass
("Update 5"): §3's selected-date-range language is now aligned with the Implementation Plan's
`p_date_from`/`p_date_to` RPC contract (§3 no longer implies an RPC that only takes `p_as_of`);
§5's Seller SKU column now reflects the canonical cross-source SKU universe and raw-SKU display
precedence, not a catalog-only row set with a sales/ads fallback; §7's date-range filter now
cites the explicit clamp-evidence response fields. Docs-only — no migration, RPC, route, or UI
exists yet to change.

Route: `/dashboard/sku-performance`
Navigation label: **SKU Performance**
Page subtitle: **Daily Sales & Ad Spend Trends**
Audience: the internal ops team already using `/dashboard/internal` and
`/dashboard/internal/easyhome-diagnostic` — same `getInternalAccessContext()` gate, same single
workspace in practice today.

**Where computation happens (Correction 6):** every value, flag, filter match, and sort order
described below is computed **server-side, in P1-B's RPCs** — the summary-card numbers, the
per-SKU flags, the Attention status, and the default sort. P1-C (the page UI, described here)
only **renders** what P1-B returns; it never recomputes a flag or re-sorts a page of data in the
browser from raw rows. See `SKU_DAILY_SALES_SPEND_IMPLEMENTATION_PLAN.md` §Correction 6 for the
full sequence rationale.

## 1. Founder questions → locked answer mechanism

| Question | Answered by |
|---|---|
| Which SKUs are growing? | Base sales-trend state = `growing` or `new_activity` (§6.2) — the full SKUs Growing definition, not only the efficiency sub-flags |
| Which SKUs are declining? | Base sales-trend state = `declining` (§6.2) |
| Which SKUs are spending more? | Base spend-trend state = `growing` or `new_spend` (§6.2), "Spend spike" flag for the sharper case |
| Is the additional spend producing sales? | Ad-attributed sales and TACOS shown alongside spend for the same window, never spend alone |
| Which SKU has spend but no sales? | "Ad spend with no attributed sales" flag (renamed, §6.3 — explicitly does not claim total ordered sales are zero) |
| Which SKU's TACOS is worsening? | "TACOS deterioration" flag, only computed when both periods have a defined TACOS (§6.5) |
| What changed yesterday? | Dedicated "Yesterday" column set + a day-over-day delta, separate from the 7/30-day trend columns |
| Which products require attention today? | "Attention status" column, computed server-side from the flags in §6, sorted first by default |
| Is the underlying data fresh and trustworthy? | Three separate source-level facts (Sales/Ads/Catalog, §3) **and** separate per-SKU activity facts (§4) — never collapsed into one bit (Correction 3) |

## 2. Safe metrics vs. unsafe metrics (locked, from the Data Audit)

**Safe to display, as-is:**
- Ordered sales, units, sessions (per `internal_business_report_sku_sales_traffic`) — labeled
  "Ordered sales (order date)."
- Ad spend, ad-attributed sales (per `internal_ads_advertised_product_daily_rows`) — labeled
  "Ad-attributed sales (1-day click)."
- ACOS = ad spend ÷ ad-attributed sales, computed at query time — see §6.5 for zero-denominator
  behavior, never a stored per-row `acos` column.
- TACOS = ad spend ÷ total ordered sales, computed at query time — see §6.5.
- Mapping state: `mapped` / `unmapped` / `identity_conflict` / `stale_metadata` / `not_applicable`
  per SKU (Data Audit §3e — "ambiguous" is retired; `identity_conflict` is its concrete
  replacement).
- **Source-level freshness** (Sales data through &lt;date&gt;, Ads data through &lt;date&gt;,
  Catalog metadata as of &lt;timestamp&gt;) shown as three separate facts, never blended.
- **Per-SKU activity dates** (last sale, last ad spend, last attributed sale) — these describe
  *when the SKU last did something*, never *whether the data pipeline is stale* (Correction 3;
  see §4 for the exact field names).
- Product/category, labeled by source (`internal_sku_cost_master.category`, 87% coverage) —
  never silently blended with Amazon's own `product_type`.

**Unsafe, excluded from V1, must not be added without a separate, explicit approval:**
- **Organic sales** (`Total sales − Ad-attributed sales`) — blocked per the Data Audit §4/§5.
- **Fulfillment type as a live/recent filter** — 29-day-stale source, empty replacement table.
- **Any 90-day figure for a SKU with less than 90 days of underlying history** — must render as
  "data starts {date}," never a zero-filled chart.
- **Currency conversion / a hardcoded currency assumption** — currency must be read from the
  authorized Ads profile/account context at request time (Correction 8). If a requested
  aggregation would span more than one currency, the API must reject the aggregation outright —
  never sum mixed currencies, never silently convert.
- **A per-SKU "Data delayed" flag derived from that SKU merely having no row for a date** —
  retired per Correction 3 (§6.6). A SKU can legitimately have zero sales/spend on a given day;
  absence of a row is not evidence of staleness.

## 3. Top summary cards

All computed workspace+marketplace scoped, for the selected date range (default: last 7 days
complete, i.e. **excluding** today). **This selected range is the RPC's explicit
`p_date_from`/`p_date_to` parameters** (Implementation Plan §2, Update 5 Correction 2) — a
separate contract from `p_as_of`, which anchors only the fixed Yesterday/trailing-7/prior-7/
trailing-30 comparison columns in §5, not these cards. If the requested range is clamped to actual
source history, the page shows the RPC's `effectiveDateFrom`/`effectiveDateTo` and a clamp notice
built from `wasRangeClamped`/`clampReason` (§7) — it never silently substitutes a different range
without saying so.

| Card | Formula | Note |
|---|---|---|
| Total ordered sales | Σ `ordered_product_sales` over the selected `p_date_from`/`p_date_to` range | |
| Units ordered | Σ `units_ordered` over the selected range | |
| Ad spend | Σ `spend` over the selected range | |
| Ad-attributed sales | Σ `sales` over the selected range | labeled "(1-day click)" |
| ACOS | Ad spend ÷ Ad-attributed sales | see §6.5 for the zero-denominator rule; never "∞" |
| TACOS | Ad spend ÷ Total ordered sales | see §6.5 |
| SKUs growing | count of SKUs whose base sales-trend state (§6.2) is `growing` or `new_activity` | **Correction 5: this is the complete, documented definition — not limited to the two efficiency sub-flags** (sales-growing-with-stable-spend / sales-growing-while-spend-falls), which are separate, narrower Attention-status flags shown per row |
| SKUs declining | count of SKUs whose base sales-trend state is `declining` | |
| Mapping coverage | mapped SKUs ÷ (mapped + unmapped + identity_conflict) SKUs with any spend in range, as % | never divides by SKUs with zero spend |
| **Sales data through** | `salesSourceLatestCompleteDate` (§4) | |
| **Ads data through** | `adsSourceLatestCompleteDate` (§4) | |
| **Catalog metadata as of** | `catalogLastSyncedAt` (§4) | **Correction 3: shown as its own, separate line — a stale catalog sync must never imply yesterday's sales/spend figures are stale.** These three freshness facts are never collapsed into one summary bit. |

**Update 5 Correction 4 — every card above is a full-filtered-scope aggregate, never a
paginated-page aggregate.** These totals, the growing/declining counts, and the mapping-coverage
breakdown are computed by the RPC over the entire canonical SKU universe in scope after filters
are applied (Implementation Plan §2) — they do not change as the user pages through the table, and
they are never derived by the UI summing only the rows on the currently displayed page.

## 4. Freshness and activity fields (Correction 3 — locked field names)

**Source-level (one set per page load, describes the sync pipelines themselves):**

| Field | Meaning |
|---|---|
| `salesSourceLatestCompleteDate` | Latest date the Business Report SKU sync has confirmed complete data through |
| `adsSourceLatestCompleteDate` | Latest date the Ads Reporting sync has confirmed complete data through |
| `catalogLastSyncedAt` | Timestamp of the last successful `amazon_listing_items` sync run |
| `salesSourceState` | One of the source-health states already established by `brahmastra-data-health.ts` (`healthy`/`stale`/`failed`/`auth_required`/`rate_limited`/`not_configured`) — reused, not reinvented |
| `adsSourceState` | Same vocabulary, Ads pipeline |
| `catalogSourceState` | Same vocabulary, catalog pipeline |

**SKU-level (one set per row, describes that SKU's own history — never a proxy for source
health):**

| Field | Meaning |
|---|---|
| `lastSalesActivityDate` | The most recent date this SKU has a real sales row — a SKU idle for 10 days shows that date, not an error |
| `lastAdSpendActivityDate` | The most recent date this SKU has a real spend row |
| `lastAttributedSaleActivityDate` | The most recent date this SKU has a row with `sales > 0` |

**Any column previously named "freshness" that actually represented per-SKU activity is
renamed** to one of the three `*ActivityDate` fields above — "freshness" is now reserved
exclusively for the six source-level fields. A SKU with no sales yesterday because it genuinely
had no sales is shown via `lastSalesActivityDate` (an older date, a true fact), never as a
"stale" or "delayed" chip — that chip only ever reflects `salesSourceState`/`adsSourceState`
(§6.6).

## 5. Main table columns

One row per SKU (never per ASIN). **Update 5 Correction 3 — the row universe is the canonical
union across sources, not `amazon_listing_items` alone** (Implementation Plan §2): a SKU with
sales or ad spend but no catalog match still gets a row; a catalog-tracked SKU with no activity in
the selected range may still get a row. A missing catalog match never hides real sales/spend — it
only means the catalog-sourced columns below (image, title, ASIN) render as "Unknown product."

| Column | Source |
|---|---|
| Product image | `amazon_listing_items.image_url`, blank ("Unknown product" placeholder) if no catalog row matches |
| Product title | `amazon_listing_items.item_name`, "Unknown product" if no catalog row matches |
| Seller SKU | The canonical SKU's **displayed raw SKU**, chosen by fixed precedence — (1) catalog (`amazon_listing_items.sku`), (2) Business Report raw SKU, (3) Ads raw SKU, (4) cost-master raw SKU — first source present, in that order (Implementation Plan §2, Update 5 Correction 3). The canonical join key is used only to match the same identity across sources; it is never itself displayed, and two genuinely distinct raw SKUs are never silently merged into one row (a future collision surfaces as `identity_conflict`, not a merge). |
| ASIN | `amazon_listing_items.asin`, blank if no catalog row matches |
| Yesterday sales / units / spend / ad-attributed sales / ACOS / TACOS | single-day values for the most recent complete day, using the coverage-state model in the Implementation Plan §Correction 4 to distinguish a confirmed zero from missing/unknown data |
| 7-day sales / spend / ACOS / TACOS | trailing 7 complete days |
| 30-day sales / spend / ACOS / TACOS | trailing 30 complete days (or since data start, whichever is shorter — labeled) |
| Sales trend | base state per §6.2: `growing` / `declining` / `flat` / `new_activity` / `no_activity`, with the underlying % delta shown when defined |
| Spend trend | base state per §6.2: `growing` / `declining` / `flat` / `new_spend` / `no_spend` |
| `lastSalesActivityDate` / `lastAdSpendActivityDate` / `lastAttributedSaleActivityDate` | §4 — per-SKU activity, never a proxy for source staleness |
| Mapping state | `mapped` / `unmapped` / `identity_conflict` / `stale_metadata` / `not_applicable` (Data Audit §3e) |
| Attention status | 0+ flag chips from §6, or "OK" — computed server-side (P1-B), rendered here |

## 6. Explainable V1 flags and base trend rules — locked, with truth tables (Correction 5)

No AI, no opaque scoring. Every rule below is a plain, visible threshold comparison, computed
server-side in P1-B (Correction 6). Thresholds reuse `internal_brahmastra_thresholds` (migration
054) where a conceptually matching one already exists.

### 6.1 Denominator/floor conventions

`FLOOR_SALES = ₹1,000` (7-day window), `FLOOR_SPEND = ₹200` (7-day window) — proposed, new,
consistent with the original round. Used to gate "new activity"/"new spend" classification and
the percentage-comparison flags below, so a SKU going from ₹1 to ₹5 in sales is never reported as
a dramatic swing.

### 6.2 Base sales trend (spend-independent — this is what "SKUs growing/declining" means)

| Prior 7-day sales | Current 7-day sales | State |
|---|---|---|
| `= 0` | `= 0` | `no_activity` |
| `= 0` | `> FLOOR_SALES` | `new_activity` |
| `= 0` | `> 0` but `≤ FLOOR_SALES` | `no_activity` (too small to call "new," avoids noise) |
| `> 0` | any | `growing` if current `> 1.2 ×` prior; `declining` if current `< 0.7 ×` prior; else `flat` |

**"SKUs growing" (§3 card) = count where state is `growing` OR `new_activity`. "SKUs declining" =
count where state is `declining`.** This is the complete, sole definition — the two efficiency
sub-flags in §6.4 are additional, narrower Attention-status detail, not an alternate definition of
the summary card.

### 6.3 Base spend trend (same shape, independent of sales)

| Prior 7-day spend | Current 7-day spend | State |
|---|---|---|
| `= 0` | `= 0` | `no_spend` |
| `= 0` | `≥ FLOOR_SPEND` | `new_spend` |
| `= 0` | `> 0` but `< FLOOR_SPEND` | `no_spend` |
| `> 0` | any | `growing` if current `> 1.5 ×` prior; `declining` if current `< 0.7 ×` prior; else `flat` |

(Spend uses a 1.5× growth threshold, not sales' 1.2×, matching the original "Spend spike"
severity — spend swings are expected to be noisier than sales swings for this account.)

### 6.4 Attention-status flags

| # | Flag | Formula | Threshold | Source |
|---|---|---|---|---|
| 1 | Sales drop | Base sales trend = `declining` | `FLOOR_SALES` on prior period | §6.2 |
| 2 | Spend spike | Base spend trend = `growing` (i.e. current `> 1.5×` prior) | `FLOOR_SPEND` on prior period | §6.3 |
| 3 | **Ad spend with no attributed sales** (renamed from "Spend without sales" — Correction 5) | `7-day spend ≥ min_ad_spend_for_action AND 7-day ad-attributed sales = 0` | reuse `internal_brahmastra_thresholds.min_ad_spend_for_action` (₹100 default) | Does **not** imply total ordered sales are zero — a SKU can sell organically while this flag is set. A separate, **optional, future-only** flag, "Ad spend with no ordered sales" (comparing to *total* sales, not attributed), is documented here but **not added to V1 without separate founder approval.** |
| 4 | TACOS deterioration | Both prior-period and current-period TACOS are defined (§6.5) AND `current TACOS > prior TACOS × 1.3` | floor: `7-day sales ≥ FLOOR_SALES` | Absolute severity bands (independent of this relative flag) reuse `internal_brahmastra_thresholds.warning_tacos_pct` (15%) / `.critical_tacos_pct` (25%) |
| 5 | Sales growing with stable spend | Base sales trend = `growing` AND base spend trend = `flat` | — | Efficiency sub-flag, not the Growing-card definition (§6.2) |
| 6 | Sales growing while spend falls | Base sales trend = `growing` AND base spend trend = `declining` | — | Efficiency sub-flag |
| 7 | Data delayed | **Source-level only** (Correction 3): `salesSourceState != 'healthy'` OR `adsSourceState != 'healthy'` for the page's own workspace | reuses `evaluateSyncedSource`'s existing staleness pattern | **Never** derived from a single SKU lacking a row for a date — see §6.6 |
| 8 | Mapping incomplete | Mapping state `!= mapped` | — | — |

### 6.5 ACOS / TACOS zero-denominator truth table (never display infinity)

| Spend | Ad-attributed sales | ACOS |
|---|---|---|
| `= 0` | `= 0` | `not_applicable` (blank — no ad activity at all) |
| `> 0` | `= 0` | `undefined` (blank, paired with the "Ad spend with no attributed sales" flag, §6.4#3) |
| `> 0` | `> 0` | `spend ÷ attributed sales`, a normal ratio |

| Spend | Total ordered sales | TACOS |
|---|---|---|
| `= 0` | `= 0` | `not_applicable` |
| `> 0` | `= 0` | `undefined / high-risk state` — shown as a distinct indicator ("spend with zero total sales"), never as a numeric percentage or "∞" |
| any | `> 0` | `spend ÷ ordered sales`, a normal ratio (well-defined even when spend = 0, giving TACOS = 0%) |

The **relative TACOS-deterioration flag** (§6.4#4) is computed **only** when both the prior and
current period have a *defined* TACOS (i.e., both periods had ordered sales `> 0`) — if either
period's TACOS is `undefined` or `not_applicable`, the deterioration comparison itself is not
computed (shown as "N/A" for that specific comparison), even though the **absolute** high-TACOS
band (warning/critical) can still apply independently to whichever period does have a defined
value.

### 6.6 Data delayed vs. per-SKU absence (Correction 3, restated as a locked rule)

**The flag "Data delayed" is a source-level fact about `salesSourceState`/`adsSourceState`
(§4), never a per-SKU fact derived from "this SKU has no row for yesterday."** A SKU can have
zero sales and zero spend on any given day for entirely ordinary reasons (seasonality, out of
stock, not currently advertised) — that is not evidence the pipeline is behind. The previous
version of this document defined "Data delayed" per-SKU from row absence; that rule is retired.
See the Implementation Plan's Correction 4 coverage-state model for how a per-SKU/per-day cell is
classified (`BEFORE_HISTORY` / `SOURCE_NOT_COMPLETE` / `CONFIRMED_ZERO` / `REPORTED_VALUE` /
`UNKNOWN`) without ever conflating "no row" with "pipeline stale."

## 7. Filters

| Filter | Backing field | Note |
|---|---|---|
| Workspace | `workspace_id` | effectively fixed to the one real workspace today |
| Marketplace | `marketplace_id` | effectively fixed to `A21TJRUUN4KGV` today |
| Date range | `report_date` bounds (`p_date_from`/`p_date_to`) | must clamp to actual data availability and say so — the page shows the clamp using the RPC's `requestedDateFrom`/`requestedDateTo` vs. `effectiveDateFrom`/`effectiveDateTo`/`wasRangeClamped`/`clampReason` (Implementation Plan §2, Update 5 Correction 2); a requested range predating history is never silently zero-filled |
| SKU | `amazon_listing_items.sku` / raw sales-row SKU text | supports partial match |
| ASIN | `amazon_listing_items.asin` | exact or partial |
| Product/category | `internal_sku_cost_master.category` | labeled "Category" |
| Brand | `amazon_listing_items.brand` | 89% coverage — SKUs with no brand shown under an explicit "No brand on file" bucket |
| Fulfillment | `internal_payment_transactions.fulfillment` | **disabled/hidden in V1**, per §2 |
| Growing | base sales trend = `growing` or `new_activity` (§6.2) | |
| Declining | base sales trend = `declining` (§6.2) | |
| Spend spike | §6.4#2 | |
| Ad spend with no attributed sales | §6.4#3 | renamed from "spend without sales" |
| High/deteriorating TACOS | §6.4#4, plus the absolute band independently | |
| Unmapped | Mapping state = `unmapped` | |
| Identity conflict | Mapping state = `identity_conflict` (renamed from "Ambiguous mapping") | |

All filtering and the resulting sort order are applied **server-side in the P1-B RPC**
(Correction 6) — the route accepts these as bounded query parameters and returns an
already-filtered, already-sorted, already-paginated page; the UI never filters or sorts a larger
client-side dataset.

## 8. Row drill-down

Per-SKU detail view, opened from a table row:

- Daily total sales chart, daily units chart, daily ad spend chart, daily ad-attributed sales
  chart, daily ACOS, daily TACOS — each day cell classified using the Implementation Plan's
  coverage-state model (`BEFORE_HISTORY` / `SOURCE_NOT_COMPLETE` / `CONFIRMED_ZERO` /
  `REPORTED_VALUE` / `UNKNOWN`), never a flat zero line standing in for "no data available."
- Daily source-state overlay — which days fall inside a `salesSourceState`/`adsSourceState`
  healthy window vs. not, distinct from which days the SKU itself had confirmed-zero activity.
- Mapping evidence — the literal `advertised_sku`/`advertised_asin` values seen in the Ads rows
  for this SKU, and the catalog row (or explicit "no catalog row found") they were matched
  against.

## 9. Explicitly out of scope for V1

- No AI/opaque scoring.
- No organic-sales calculation (§2).
- No live fulfillment filter (§2).
- No "Ad spend with no ordered sales" flag (§6.4#3) without separate founder approval.
- No CSV export (deferred to P1-D per the locked implementation sequence).
- No Command Center integration (P1-D).
- No write path of any kind — this is a read-only reporting page.
- No client-side filtering/sorting/flag computation (Correction 6 — all of it is P1-B's job).
