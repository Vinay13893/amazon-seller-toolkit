# Pincode Checker — Unified Page Product Spec

**Status:** Spec only, amended. No application code, migration, or deployment in this round or the prior
one — this PR remains spec-and-review only; **do not merge, implement, or deploy** until separately
approved.
**Worktree:** branch `spec/pincode-unified-page`, off latest `origin/master`.
**Inputs:** `PINCODE_CHECKER_PRODUCT_AUDIT.md` (2026-07-17 audit, 2 P0s already fixed separately —
`BRAHMASTRA_MASTER_TRACKER.md` §20), the Pincode-unified-page background research pass (§20/§21 history,
same tracker), the founder-locked decisions below, and a 2026-07-18 correction round (13 technical
corrections to the first draft — see `BRAHMASTRA_MASTER_TRACKER.md` §22 amendment entry for the full list).
Companion documents: `PINCODE_UNIFIED_PAGE_DATA_MODEL.md` (schema) and
`PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md` (scheduler, phasing, rollout).

**Amendment (2026-07-18):** the first draft locked recurring tracking into P0 correctly, but its schema had
a self-contradictory owned-product FK, no cross-workspace FK enforcement, an RLS model that let ordinary
members write scheduler state, a non-atomic claim design, and a P0/P1 split that quietly demoted the
founder-required trustworthy Other Products lookup to P1 while allowing blind manual enrollment in P0. This
round corrects all of that without changing the locked product decisions themselves. Section-by-section
changes are called out inline as **"Correction N (2026-07-18)"** blocks.

---

## 1. Goal

Replace the three disconnected pincode surfaces found by the prior audit (a live bulk-queue tool writing
to `pincode_availability_results`, a dead legacy per-ASIN page, and a live single-check widget writing to
`pincode_checks`) with **one page**, visually consistent with the existing ASIN Tracking page
(`src/app/(dashboard)/dashboard/asins/page.tsx`), that lets a seller: pick products (their own or any other
ASIN), assign pincodes, get **recurring** availability tracking (not just one-off checks), and see results
with an honest, never-misleading four-state vocabulary.

---

## 2. Founder decisions — locked for V1

These are not open questions. Everything below is designed to satisfy them, not to re-litigate them.

1. **Route:** `/dashboard/pincode-checker` (reuse the existing live route in place).
2. **Navigation:** Pincode Checker stays its own top-level nav item.
3. **Tabs:** My Products / Other Products.
4. **My Products source:** `amazon_listing_items` (the seller's synced catalog — **not** `tracked_asins`,
   which today holds only manually-added "Competitor" ASINs; see §5 and `DATA_MODEL.md` §2 for why this
   matters).
5. **Other Products:** must not be auto-labeled "competitor," must not be forced into `tracked_asins` just
   to use Pincode Checker. The new Pincode data model tracks an external ASIN directly; `tracked_asins` may
   be *linked* opportunistically but is never mandatory.
6. **Tracking allowance:** My Products and Other Products share one workspace tracking quota.
7. **Default pincodes:** persisted at workspace + marketplace level.
8. **Tracking scope:** recurring standing product×pincode tracking is in V1 — **not** a manual-check-only
   history page. (See §9 below — this decision changes the P0 phasing materially.)
9. **Manual "Check Now":** quota/rate-controlled, safely queued — never unrestricted/instant-fire.
10. **Archived products:** pause future checks, preserve history, stay visible under an Archived filter,
    never silently vanish with inaccessible history.
11. **Results tables:** `pincode_checks` and `pincode_availability_results` are preserved as-is in this
    phase — no consolidation, no deletion.
12. **Legacy route:** the dead `/dashboard/pincode` page gets a redirect to the unified page (mirroring the
    existing `/dashboard/pincode` → `/dashboard/pincode-checker` redirect already in place today — see
    `PINCODE_CHECKER_PRODUCT_AUDIT.md` §1 item 2 — this decision simply keeps that redirect valid once the
    unified page replaces the current bulk-queue UI at the same route).
13. **Alerts:** stay disabled (`PINCODE_ALERTS_PAUSED = true`, unchanged) until the unified data path and
    scheduler are verified live.

---

## 3. A critical premise correction (from the research pass)

