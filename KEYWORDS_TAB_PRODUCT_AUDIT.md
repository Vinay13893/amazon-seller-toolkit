# Keywords Tab — Product Audit

**Scope:** Static code audit only. No code changed, no migrations run, no production Supabase or Render
queries executed, no live checker-worker calls made. All findings are traced to file paths and line numbers
in the repo at `C:\Vinay\amazon-seller-toolkit-keywords-audit` (worktree `audit/keywords-tab-product-cleanup`,
base commit `b7ee9e7`) as of this session. `review-requests` and `pincode` code was not read or touched, per
instructions.

**Independent verification (main session, not the drafting agent):** this document was drafted by a
background research agent and was not trusted or committed blindly. Before insertion into the tracker, the
following claims were independently re-read directly against source and confirmed accurate with zero
corrections needed: the P0 finding and its full causal chain (`asins/[asin]/page.tsx:245-254` render gap +
`asins/[asin]/keywords/refresh/route.ts`'s `insertFailedSnapshot` write path), the organic/sponsored
separation in migration 022, the Category dropdown's decorative status (`research/route.ts`'s destructuring
omits `category`), the Ads-search-term isolation (zero cross-references confirmed via direct grep), the
`rank != null` / `!== null` null-safety pattern at all cited render sites (no `rank || 0`-style coercion
found), `mock-keywords.ts`'s dead-code status (zero import references anywhere in `src/`), the
`tracked_asins.category`/`competitor_asins.category` TEXT column existence, and the absence of any
category-taxonomy/browse-node table in any migration. No claim checked was found to be inaccurate or
overstated.

**Note on repo layout:** the Next.js app root is `esolz-app/`, not the repo root — all `src/...` paths below
are relative to `esolz-app/`. The checker worker root is `checker-worker/`.

**Files read for this audit:**
`esolz-app/src/app/(dashboard)/dashboard/keywords/page.tsx` (full, 2296 lines),
`esolz-app/src/app/api/keywords/{refresh,research,track}/route.ts`,
`esolz-app/src/app/api/asins/[asin]/keywords/{refresh,track}/route.ts`,
`esolz-app/src/lib/integrations/amazon-keyword-adapter.ts`,
`esolz-app/src/lib/mock-keywords.ts`,
`esolz-app/src/lib/checkers/checker-worker-client.ts`,
`esolz-app/src/lib/alerts/generate-alerts.ts` (keyword-alert section + pause-flag check),
`esolz-app/src/lib/internal/brahmastra-data-health.ts` (keyword-rank Sync Health section),
`esolz-app/src/app/(dashboard)/dashboard/asins/[asin]/page.tsx` (Keyword Rank Snapshot widget + `KeywordsTable`),
`esolz-app/src/components/asins/{AsinDashboardTable,ProductCard}.tsx`,
`esolz-app/src/app/(dashboard)/dashboard/brand-analytics/search-terms/page.tsx` (header/types/labels),
`esolz-app/src/app/api/brand-analytics/search-terms/route.ts` (header/types),
`esolz-app/supabase/migrations/{001_initial_schema,009_keyword_rank_snapshot_history_columns,022_keyword_rank_separate_placements}.sql`,
`checker-worker/src/checkers/keywordRank.ts` (full),
`checker-worker/src/server.ts` (`/keyword-rank` route wiring),
`checker-worker/src/scraping/queue.ts` (grepped — no keyword references),
`BRAHMASTRA_MASTER_TRACKER.md` (full read, §10 + all "keyword"/"category" mentions),
`WORK_DONE_SUMMARY.md` (full read, keyword mentions),
`PINCODE_CHECKER_PRODUCT_AUDIT.md` (style/structure reference only).

`src/lib/internal/ads-deep-report-parser.ts` and `amazon-ads-reporting-client.ts` were confirmed **not** to
share any route, component, or link with the Keywords tab (verified by grepping the Keywords tab file and the
Brand Analytics Search Terms page for cross-references in both directions — zero matches either way, see §C
and §D.13) and were not read in further depth beyond that boundary check, since the audit brief's question
("does Ads data ever surface in the Keywords tab") is answered by that absence.

---

## 0. Headline finding