The original framing assumed `tracked_asins` might need a new `product_source` column to distinguish
My Products from Other Products. **That premise doesn't hold.** `tracked_asins` today holds only
manually-added ASINs (`supabase/migrations/001_initial_schema.sql:102-115` — no `target_type`/`source`
column exists there, confirmed by grep across all 59 migrations). The seller's actual owned catalog lives
in a **separate** table, `amazon_listing_items` (migration `007`), populated by the existing SP-API
listings sync and already used as the "My Products" source on the ASIN Tracking page
(`GET /api/asins/listings`, `src/app/api/asins/listings/route.ts`).

This means the founder's "My Products / Other Products" split is a **two-table join**, not a single-table
filter — exactly how the existing ASIN Tracking page already handles it (reuse that pattern, don't invent a
new one). This is why the data model (§`DATA_MODEL.md`) introduces `pincode_monitored_products` as an
independent enrollment table with two nullable FK columns rather than trying to bolt tracking state onto
either source table directly.

---

## 4. Route, navigation, and legacy behavior

- **Live route:** `GET /dashboard/pincode-checker` — the existing bulk-queue page's UI is replaced in
  place; the route/nav entry doesn't change (decision #1/#2), so no link anywhere in the app breaks.
- **`/dashboard/pincode`** (dead legacy page): its `layout.tsx` already unconditionally
  `redirect('/dashboard/pincode-checker')` — no change needed, decision #12 is already satisfied by
  existing code. Confirmed via direct read during the prior Pincode audit.
- **ASIN-detail page's single-pincode widget** (`asins/[asin]/page.tsx:1091-1229`, `pincode_checks`
  table): **out of scope for this phase.** It already has its correct four-state rendering from the earlier
  P0 fix (`src/lib/pincode-status.ts`, tracker §20) and continues to write to `pincode_checks` as today.
  Whether to eventually fold it into the unified page's product-level history view is a P2/future decision,
  not part of this spec.

---

## 5. End-to-end flows

### 5.1 My Products — bulk enrollment

1. Seller opens Pincode Checker → **My Products** tab (default).
2. Page loads the seller's synced catalog from `amazon_listing_items` (same query shape as
   `GET /api/asins/listings`), paginated/searchable exactly like the ASIN Tracking page.
3. Each row shows current Pincode-tracking state (§7): **Not tracked / Partially tracked / Active / Paused
   / Archived / Failed**.
4. Seller selects one, several, or all-visible rows (checkboxes, same interaction pattern as ASIN
   Tracking's bulk actions).
5. Seller clicks **Track Pincode Availability** → a pincode-selection step appears: choose workspace
   defaults (pre-checked) and/or add a temporary override list for this enrollment only (§8).
6. Confirm → for each selected product, the system upserts one `pincode_monitored_products` row
   (`product_source = 'owned'`, FK to `amazon_listing_items.id`) and one `pincode_tracking_targets` row per
   (product × pincode) pair, `status = 'active'`, `next_check_at = now()` (immediately due).
7. No synchronous check happens here — enrollment only queues future work; the recurring scheduler
   (`IMPLEMENTATION_PLAN.md` §Scheduler) picks it up on its own cadence, same as decision #8 requires.

### 5.2 Other Products — single-ASIN enrollment

1. Seller switches to **Other Products** tab.
2. Enters an ASIN → client-side format validation (`/^[A-Z0-9]{10}$/`, same regex already used by
   `addOrRestoreTrackedAsin`, `src/lib/supabase/asins.ts:28-32`).
3. Server resolves the product through the **approved lookup path** (§6) — a live SP-API Catalog lookup,
   not a guess, not scraped from Seller Central.
4. A **product preview** renders (title, image, brand if available) — labeled **"Other Product"**
   throughout, never "Competitor," never implying ownership (decision #5, data-truth rule).
5. Seller picks default and/or custom pincodes (same picker as §5.1 step 5).
6. Confirm → one `pincode_monitored_products` row (`product_source = 'other'`, FK to nothing mandatory; a
   `tracked_asins` link is attempted opportunistically and stored if a matching row already exists, but its
   absence never blocks enrollment) + one `pincode_tracking_targets` row per pincode, same as §5.1 step 6.
7. **Duplicate prevention:** the unique constraint on `pincode_monitored_products (workspace_id,
   marketplace_id, asin)` (see `DATA_MODEL.md` §2) rejects a second enrollment of the same ASIN in the same
   workspace regardless of which tab it was added from — if a seller's own catalog ASIN is later also
   entered as "Other," the enrollment RPC detects the existing row and returns it (already tracked) rather
   than silently erroring or creating a second row.

**Correction 1 (2026-07-18) — Other Product becoming Owned:** if an ASIN enrolled as "Other Product" later
appears in the seller's synced catalog (`amazon_listing_items`, e.g. after a new SP-API listings sync), it
must **not** remain labelled "Other Product" once ownership is confirmed. Resolution (recommended, applies
to both the periodic reconciliation pass and any future listings-sync job): when a matching
`(workspace_id, marketplace_id, asin)` row appears in `amazon_listing_items` for an existing
`pincode_monitored_products` row with `product_source = 'other'`, that row is **updated in place** —
`product_source` flips to `'owned'`, `amazon_listing_item_id` is attached, and the row's `id`,
`created_at`, and all `pincode_availability_results` history stay exactly as they were. No new monitored
product is created, no history is duplicated or orphaned. See `DATA_MODEL.md` §2a for the exact
reconciliation query and `IMPLEMENTATION_PLAN.md` §5 test #13 for the required test.

### 5.3 Pincode Settings

1. Workspace defaults (§8) are managed from a dedicated panel reachable from the page header
   ("Add/manage default pincodes") — not scattered per-enrollment.
2. Add one pincode (validated), remove one, bulk-paste (newline/comma-separated, validated and
   de-duplicated client-side before submit, then re-validated server-side).
3. Saving defaults **does not** retroactively change any existing enrollment's pincode list — only new
   enrollments pick them up by default (an existing enrollment's list is edited independently, per-product,
   from the tracker table's expand row).
4. A confirmation step appears before saving a default list with a large pincode count (exact threshold:
   P1 decision, not blocking; a reasonable starting point is confirming above 20, since that's already
   double the existing bulk checker's per-job pincode cap — see `PINCODE_CHECKER_PRODUCT_AUDIT.md` §9,
   `MAX_PINCODES=20`).

### 5.4 Tracker table — inspect and act

1. Below the tabs, one section shows **all** currently-enrolled products (both sources), independent of
   which tab is selected — this is the standing tracking view, not a per-tab list.
2. Each product is a collapsed top-level row; expanding it reveals its individual pincode rows (§10 — this
   avoids a 100-product × 10-pincode = 1,000-row flat table).
3. Row-level actions: Check Now (§9), Edit Pincodes, Pause/Resume, View History, Remove. Per-pincode
   actions inside the expanded view: Check Now (single pincode), Pause/Resume (single pincode), History,
   Remove (single pincode from this product's list).

---

## 6. Approved product lookup path (Other Products) — P0, trustworthy SP-API resolve/preview

**Correction 11 (2026-07-18):** the first draft flagged this lookup as "unconfirmed" and the companion
Implementation Plan then quietly moved it to P1, while still allowing P0 to enroll an Other Product from a
bare typed ASIN with no verification. That is a direct contradiction of the founder's request ("search by
ASIN, preview the product, select it, then track it") and is corrected here: **a trustworthy ASIN
resolve/preview is P0, not P1.** Blind manual enrollment (typing an ASIN with no verification it resolves
to a real product) is no longer part of the P0 Other Products flow.

The current `AddAsinDialog`/`handleAddAsin` flow on the ASIN Tracking page's Competitors tab
(`asins/page.tsx:284-295` → `addTrackedAsin`/`addOrRestoreTrackedAsin`, `src/lib/supabase/asins.ts:117-193`)
still does **not** perform a live SP-API catalog lookup — confirmed unchanged, it validates ASIN format only
and inserts whatever title/brand/image the dialog itself collected (or blank). This is correctly **not**
reused for Other Products' lookup.

**The reusable helper is now confirmed, not speculative:** `getCatalogItemForAsin({ accessToken,
marketplaceId, asin, signal })` in `src/lib/amazon/catalog.ts` is a real, already-shipped, server-only SP-API
Catalog Items (2022-04-01) helper — already called from three existing routes
(`src/app/api/keywords/products/route.ts`, `src/app/api/asins/jobs/process-next/route.ts`,
`src/app/api/asins/[asin]/refresh/route.ts`), each following the same pattern: load the workspace's
`amazon_connections` row, `refreshAccessToken(decryptToken(connection.refresh_token_encrypted))`, then call
`getCatalogItemForAsin` under an `AbortController` timeout. The new `POST
/api/pincode-monitoring/lookup-asin` route (§11) reuses this exact pattern verbatim — no new SP-API
integration code, no scraping, no user cookies, no Seller Central page ever touched.

**Honest failure, never fabricated data:**
- No active `amazon_connections` row for the workspace → `503 { errorCode: 'catalog_connection_unavailable'
  }`, surfaced in the UI as "Amazon connection required before looking up a product."
- `getCatalogItemForAsin` throws `catalog_not_found` (SP-API 404) → the UI shows an honest "Amazon could not
  confirm this ASIN — check the ASIN and try again," and **the product is not enrollable** from this state.
  The founder's instruction is explicit on this point: *"if Amazon cannot confirm the ASIN, do not enroll it
  as a valid product."* There is no manual override that skips a confirmed lookup for the P0 Other Products
  path.
- `getCatalogItemForAsin` throws `catalog_unavailable` (SP-API non-404 error) or the lookup call times out →
  a distinct, honest "Lookup failed — try again" state, retryable, still not enrollable until it succeeds.
  This is a transient-failure state, not a "confirmed does not exist" state, and must render differently
  from the 404 case above.
- A successful lookup with a partially empty payload (e.g. `title` present, `image_url` null) renders
  whatever fields SP-API actually returned — matches this codebase's "never fabricate" discipline
  (`BRAHMASTRA_MASTER_TRACKER.md` §20) — it does not block enrollment on a missing image alone, only on a
  confirmed-nonexistent or failed-to-resolve ASIN.

**Rate/timeout discipline:** the lookup call reuses the same `AbortController` + fixed-timeout pattern as
the three existing callers (see `keywords/products/route.ts` for the exact shape) — implementation should
confirm the existing `ENRICHMENT_TIMEOUT_MS` constant's value and reuse it rather than inventing a new
timeout, so the lookup route's behavior stays consistent with the rest of the app's SP-API call sites.

---

## 7. Product states (My Products tab, tracker table)

| State | Meaning |
|---|---|
| **Not tracked** | No `pincode_monitored_products` row exists for this catalog item yet. |
| **Partially tracked** | A monitored-product row exists, but fewer pincodes are configured than the current workspace defaults (a signal, not an error). |
| **Active** | Monitored, at least one `pincode_tracking_targets` row is `active`. |
| **Paused** | Monitored, but every target for this product is `paused` — no future checks will run. |
| **Archived** | The underlying `amazon_listing_items`/`tracked_asins` source (or the monitored-product row itself) is archived or its owned-listing reference was removed from the sync — all targets auto-paused (`DATA_MODEL.md` §5, archived-cascade behavior), history preserved, visible only under the Archived filter (decision #10). **Correction 1 (2026-07-18):** an owned product's `amazon_listing_item_id` can legitimately become `NULL` (the source listing row was removed) without the monitored product or its history being lost — this is exactly the case that must land here, not error out or silently vanish. |
| **Failed** | Every target for this product has exceeded its `consecutive_failures` threshold (see `IMPLEMENTATION_PLAN.md` §Scheduler retry policy) — distinct from Paused: this state means the system tried and couldn't get a clean signal, not that the seller chose to stop. |

## 8. Pincode-level states (expanded rows)

**Correction 8 (2026-07-18):** the first draft called this a "four-state vocabulary" but conflated "blocked"
into "check failed," which the unified page must not do — a CAPTCHA/block is an honest, distinct signal
(the checker *ran*, Amazon *blocked* it), not the same thing as a checker crash/timeout. Corrected to the
actual **five-state** vocabulary, backed by two orthogonal database columns (`DATA_MODEL.md` §4 —
`check_status` × `availability_status`) rather than one overloaded field:

- **Available** — `check_status = 'success'`, `availability_status = 'available'`.
- **Unavailable** — `check_status = 'success'`, `availability_status = 'unavailable'`.
- **Not confirmed** — `check_status = 'success'`, `availability_status = 'unknown'`, **or** never checked
  yet (no row exists for this target).
- **Check failed** — `check_status = 'failed'` (checker errored/timed out/crashed).
- **Blocked** — `check_status = 'blocked'` (a CAPTCHA/anti-bot response was detected) — rendered distinctly
  from "Check failed" so a seller can tell "Amazon blocked us" from "our checker broke," which is also the
  scheduler's own signal for whether to back off harder (`IMPLEMENTATION_PLAN.md` §2.6).

This reuses `src/lib/pincode-status.ts`'s existing rendering helper where its logic already matches (the
Available/Unavailable/Not-confirmed cases are unchanged), extended with the explicit Blocked case per the
corrected `DATA_MODEL.md` §4 result-state model.

Fulfillment: **FBA (Amazon Fulfilled)** / **FBM (Merchant Fulfilled)** / **Not confirmed** — same helper,
`getFulfillmentDisplay()`, reused as-is.

---

## 9. Data-truth rules (binding on every surface of this feature)

- Unknown is not unavailable.
- Failed is not unavailable.
- Missing fulfillment is not FBM.
- Missing price is not ₹0.
- Buy Box detected is not Buy Box ownership.
- Missing `next_check_at` is not "due now" (an explicit `NULL`/unscheduled state must render distinctly
  from an overdue scheduled check).
- Archived is not deleted.
- A catalog listing (`amazon_listing_items` row) is not automatically an actively monitored product —
  enrollment is an explicit, separate action.
- An Other Product is not automatically a competitor.
- **(Correction 1)** An Other Product confirmed to be seller-owned does not stay labelled "Other Product" —
  and does not lose its enrollment history when relabelled.
- **(Correction 3)** A browser client's own claim about scheduler state (`status='checking'`, `claimed_at`,
  `next_check_at`, `consecutive_failures`, etc.) is never trusted — only server/service-role writes to these
  fields are truthful by construction, so the UI never lets a member fabricate "checking" or a fake
  `next_check_at`.
- **(Correction 10)** "Checking" shown in the UI reflects a genuinely queued/claimed request, never a
  synchronous fire-and-hope call the browser is blocking on.

---

## 10. Markdown wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Pincode Checker                              [Marketplace: IN ▾]        │
│ Last successful check: 2h ago         [Add/manage default pincodes]     │
│ Checks due: 14                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ Products monitored: 128   Other Products: 6    Pincodes monitored: 8    │
│ Available: 812   Unavailable: 140   Not confirmed/failed: 72            │
│ Checks due: 14                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ [ My Products ]  [ Other Products ]                                     │
├─────────────────────────────────────────────────────────────────────────┤
│ (My Products tab)                                                       │
│ [search box]                          [Select all visible] [Bulk ▾]     │
│ ☐ 🖼  Baby Play Mat ... | B0D9QXVWLL | SKU-123 | Active | 8 pincodes    │
│ ☐ 🖼  Curtain 4x9 ...   | B0EXAMPLE1 | SKU-456 | Not tracked            │
│ ...                                    [Track Pincode Availability]     │
├─────────────────────────────────────────────────────────────────────────┤
│ Tracker (all enrolled products, both tabs)      [Filter: Active ▾]      │
│ ▸ 🖼 Baby Play Mat (B0D9QXVWLL) My Product | 8 pincodes | 6✓ 1✗ 1?      │
│     last checked 3h ago | next check 21h | Active     [Check Now][⋯]   │
│   ▾ 110001  Available   Same-day  FBA   ✓ 3h ago  next 21h  [Check][⋯] │
│     110045  Unavailable —          FBM   ✓ 3h ago  next 21h  [Check][⋯]│
│     560001  Not confirmed —        —     never      due now  [Check][⋯]│
│ ▸ 🖼 Yoga Mat Pro (B0OTHER123) Other Product | 4 pincodes | ...         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Route / component / API map

| Layer | Path |
|---|---|
| Page | `src/app/(dashboard)/dashboard/pincode-checker/page.tsx` (replaces existing content) |
| My Products list | reuses `GET /api/asins/listings` (existing, unchanged) |
| Other Products lookup | new `POST /api/pincode-monitoring/lookup-asin` (§6) |
| Enroll (bulk or single) | new `POST /api/pincode-monitoring/products` |
| Update pincodes for a product | new `PATCH /api/pincode-monitoring/products/[id]/pincodes` |
| Pause/resume/archive a product | new `PATCH /api/pincode-monitoring/products/[id]` |
| Manual Check Now (product or single pincode) | new `POST /api/pincode-monitoring/check-now` — **queued, not synchronous** (Correction 10; validates workspace access + cooldown/quota, records the request atomically, returns `Accepted`/`Queued` immediately; see `IMPLEMENTATION_PLAN.md` §2.10) |
| Workspace default pincodes | new `GET`/`PUT /api/pincode-monitoring/default-pincodes` |
| Tracker table data | new `GET /api/pincode-monitoring/tracker` (paginated, product-row + nested pincode-row shape) |
| Scheduler cron | new `GET /api/cron/pincode-monitoring/process-eligibility` (mirrors the review-requests split-worker pattern — see `IMPLEMENTATION_PLAN.md`) |
| Scheduler worker | new `POST /api/pincode-monitoring/jobs/process-eligibility` |

All new routes follow this codebase's existing auth conventions: session-based for user-facing routes,
`resolveJobsAuth()`/background-worker-secret for the cron/worker pair (same pattern as
`src/app/api/review-requests/jobs/process-eligibility/route.ts`).

---

## 12. Acceptance criteria (P0)

1. A seller can see their full owned catalog (`amazon_listing_items`) in My Products, searchable/paginated.
2. A seller can select 1..N products and enroll them with the workspace default pincodes in one action.
3. A seller can add an Other Product by ASIN, get a **real, SP-API-confirmed** preview or an honest lookup
   failure, and enroll only a confirmed ASIN — never a blind, unverified one (Correction 11) — without it
   ever being written to `tracked_asins` as a side effect.
4. Enrolling the same ASIN twice (from either tab, or from both) never creates a duplicate
   `pincode_monitored_products` row; an existing "Other Product" that turns out to be owned is converted in
   place, preserving its `id` and history, never duplicated (Correction 1).
5. The tracker table shows one row per enrolled product, expandable to per-pincode rows, never a flat
   product×pincode table.
6. Every availability/fulfillment cell uses the corrected five-state vocabulary (Correction 8: Available /
   Unavailable / Blocked / Check failed / Not confirmed) — no truthy-coercion regressions, and Blocked never
   renders identically to Check failed.
7. Archiving a product (in its source table, or the removal of an owned product's source listing row) pauses
   its future checks, keeps its history queryable, and surfaces it only under an explicit Archived filter —
   never a silent disappearance (Correction 1).
8. Manual "Check Now" is genuinely queued (Correction 10) — the browser gets an immediate
   Accepted/Queued response, never blocks on the storefront check itself; duplicate manual requests for the
   same target are coalesced.
9. `pincode_checks` and `pincode_availability_results` are unmodified in their existing columns/rows by this
   phase (only additive columns per `DATA_MODEL.md` §4/§9) — read-only legacy sources, still queryable for
   history where applicable; existing rows remain readable under the corrected result-state model
   (Correction 8).
10. The recurring scheduler (decision #8) runs at least once end-to-end against real enrolled data in a
    supervised, approved production check, on an **internal-workspace feature flag** (Correction 12) before
    any broader rollout, before the workstream is considered P0-complete (see `IMPLEMENTATION_PLAN.md`
    §Rollout).
11. **(Correction 2)** No monitored product, tracking target, or result row can reference a source row
    (listing, tracked ASIN, or monitored product) belonging to a different workspace — enforced at the
    database layer, verified by a cross-workspace-FK-rejection test, not merely assumed from RLS.
12. **(Correction 3)** No ordinary member session can directly set `status='checking'`, `claimed_at`,
    `next_check_at`, or any other scheduler-owned field via a raw table write — verified by an
    unauthorized-mutation-rejection test.

---

## 13. Explicitly not in this document

- The exact schema (columns/types/constraints/indexes) — see `PINCODE_UNIFIED_PAGE_DATA_MODEL.md`.
- The scheduler's internal mechanics, phasing detail, test plan, and rollout/rollback plan — see
  `PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md`.
- Any actual code or migration — none was written in this round.