There is **no single "Keywords tab" data model** — there are **three independent keyword-tracking surfaces**
that read/write the *same* two tables (`tracked_keywords`, `keyword_rank_snapshots`) through *two different but
consistent* API routes, plus a **fourth, fully separate keyword-adjacent surface** (Brand Analytics Search
Terms) that shares no data, no route, and no link with any of the other three. Unlike the pincode audit's
finding, the three keyword surfaces do **not** fragment data across incompatible tables — that part is
architecturally sound. But one specific entry point (`/api/keywords/track`, reachable only from the Keyword
Research section's "Track" button) creates keyword rows with **no ASIN association**, and rank-checking
structurally requires an ASIN — so keywords added that way can **never be rank-checked** and sit permanently as
"Never checked" with no path forward in the UI. See §B.5–B.7 and §D.15.

The single clearest trust finding: the **Keyword Research section's Category dropdown does nothing** — it is
wired into the request body but the API route never reads it (§D.14, CONFIRMED). It is also populated with a
hardcoded, non-EasyHOME-relevant category list (Grocery, Health, Kitchen, Sports) that reads as a leftover
demo artifact, not real Amazon taxonomy and not the seller's own catalog (§E).

---

## A. Seller purpose

### A.1 What decision is the seller expected to make?

CONFIRMED from the page header copy itself: `"Track where any ASIN ranks organically and in sponsored results
for Amazon search keywords."` (`keywords/page.tsx:1298-1301`). The page is built around one core loop: pick a
product → add keywords → check rank → watch it move. The decision it supports is narrow and well-defined:
*"for the keywords I care about, am I visible on page 1, and is that improving or declining?"*

### A.2 Discovery, rank tracking, ads analysis, or category research — which is it?

**Mostly rank tracking, with a bolted-on, low-power discovery panel.** CONFIRMED:
- **Rank tracking** is the dominant, fully-functional half of the page: product selection (§B.1), keyword
  add/track (§B.5-6), refresh (§B.7), a rank-trend chart + check history (§B.8), and a 7-column KPI strip.
- **"Discovery"** exists as the bottom "Keyword Research" section, but it is Amazon autocomplete suggestions
  only — no volume, no CPC, no difficulty, no competition, no intent (all explicitly `null`, `research/route.ts:86-94`).
  The route's own docstring says so directly: `"there is no existing keyword-research tool in this workspace
  that provides those metrics"` (`research/route.ts:9-11`).
- **Advertising analysis** does not appear anywhere in this page. Amazon Ads search-term/targeting data
  (`internal_ads_search_term_daily_rows`, `internal_ads_targeting_daily_rows`) is never queried, imported, or
  linked from `keywords/page.tsx` — CONFIRMED via grep, zero matches for `ads-deep`, `brand-analytics`,
  `internal/ads` (§0, §C).
- **Category research** does not exist in any working form — the Category dropdown is inert (§D.14) and no
  category-keyword grouping exists anywhere in the codebase (§E).

So the honest characterization is: **organic + sponsored rank tracker, with a thin, honestly-labeled
"no real data" discovery panel bolted on**, not "an unclear mix of four things" — the mix is clear once you read
the code, but the UI doesn't communicate the discovery panel's limitations to the seller (the `note` field
returned by `/api/keywords/research` explaining the metrics gap is never rendered anywhere in `page.tsx` —
CONFIRMED, the `note` key from the API response is discarded at `handleResearch`, `page.tsx:931`, `data.error`
is checked but `data.note` is not surfaced to the UI).

### A.3 Is the main action obvious?

Reasonably, yes, for the rank-tracking half. The page flows top-to-bottom: choose product → add keyword(s) →
see them in the tracking table → refresh. INFERRED: a first-time seller would understand "add a keyword, click
refresh, watch the rank" within the first screen. What is **not** obvious: that the bottom "Keyword Research"
section's "Track" button creates a keyword with no product association that can never show a rank (§B.5, §D.15)
— this looks like the same action as the main "Track Keyword" button above but silently produces a dead-end
state.

### A.4 Functional vs decorative/incomplete controls

| Control | Status | Evidence |
|---|---|---|
| Product search/select | Functional | `keywords/page.tsx:456-692` |
| Track ASIN for keywords | Functional | `handleTrackSelectedAsin`, `:1003-1062` |
| Add single/bulk keyword (linked to ASIN) | Functional | `handleTrackKeywords`, `:1171-1224`, via `/api/asins/[asin]/keywords/track` |
| Refresh Ranks (per-ASIN keyword loop) | Functional | `handleRefresh`, `:948-1001` |
| ASIN filter on tracking table | Functional | `:1713-1724` |
| Rank trend chart + check history | Functional | `:1966-2132` |
| Keyword Research → Marketplace select | Functional (affects autocomplete host/mid) | `research/route.ts:51-53` |
| **Keyword Research → Category select** | **Decorative — sent to server, never read** | `research/route.ts:40-46` (`category` destructured off the type but not the destructuring assignment) |
| Keyword Research results → Volume/CPC/Difficulty/Competition/Intent/Top ASIN columns | **All permanently empty (`—`)** in production — no data source | `research/route.ts:86-94`, confirmed no third-party provider wired |
| `CompetitionBadge` / `IntentBadge` components | **Dead code** — defined, never invoked | `keywords/page.tsx:227-254`, grep confirms zero call sites |
| "Track" button in Research results | Functional but creates an orphan keyword (§D.15) | `toggleTrack`, `:1226-1254` → `/api/keywords/track` |

### A.5 Five-second understanding

CONFIRMED reasonable for the rank-tracking core: header text + 7 KPI cards (Total Tracked, Page 1 Organic, Top
10 Organic, Sponsored Found, Improved, Declined, Average Organic Rank) give an immediate portfolio snapshot.
INFERRED risk: "Average Organic Rank" (`:1330-1335`) averages rank across every tracked keyword regardless of
product or search-term difficulty — the same class of misleading aggregate the tracker already flags for
"Average BSR" on the ASIN page (`BRAHMASTRA_MASTER_TRACKER.md:288-296`, "Must be audited before keeping. Do not
blindly average BSR across unlike categories"). See §D.10.

---

## B. Current user flow

### B.1 Product/ASIN selection

CONFIRMED. A single "Choose a product" panel (`:1338-1598`) merges two sources: (a) already-tracked ASINs
(`tracked_asins` + `competitor_asins` for external metadata, `:472-524`) and (b) the seller's synced Amazon
listings (`/api/asins/listings`, paginated 50 at a time with search + "Load More", `:526-692`). Pasting a raw
ASIN not in either list surfaces an inline "ASIN not found" card to track it as Competitor or External
(`:1366-1439`, `handleTrackExternalAsin`, `:1064-1126`). This is the same `tracked_asins`/`competitor_asins`
model used by the ASIN dashboard elsewhere in the app — not a separate, siloed product list.

### B.2/B.3 Category selection — none

CONFIRMED there is **no category selector for product/ASIN selection** anywhere in this flow. The only
"Category" control on the entire page is the Keyword Research section's dropdown (§A.4, §E), which is unrelated
to product selection and does not filter the product list. Products are filtered only by free-text search
(ASIN/title/SKU/brand/marketplace, `:438-448`).

### B.4 Keyword discovery

CONFIRMED — a single seed-keyword box + Amazon's public completion API (`completion.amazon.in` /
`completion.amazon.com`, `research/route.ts:16-23,51-70`). Returns up to ~11 autocomplete strings, the seed
keyword always first and deduplicated (`:75-84`). No import, no bulk-suggest-from-listing-title flow in this
section (a *different*, lighter-weight suggestion mechanism exists for the Add Keyword box — see B.5).

### B.5 Bulk keyword selection

There is **no bulk-select-from-a-list** UI (e.g., checkboxes to select several Research results at once and
track them together) — CONFIRMED, each Research row has its own individual "Track" toggle button
(`:2254-2274`). Bulk exists only as a **textarea** for the "Add keywords" step once a product is chosen — one
keyword per line, deduplicated client-side, submitted as individual sequential POSTs
(`handleTrackKeywords('bulk')`, `:1171-1224`).

### B.6 Keyword tracking (added to a tracked list)

**Two structurally different track paths exist, and they are not interchangeable:**
1. **Product-linked** (`/api/asins/[asin]/keywords/track`, `esolz-app/src/app/api/asins/[asin]/keywords/track/route.ts`)
   — requires the ASIN to already be in `tracked_asins`, resolves `tracked_asin_id`, and inserts with that FK
   set (`:51-101`). This is the path used by the main "Track Keyword"/"Track Multiple Keywords" buttons
   (`handleTrackKeywords`) and by the ASIN-detail page's own Add Keyword box (`asins/[asin]/page.tsx:459-485`).
2. **Unassigned** (`/api/keywords/track`, `esolz-app/src/app/api/keywords/track/route.ts`) — explicitly documented
   in its own file header as leaving `tracked_asin_id` NULL (`:11`), used only by the Keyword Research section's
   "Track" button (`toggleTrack`, `keywords/page.tsx:1226-1254`).

Path 2 is a genuine dead end — see §D.15.

### B.7 Rank checks

**Manual only, no scheduler** — CONFIRMED, matches `BRAHMASTRA_MASTER_TRACKER.md:412-420` exactly. Two
"Refresh" entry points exist:
- The main Keywords tab's "Refresh Ranks" button loops **one keyword at a time**, issuing a separate
  `POST /api/keywords/refresh` per keyword with `keywordIds: [id]` (`handleRefresh`, `:948-1001`). This is
  intentionally serial (Playwright can't be parallelized cheaply, per the sibling route's own comment,
  `asins/[asin]/keywords/refresh/route.ts:83`) — for a seller with many tracked keywords this is slow (each
  check can take up to the worker's own internal budget; see §D.6 on the 90s/120s timeout chain) but each
  keyword is independent, so one failure does not affect the others (§D.6).
- The ASIN-detail page's widget calls `POST /api/asins/[asin]/keywords/refresh` **once for the whole ASIN**,
  which loops all of that ASIN's keywords **inside a single request** (`:133-275`). Here, one "worker
  unavailable" classification poisons the rest of the batch: `runtimeUnavailableDetected` is set on the first
  such failure and every subsequent keyword in that same request is marked `checker_unavailable` **without an
  actual attempt** (`:159-184` inside the loop; same pattern in `/api/keywords/refresh/route.ts:159-184`). This
  is defensible fail-fast behavior (avoids hammering a down/rate-limited worker) but means a transient block on
  keyword #1 silently skips real checks for keywords #2-N in that ASIN, in that request, with no user-visible
  distinction between "we checked and it's unavailable" and "we didn't even try." CONFIRMED via code read, not
  yet observed live.

### B.8 Historical rank display

CONFIRMED — a Recharts line chart (rank on Y, reversed so #1 is at top, `:2035-2036`) driven by up to 90 stored
`keyword_rank_snapshots` rows per keyword (`loadKeywordHistory`, `:835-856`), with a 7/14/30-day range toggle
and a "Check History" table below showing up to the last 15 checks with timestamp, rank, page, found/not-found,
and success/failed status (`:2085-2129`). Both empty states are correctly differentiated: "no ranking data yet"
vs. "rank could not be checked yet (checker unavailable)" (`:2055-2079`) — this distinction is done correctly
here, in contrast to the ASIN-detail widget's Found-column gap (§D.6).

### B.9 Advertising search terms connection

**None.** CONFIRMED by direct grep of `keywords/page.tsx` for `ads-deep`, `brand-analytics`, `internal/ads` —
zero matches. Amazon Ads search-term/targeting data lives entirely in the internal Ads diagnostic dashboard
(`src/app/(dashboard)/dashboard/internal/...`, not read in full for this audit per the audit brief's own
scoping) and never surfaces in this consumer-facing Keywords tab in any form — not as a data source, not as a
cross-link. See §C and §D.2.

### B.10 Missing/stale/failed data handling

Handled explicitly and mostly well on the main tab: `FoundStatusBadge` (`:256-269`) distinguishes
`never_checked` / `checker_unavailable` / `failed` / found / not-found as four visually distinct states, and a
`DataFreshnessBadge` per row shows check age (`:1952-1954`). The ASIN-detail widget has one confirmed gap in
this area — see §D.6.

### B.11 Category-wise keyword grouping

**Does not exist today, anywhere.** CONFIRMED — no grouping UI, no `keyword_groups`-style table in any read
migration, and `mock-keywords.ts`'s `KEYWORD_GROUPS` array (a fully-formed, plausible-looking category grouping
concept — High Intent / Long-tail / Competitor / Problem-based / Generic) is **dead code**, imported nowhere
(§D.14). See §E for what would be required to build this for real.

---

## C. Data-source map

| UI field | Component/file | API route | DB table.column | Amazon source | Status | Freshness | Fallback | Wording defensible? |
|---|---|---|---|---|---|---|---|---|
| Keyword text | `keywords/page.tsx` table | `/api/asins/[asin]/keywords/track` | `tracked_keywords.keyword` | Seller-typed or autocomplete-selected | Live, user input | n/a | n/a | Yes |
| Product/ASIN | product selector | `/api/asins/listings`, `tracked_asins` | `tracked_asins.*` | SP-API Catalog (via existing ASIN sync, not re-audited here) | Live | Inherits ASIN sync freshness | "Details not available yet" for unresolved external metadata (`safeExternalTitle`, `:172-182`) | Yes |
| Category (product) | none in Keywords tab | n/a | `tracked_asins.category` (read but not shown here) | SP-API/Catalog, external metadata | Not surfaced | n/a | n/a | n/a — not displayed |
| Category (research dropdown) | `keywords/page.tsx:2160-2174` | sent to `/api/keywords/research` but **ignored server-side** | none | Hardcoded 4-item static list | **Decorative/placeholder** | n/a | n/a | **No — should be removed or wired** |
| Organic rank | tracking table + ASIN-detail widget | `/api/{keywords,asins/[asin]/keywords}/refresh` | `keyword_rank_snapshots.organic_rank` | Live Playwright scrape of `amazon.in` search results (pages 1-3), via checker-worker | Live | Per-row "Checked"/`DataFreshnessBadge` | `null` when not found or check failed — never `0` (CONFIRMED, see §D.5) | Yes |
| Sponsored rank | tracking table only (not on ASIN-detail widget) | same as above | `keyword_rank_snapshots.sponsored_rank` | Same scrape, sponsored-flagged result cards | Live | Same | Same null discipline | Yes |
| Organic/Sponsored page, slot | tracking table | same | `.organic_page/.organic_slot/.sponsored_page/.sponsored_slot` | Same scrape (added in migration 022) | Live | Same | `null` if not found | Yes |
| Search Frequency Rank | **not in Keywords tab** — only in Brand Analytics Search Terms | `/api/brand-analytics/search-terms` | (separate Brand Analytics tables, not re-audited) | `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` | Live, siloed | Shown via report period fields | n/a | Yes — labeled "search frequency," never "search volume" (`page.tsx:557,677`) |
| Search volume | Keyword Research table + `tracked_keywords.search_volume` column | `research/route.ts` | `tracked_keywords.search_volume` | **No source exists** | **Permanently null** | n/a | Renders `—` | Yes — never fabricated, always null-safe render (`:2220-2224`, `asins/[asin]/page.tsx:256-257`) |
| CPC estimate | Keyword Research table | `research/route.ts` | `tracked_keywords.cpc_estimate` | **No source exists** | **Permanently null** | n/a | Renders `—` | Yes |
| Difficulty | Keyword Research table (`DifficultyBar`) | `research/route.ts` | `tracked_keywords.difficulty` | **No source exists** | **Permanently null** | n/a | `DifficultyBar` only renders when non-null; always `—` in practice | Yes |
| Competition | Keyword Research table | `research/route.ts` | none stored | **No source; `CompetitionBadge` unused dead code** | Always `—` literal | n/a | n/a | Yes (shows `—`, never fakes a level) |
| Intent | Keyword Research table | `research/route.ts` | none stored | **No source; `IntentBadge` unused dead code** | Always `—` literal | n/a | n/a | Yes |
| Top ranking ASIN | Keyword Research table | `research/route.ts` | none stored | **No source** | Always `—`/null | n/a | n/a | Yes |
| Impressions/Clicks/Conversions/Orders/Sales/Spend/CTR/CVR | **Not present anywhere in the Keywords tab** | — | — | These exist only in the separate Ads/Business-Report warehouse, never joined here | N/A | N/A | N/A | N/A — correctly absent, not fabricated |
| Opportunity score / Recommended action | **Not present in the Keywords tab.** Exists only as free-text `recommended_action` strings inside `generate-alerts.ts`'s keyword alert rows (§D, not a score) | `generate-alerts.ts:398-399,414-415` | `alerts.recommended_action` | Rule-based (page-1 entry/exit only) | Live but simple, fully traceable | n/a | n/a | Yes — plain rule, not an unexplained model |
| Rank change ("Movement") | tracking table `MovementChip`, ASIN-detail `movement` column | derived client-side | derived from two most-recent `keyword_rank_snapshots` rows | Same scrape | Live | n/a | `—` when either side is null | Yes |
| Last checked | Both surfaces | — | `keyword_rank_snapshots.checked_at` | Same scrape | Live | `timeAgo()` | n/a | Yes |

---

## D. Trust/correctness questions

### D.1 Organic vs sponsored rank — kept separate?

**Yes, CONFIRMED, cleanly.** Migration 022 (`022_keyword_rank_separate_placements.sql`) explicitly split what
was originally a single ambiguous `page`/`position_on_page` pair into distinct `organic_*` / `sponsored_*`
column families with a backfill that only assigns legacy values when unambiguous (`:11-27`). The checker itself
(`checker-worker/src/checkers/keywordRank.ts:64-139`) tracks two independent counters (`organicCounter`,
`sponsoredCounter`) and never merges them into one number. The UI renders them in separate table columns
(`keywords/page.tsx:1787,1790`) and never sums or averages organic+sponsored into a single "rank." This is the
strongest-trust area of the whole feature.

### D.2 Are Ads search terms ever presented as organic keyword intelligence?

**No, CONFIRMED by absence.** As established in §B.9/§C, the Ads search-term/targeting warehouse tables are
never queried by anything under `keywords/page.tsx` or its API routes. There is no code path where Ads data
could leak into this page's organic-rank fields.

### D.3 Is Search Frequency Rank ever mislabeled as "search volume"?

**No, CONFIRMED.** The one place SFR appears in this codebase (`brand-analytics/search-terms/page.tsx`) labels
it correctly as "search frequency" throughout (`:557` `#{formatNumber(row.searchFrequencyRank)}`, `:677` "ranks
#N by search frequency"). The Keywords tab's own `search_volume` field is a **different, always-null** column
(§C) and is never conflated with SFR — they don't even appear on the same page.

### D.4 Is estimated/derived volume ever presented as fact?

**No — it is never presented at all**, which is the correct conservative choice given no source exists. Every
volume/CPC/difficulty/competition cell renders `—` when null (§C), and the API route's own comment is explicit
that these metrics require a third-party source not currently integrated (`research/route.ts:9-11,98`).

### D.5 Is a missing/null rank ever displayed as rank "0"?

**No instance found, CONFIRMED across every render site checked.** Specifically checked for the
`rank || 0` / truthy-coercion pattern:
- `keywords/page.tsx:1897`: `kw.organic_rank != null ? `#${kw.organic_rank}` : '—'` — explicit null check, not truthy.
- `keywords/page.tsx:1913`: same pattern for sponsored rank.
- `asins/[asin]/page.tsx:232-237`: `kw.rank !== null ? `#${kw.rank}` : ...` — explicit null check.
- `MovementChip` (`:271-299`): returns `—` when either `current` or `prev` is `null`, never coerces to 0.
- Snapshot inserts (`refresh/route.ts:126-138`, `asins/[asin]/keywords/refresh/route.ts:114-125`) write
  `organic_rank: null` / `sponsored_rank: null` explicitly on every failure path — never `0`.

This is the cleanest area of the audit — no evidence of the null-masking bug class found and fixed for
Pincode/Buy Box.

### D.6 Is a failed rank check ever displayed as "not ranking"?

**Partially yes — one confirmed instance, scoped narrowly.** The main Keywords tab (`FoundStatusBadge`,
`keywords/page.tsx:256-269`) checks `scrape_status === 'checker_unavailable'` **before** falling back to the
`found` boolean, so a genuinely-failed/unavailable check correctly shows "Checker not connected," never "Not
found." Its Check History table (`:2118-2121`) also distinguishes "Failed" from "Success" explicitly.

**The ASIN-detail page's separate `KeywordsTable` component does not apply the same discipline in one of its
two status columns.** Its "Found" column (`asins/[asin]/page.tsx:245-254`) only special-cases
`scrape_status === 'never_checked'` and `'failed'` — it does **not** check for `'checker_unavailable'` — so a
checker-unavailable snapshot (which is inserted with `found: false` at
`asins/[asin]/keywords/refresh/route.ts:118-125`) falls through to the `kw.found ? Found : Not found` branch and
renders **"Not found"** in yellow. The adjacent "Status" column on the very same row (`:259-264`) *does* check
`checker_unavailable` correctly and shows "Checker not connected" — so the correct information exists on the
row, but a seller scanning only the "Found" column (arguably the more natural one to skim) sees a false-negative
"Not found" for a check the system never actually completed. This is the same bug class the audit brief asked
to specifically hunt for (the Pincode/Buy Box null-masking precedent), found here in a narrower, partially-
mitigated form — CONFIRMED via direct code read, not yet observed live (would require an actual
checker-unavailable event on a real ASIN to see rendered).

Root cause detail: `asins/[asin]/page.tsx:431-433` casts `scrape_status` to `'success' | 'failed' | null` via
`as`, which is a type-system lie — at runtime the value can also be `'checker_unavailable'`, `'not_found'`, or
`'blocked'` (see D.6 continued below), and the `?? 'success'` fallback only fires on actual `null`/`undefined`,
not on those other strings, so the raw string passes through uncorrected into `kw.scrape_status`. The bug is in
the **render** branching (omitting the `checker_unavailable` case), not in this cast, but the cast masks the
gap from the type-checker.

### D.6 continued — the `'blocked'` checker status

The Playwright checker itself can return `status: 'blocked'` (Amazon anti-bot page detected,
`checker-worker/src/checkers/keywordRank.ts:78-93`). The worker's HTTP layer maps this to **HTTP 429**
(`checker-worker/src/server.ts:82`). Because `checker-worker-client.ts`'s `workerPost()` checks the raw fetch
`res.ok` (true only for 2xx) rather than the JSON body's own `ok` field, a 429 response is thrown as
`CheckerWorkerUnavailableError` (`:109-113`) **before** the caller ever sees `status: 'blocked'` — both refresh
routes catch this and classify it as `checker_unavailable` (`isKeywordRuntimeUnavailableError(err) || err
instanceof CheckerWorkerUnavailableError`, `refresh/route.ts:265`). Net effect: a Amazon-side block is
correctly folded into the same honest "checker unavailable" bucket, not silently presented as "not ranking" —
this specific path is safe. The gap in D.6 is really about the ASIN-detail widget's **Found column** omitting
one legitimate `scrape_status` value from its branching, not about the checker's own status taxonomy leaking
through unmapped.

### D.7 Is stale data identifiable?

**Yes, on the main tab.** Every tracked-keyword row has a `DataFreshnessBadge` (`:1953`) plus a plain
"time ago" string (`:1949`). Sync Health also tracks keyword-rank freshness workspace-wide (§D.8). The
ASIN-detail widget shows one aggregate `DataFreshnessBadge` for the whole keyword list (`:1060`, keyed off
`keywords[0]?.checked_at`, i.e., whichever snapshot happens to sort first — not necessarily the most recently
checked keyword if `keywords` isn't re-sorted by `checked_at`; CONFIRMED not re-sorted, `asinKeywords` is set in
the order `tracked_keywords` rows come back from the query, `:397-405`, not ordered by latest snapshot). This is
a minor freshness-badge accuracy gap on the ASIN-detail widget only, not present on the main tab.

### D.8 Sync Health tracking for keyword freshness

**Yes, CONFIRMED, and honestly designed.** `brahmastra-data-health.ts` treats `keyword_rank` as one of two
"on-demand, button-triggered" sources (the other being pincode) with **no cron/run-history table** — staleness
is derived purely from the snapshot rows themselves (`:94-102,327-331`). Default staleness threshold: 48 hours
(`KEYWORD_RANK_STALE_AFTER_HOURS = 48`, `:111`). "Confirmed" is defined as `scrape_status = 'success'`
specifically (excluding `failed`/`checker_unavailable`, `:512-516`), mirroring the same pattern used for the
ASIN checker. The code comment is unusually candid about real production staleness at time of writing:
`"keyword/pincode sat 200-950+ hours stale... this is real signal, not a bug to hide"` (`:100-102`) — this
matches the tracker's "manual/on-demand only, no scheduler" framing exactly (§10 of
`BRAHMASTRA_MASTER_TRACKER.md`).

### D.9 Category mapping — real Amazon taxonomy or internal-only?

**Neither — it's a hardcoded 4-item placeholder list unconnected to anything.** See §E for full detail. Product
records do carry a `category` field sourced from `tracked_asins`/`competitor_asins` (SP-API/external metadata),
but that field is never surfaced or used anywhere inside the Keywords tab (§C).

### D.10 Cross-ASIN aggregation risk

**Confirmed present, one clear instance.** "Average Organic Rank" (`keywords/page.tsx:1330-1335`,
computation `:1274-1280`) averages `organic_rank` across every currently-ranked tracked keyword in the
(optionally ASIN-filtered) view, with no per-keyword-difficulty or per-product weighting. Averaging rank #2 for
an easy long-tail term with rank #58 for a hyper-competitive generic term produces a number (#30) that
describes neither keyword's real situation. This is the exact "averaging ranks across very different
keywords/products" risk the audit brief asked about, and it directly parallels the tracker's already-flagged
"Average BSR... do not blindly average... across unlike categories" concern for the ASIN page
(`BRAHMASTRA_MASTER_TRACKER.md:288-296`) — same trust problem, different feature, not yet audited/fixed here.

### D.11 Keyword text normalization/deduplication

**Client-side trim + case-insensitive dedup within a single bulk-add batch only** (`Set` on
`.trim()`, `keywords/page.tsx:1185`). **Server-side uniqueness is exact-string, case-sensitive**, scoped to
`(workspace_id, tracked_asin_id, keyword, marketplace)` via the migration-022 unique index
(`tracked_keywords_asin_keyword_marketplace_uidx`). So `"Anti Slip Mat"` and `"anti slip mat"` can both be
inserted as separate tracked keywords for the same ASIN — CONFIRMED no case-folding at the DB or insert-route
level (`asins/[asin]/keywords/track/route.ts:73-80` compares `.eq('keyword', normalizedKeyword)` with exact
casing as typed, not lowercased). Not a correctness bug (no data is wrong), but a minor near-duplicate-tracking
hygiene gap.

### D.12 Match types (broad/phrase/exact) silently combined?

**Not applicable — match types don't exist in this feature at all.** Organic rank tracking has no concept of
match type (it's a plain SERP position check, not an ads targeting construct). Ads match types exist only in
the separate, unconnected Ads warehouse (§B.9, §D.2) and were not touched by this audit per scope.

### D.13 Are Brand Analytics date ranges visible?

Not applicable to the Keywords tab itself (Brand Analytics is a separate, unconnected page — §B.9). Within its
own page, `search-terms/page.tsx`'s `ApiMeta` type carries `dataStartTime`/`dataEndTime`/`reportPeriod`
(`:61-63`) suggesting the date range is available to render — not verified further since that page is out of
this audit's primary scope (confirmed only as evidence for the "no connection to Keywords tab" finding).

### D.14 Placeholder/mock/hardcoded values

**Two confirmed instances:**
1. **`mock-keywords.ts` is entirely dead code.** CONFIRMED via workspace-wide grep for every export name
   (`MOCK_RESEARCH_KEYWORDS`, `MOCK_TRACKED_KEYWORDS`, `KEYWORD_RANK_HISTORY`, `KEYWORD_GROUPS`,
   `KEYWORD_ALERTS`, `researchKeywords`, `refreshKeywordRanks`) — the only file in `src/` where any of these
   names appear is the mock file itself. Not imported by `keywords/page.tsx`, any API route, or anything else.
   Same dead-code pattern as `mock-pincode.ts` found in the prior pincode audit, except here it's **fully**
   dead (the pincode mock file was partially live — its city-preset data was still used by the dead legacy
   page). This file's `researchKeywords()`/`refreshKeywordRanks()` functions are explicitly marked
   `// TODO: replace body with real ... call` (`:449,459`) and were evidently superseded by the real
   `/api/keywords/research` and `/api/{keywords,asins}/refresh` routes without the mock file being deleted.
2. **The Keyword Research Category dropdown** (§A.4, §E) — 4 hardcoded options (`All Categories`, `Grocery &
   Gourmet`, `Health & Personal Care`, `Kitchen & Dining`, `Sports & Fitness`, `keywords/page.tsx:2168-2173`)
   that (a) are never read server-side (§A.4) and (b) don't match EasyHOME's actual product categories
   (curtains/home-textile SKUs per `WORK_DONE_SUMMARY.md`'s BOC/Curtains portfolio references) — these read as
   copy-pasted demo placeholder values (the same grocery/tea/ghee theme appears throughout the dead
   `mock-keywords.ts` sample data, e.g. `"pure desi ghee 500ml"`, `"himalayan organic tea bags"`), not a
   deliberate category list for this seller.

No numeric metric (rank, volume, CPC, difficulty) is ever hardcoded or faked — every numeric field is either
live-scraped or explicitly `null`-rendered (§D.4, §D.5).

### D.15 Opportunity/recommendation traceability

The only "recommendation" text in this feature is the two `recommended_action` strings inside the keyword
alert generator (`generate-alerts.ts:398-399,414-415`) — plain, fixed strings ("Review keyword campaign bids...
"/"Boost momentum with additional sponsored ads...") attached to a simple, fully-traceable rule: page-1 exit vs.
page-1 entry, computed from the two most recent **successful** snapshots per keyword (`:354-366,385-417`). This
is honest — not a scored/weighted "opportunity score," just a plain rule with a plain, generic suggested action.
No unexplained model or score exists anywhere in this feature.

**Separately, the orphan-keyword dead end (flagged in the headline and §B.6) deserves restating here as a trust
issue, not just a UX issue:** `/api/keywords/track` (`route.ts:63-77`) inserts `tracked_asin_id: null` by
design (its own docstring says so, `:11`), and every rank-check path — `/api/keywords/refresh` (filters
`.not('tracked_asin_id', 'is', null)`, `refresh/route.ts:84`) and `/api/asins/[asin]/keywords/refresh` (requires
a resolved `tracked_asin_id`) — structurally cannot check a keyword with no ASIN. A keyword tracked from the
Research section's "Track" button (`toggleTrack`, `keywords/page.tsx:1226-1254`) will show up in the main
tracking table (joined via `tracked_asin_id` being `null` → `asin` renders as `—`, `:790`) permanently frozen
at "Never checked," with **no in-UI path to link it to a product afterward**. This is not fabricated data (it
correctly shows "Never checked," never a fake rank), but it is a genuine dead-end workflow the seller has no way
to discover or recover from. Migration 022's `tracked_keywords_unassigned_keyword_marketplace_uidx`
(`022_keyword_rank_separate_placements.sql:37-39`) shows the schema was deliberately designed to allow
unassigned keywords to coexist — INFERRED this was meant as a staging area for keywords-before-linking that was
never given a "link to product" UI affordance to complete the loop.

---

## E. Category experience — evaluated against the founder's stated direction

**Founder's direction:** view all useful Amazon categories (not just what the seller currently sells), select
multiple, see keywords grouped category-wise, bulk-select category keywords, then inspect/filter product-wise.

**What exists today:** Nothing usable toward this goal.
- The only category control on the page is the Keyword Research dropdown, and it does nothing server-side
  (§D.14).
- There is no category taxonomy table anywhere in the read migrations. `tracked_asins.category` and
  `competitor_asins.category` (both referenced in `keywords/page.tsx:475,481,495`) store whatever
  free-text category string SP-API/external metadata supplied for that specific product — this is a
  **per-product attribute**, not a browsable category tree, and it is never rendered in this feature at all.
- `mock-keywords.ts`'s `KEYWORD_GROUPS` (High Intent / Long-tail / Competitor / Problem-based / Generic) is the
  closest thing to a "category-wise grouping" concept in the codebase, but it groups by **keyword intent**, not
  **Amazon product category**, is entirely mock data, and is dead code (§D.14) — it does not serve as a
  template for what the founder is asking for.

**What data exists today that could support a *narrow* version of this:**
- `tracked_asins.category` / `competitor_asins.category` — real (if free-text, SP-API-sourced) category labels
  for products the seller *already tracks*. This could support "group my currently-tracked keywords by my own
  products' categories" — a real, buildable, safe feature using only existing data.
- Nothing in the current schema supports "all Amazon categories" browsing. There is no Amazon Browse Node /
  category-tree table, no category-to-keyword mapping table, and no cached Amazon category taxonomy anywhere in
  the 3 migrations read for this audit or the base schema.

**What would require a new Amazon data source:**
- "View all useful Amazon categories" (not just the seller's own) requires either the **Amazon Product
  Advertising API's BrowseNodes**, a **Rainforest/Keepa-style category taxonomy feed**, or systematically
  scraping Amazon's own category navigation — none of which exist in this codebase today, and the last two are
  explicitly excluded by standing project rule (`BRAHMASTRA_MASTER_TRACKER.md:14`, "No Rainforest, Keepa, or
  additional paid data subscriptions for the MVP"). PA-API access/credentials were not found anywhere in this
  codebase during this audit (not confirmed absent with full certainty — PA-API integration files were not
  specifically searched for beyond the keyword-adjacent files read; flagged as **UNKNOWN, not INFERRED absent**
  — a follow-up grep for `paapi`/`ProductAdvertisingAPI` across the full `src/` tree would settle this
  definitively and was out of this audit's time budget).
- "See keywords grouped category-wise" for categories the seller doesn't sell in yet is doubly blocked: even if
  a category taxonomy existed, there is no source of *keywords per category* — Amazon doesn't publish this
  directly, and Brand Analytics Search Terms data (the closest real signal, §C) is scoped to what buyers search
  for in relation to *your* catalog's departments, not a full external category browse.

**What could be implemented safely using only current data:**
- Group *tracked* keywords by the *tracked ASIN's own* `category` string (a real field, already populated for
  many products). This directly serves "inspect/filter keywords product-wise" today (trivial — the ASIN filter
  already exists, `:1713-1724`) and could extend to a shallow "group by category" view over the seller's own
  existing categories, with an honest label like "Your product categories" rather than "Amazon categories."
- Do **not** promise "all Amazon categories" — no trusted category data source exists in this codebase today,
  confirmed against the 3 migrations and the schema read. Building a UI that implies full-catalog category
  browsing without that backing data would create exactly the kind of unearned-confidence problem this audit
  series (Pincode, and now Keywords) keeps finding.

---

## F. Proposed Keywords V1 — five separate areas

Per the brief's explicit instruction, these are kept conceptually separate — no merging of sources/meanings into
one table.

### F.1 Keyword Discovery
- **Primary action:** enter a seed keyword (or pick a tracked product to auto-suggest seeds from its title —
  the existing `getKeywordSeedSuggestions()` logic, `:193-223`, already does this reasonably well and should
  stay).
- **Filters:** marketplace only (keep; it's functional). **Remove the Category filter** until §E's data gap is
  closed, or replace it with "Filter by my tracked categories" sourced from `tracked_asins.category` (real
  data) instead of the current hardcoded/inert list.
- **Bulk actions:** multi-select checkboxes on suggestion rows → "Track selected" (currently one-at-a-time only,
  §B.5).
- **Summary:** count of suggestions returned; explicit note (rendered, not just in the API response) that
  volume/CPC/difficulty are not available from any connected data source yet.
- **Table columns:** Keyword only, plus the Track action. Drop the permanently-empty Volume/CPC/Competition/
  Difficulty/Intent/Top-ASIN columns (or keep them visually collapsed/hidden until a real data source exists) —
  showing six columns of `—` looks broken, not "honestly unavailable."
- **Status vocabulary:** "Suggested" → "Tracking" (already exists, keep).
- **Empty state:** already good ("Enter a seed keyword...").
- **Freshness:** N/A (live autocomplete each time).
- **Detail drawer:** not needed for this simple a surface.
- **Seller-facing explanation:** one line, always visible when results are shown: "These are Amazon's own
  autocomplete suggestions. Search volume, CPC, and difficulty are not available yet."

### F.2 My Tracked Keywords
- **Primary action:** add/remove keywords per product (existing single+bulk add is solid, keep).
- **Filters:** by ASIN (exists), by status (Page 1 / Top 10 / Not ranking / Never checked / Checker unavailable
  — new, currently only inferrable from scanning the table).
- **Bulk actions:** bulk "Refresh Ranks" for a filtered subset (currently only "refresh everything visible,"
  one at a time — fine to keep serial given the Playwright constraint, but let the seller scope it to fewer
  keywords via the existing filter before firing).
- **Summary cards:** keep the existing 7, but split "Average Organic Rank" into something that doesn't average
  across dissimilar keywords — e.g. "X keywords on Page 1" / "X keywords not ranking" as counts, not a blended
  average (§D.10).
- **Table columns:** current set is good (Keyword, ASIN, Product, Organic Rank/Page/Slot, Sponsored
  Rank/Page/Slot, Movement ×2, Status, Checked, Freshness) — no changes needed.
- **Status vocabulary:** keep the existing four-state `FoundStatusBadge` (Never checked / Checker not connected
  / Found / Not found) — it's the one place in this feature already doing this correctly (§D.6).
- **Empty states:** existing three-way empty state (no product selected / no keywords for product / filter
  excludes everything) is good, keep.
- **Loading/failure states:** existing per-row refresh progress counter is good, keep.
- **Freshness:** existing `DataFreshnessBadge` per row, keep.
- **Detail drawer concept:** clicking a row already reveals the trend chart below (keep) — consider making this
  a slide-over drawer instead of a page-anchored section so multi-keyword comparison doesn't require losing
  place in a long table.
- **Fix, not just recommend:** close the orphan-keyword dead end (§D.15/§B.6) — either remove the Research
  section's ability to track without a product, or add a "Link to product" affordance for existing unassigned
  rows.

### F.3 Organic Rank (the chart/history half of the current "tracking table + chart")
- Could remain part of F.2 as a drawer/expansion rather than a fully separate top-level area — but if split
  out, **primary action:** select a keyword, see its trend.
- **Filters:** 7/14/30-day range toggle (exists, keep).
- **Summary:** current rank, best rank in range, worst rank in range (new — currently only "current" is shown
  in the chart header).
- **Table:** existing Check History table (timestamp, rank, page, found, status) is good.
- **Status vocabulary:** Success / Failed / Checker unavailable — extend the Check History table's binary
  Success/Failed rendering to a third "Checker unavailable" label (currently folded into "Success" implicitly
  wherever `scrape_status` isn't exactly `'failed'`, `:2119-2121` — a real gap worth closing alongside D.6).
- **Freshness:** per-row timestamp (exists).
- **Seller-facing explanation:** "Organic rank is checked by simulating an Amazon search for this exact
  keyword and finding your product's position, up to page 3."

### F.4 Advertising Search Terms
- This already exists as a fully separate, working page (`brand-analytics/search-terms/page.tsx`) — **do not
  rebuild it inside the Keywords tab.** The correct V1 move is a clearly-labeled **cross-link**, not a merge:
  a small card or button on the Keywords tab ("See Amazon Ads search-term data for this ASIN →") that deep-links
  to the existing Search Terms page filtered to that ASIN, making the *existence* of a separate,
  differently-sourced signal visible without conflating the two data models. This directly answers the brief's
  ask ("how do Ads search terms connect to this page, if at all — none today") with the smallest safe fix:
  make the non-connection into an intentional, labeled connection instead of two silent islands.
- **Do not** add spend/CTR/CVR/ACOS columns to the Keywords tab itself — those belong to the Ads warehouse and
  mixing them into an organic-rank table risks exactly the organic/paid conflation this audit was asked to rule
  out (currently correctly absent, §D.2).

### F.5 Category Opportunities
- Per §E: **do not build "all Amazon categories" in V1.** No trusted data source exists for it yet.
- Smallest honest V1: group the seller's *own tracked keywords* by the *tracked ASIN's own* category string
  (real data, already in `tracked_asins.category`), explicitly labeled "Your product categories" — not "Amazon
  categories." Primary action: pick one of the seller's own categories, see keyword coverage across the
  products in it.
- **Filters:** category (from real data), status (Page 1 / not ranking).
- **Bulk actions:** "Refresh all keywords in this category" (reuses the existing serial refresh mechanism).
- **Summary cards:** keyword count, Page-1 count, not-ranking count — per category, not blended across
  categories.
- **Empty state:** "No category data available for your tracked products yet" when `category` is null for all
  selected products — this will happen often since `category` population depends on upstream ASIN sync, not
  this feature.
- **Explicitly flag as Deferred, not V1:** true Amazon-wide category browsing, category-to-new-keyword
  discovery, and cross-seller competitive category analysis — all require a new Amazon data source per §E.

---

## G. Prioritization

### P0 — wrong/misleading data, fake metrics as real, rank failure shown as fact, source mixing, wrong mapping

1. **ASIN-detail widget's "Found" column omits the `checker_unavailable` case**, rendering a failed/unattempted
   check as "Not found" (a specific product claim) instead of an honest "unknown" state, while the adjacent
   Status column on the same row gets it right (§D.6). This is the one confirmed instance of the exact bug
   class the audit brief was written to hunt for.

*(No other P0s found. Organic/sponsored separation is clean (§D.1), no Ads-data mixing exists (§D.2), SFR is
never mislabeled as volume (§D.3), no fake volume/CPC/difficulty is ever presented as fact (§D.4), and no
rank-as-0 masking exists anywhere checked (§D.5). This is a materially cleaner starting point than the Pincode
audit found.)*

### P1 — confusing workflow, missing category/bulk selection, unclear labels, missing freshness/error states

2. **Orphan-keyword dead end**: `/api/keywords/track` creates ASIN-less keywords that can never be rank-checked
   and have no in-UI path to become linkable (§D.15, §B.6).
3. **Decorative Category dropdown** in Keyword Research — sent to the server, silently ignored, populated with
   demo-artifact category names irrelevant to EasyHOME (§D.14, §A.4).
4. **`mock-keywords.ts` fully dead code** — should be deleted or clearly marked as historical/reference-only, so
   a future session doesn't mistake its `KEYWORD_GROUPS`/`MOCK_TRACKED_KEYWORDS` shapes for a live template
   (§D.14).
5. **`CompetitionBadge`/`IntentBadge` dead components** — same cleanup class as #4 (§A.4).
6. **Research section's `note` field explaining the metrics gap is fetched but never rendered** — the honesty
   already exists in the API response and is being thrown away client-side (§A.2).
7. **ASIN-detail widget's aggregate freshness badge may not reflect the most-recently-checked keyword** — not
   re-sorted by `checked_at` before reading `keywords[0]` (§D.7).
8. **Check History table's binary Success/Failed labeling swallows "checker unavailable" into "Success"**
   (`:2119-2121`) — related to but distinct from the P0 above; here the mislabel is on the main tab, in a
   secondary (History) view rather than the primary Found/Status columns, and is more of an incomplete label set
   than a factual claim (§F.3).
9. **No cross-link between the Keywords tab and Advertising Search Terms**, despite both being keyword-adjacent
   and commonly needed together (§B.9, §F.4).
10. **No bulk-select in Keyword Research results** — every suggestion must be tracked individually (§B.5).
11. **"Average Organic Rank" KPI blends dissimilar keywords/products into one number** — same trust class as
    the tracker's already-flagged "Average BSR" concern (§D.10).

### P2 — advanced scoring, richer trends/visualizations, cross-category exploration, automation/recommendations

12. Real keyword-difficulty/competition/volume scoring (requires a new data source — see Deferred).
13. "My product categories" keyword grouping (§F.5) — buildable with current data, but a genuinely new feature,
    not a fix to an existing broken thing.
14. Batch/parallelized rank refresh to reduce the serial-refresh wait time for sellers with many tracked
    keywords (§B.7) — a real UX improvement, not a correctness fix.
15. Best/worst-rank-in-range summary on the trend chart (§F.3).

### Deferred — requires a new paid API or Amazon data source not currently in this codebase

16. "All Amazon categories" browsing (§E) — requires PA-API BrowseNodes or an external taxonomy provider;
    excluded by standing project rule against new paid subscriptions absent proven ROI
    (`BRAHMASTRA_MASTER_TRACKER.md:14,214-223`).
17. Real search volume / CPC / keyword difficulty / competition scoring — requires a third-party keyword-data
    provider (Rainforest, Keepa, Helium 10-class tool, or similar); explicitly out of scope per the same
    standing rule.
18. Keyword-to-category mapping at Amazon-wide scale (beyond the seller's own tracked products) — same
    dependency as #16.

### Smallest safe first PR (scoped, not implemented)

**Fix P0 #1 only.** Add the missing `scrape_status === 'checker_unavailable'` branch to the ASIN-detail widget's
"Found" column (`asins/[asin]/page.tsx:245-254`), mirroring the exact pattern the main tab's `FoundStatusBadge`
already uses correctly (`keywords/page.tsx:256-269`) — e.g. render "Checker not connected" (or reuse the same
badge component) instead of falling through to the found/not-found branch. This is a single small render-branch
change, in one file, with a precedent already proven correct elsewhere in the same codebase, and it is the only
confirmed P0 in this feature. It should not be bundled with any P1/P2 item above — each of those is a separate,
independently-approvable decision (removing dead code, wiring or removing the category dropdown, deciding
whether to build the orphan-keyword fix as "block the entry point" vs. "add a link-to-product affordance," etc.)
and should go through its own founder approval, matching how the Pincode P0 fix was scoped and shipped
separately from its P1/P2 findings.
