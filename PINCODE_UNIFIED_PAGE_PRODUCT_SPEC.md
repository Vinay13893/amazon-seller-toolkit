# Pincode Checker — Unified Page Product Spec

**Status:** Spec only. No application code, migration, or deployment in this round.
**Worktree:** `C:\Vinay\amazon-seller-toolkit-pincode-unified-page`, branch `spec/pincode-unified-page`, off
latest `origin/master` (`ac29080`).
**Inputs:** `PINCODE_CHECKER_PRODUCT_AUDIT.md` (2026-07-17 audit, 2 P0s already fixed separately —
`BRAHMASTRA_MASTER_TRACKER.md` §20), the Pincode-unified-page background research pass (§20/§21 history,
same tracker), and the founder-locked decisions below. Companion documents:
`PINCODE_UNIFIED_PAGE_DATA_MODEL.md` (schema) and `PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md` (scheduler,
phasing, rollout).

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
   entered as "Other," the system detects the existing row and offers to link/resume it rather than
   silently erroring.

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

## 6. Approved product lookup path (Other Products)

Per instruction, the current `AddAsinDialog`/`handleAddAsin` flow on the ASIN Tracking page's Competitors
tab (`asins/page.tsx:284-295` → `addTrackedAsin`/`addOrRestoreTrackedAsin`,
`src/lib/supabase/asins.ts:117-193`) does **not** perform a live SP-API catalog lookup — it validates ASIN
format only and inserts whatever title/brand/image the dialog itself collected (or blank). This is **not**
the "approved existing lookup path" the founder wants reused, because it cannot produce a trustworthy
product preview for a truly unknown ASIN.

**Recommendation (needs confirmation before implementation, not locked by the founder decisions above):**
use the SP-API Catalog Items API directly — the same API family the ASIN checker pipeline already calls
for BSR/catalog data (per `BRAHMASTRA_MASTER_TRACKER.md`'s ASIN snapshot pipeline history: "SP-API Catalog"
is already a live, approved, in-use data source for this app). A dedicated
`resolveOtherProductPreview(asin, marketplaceId)` server function should call the existing Catalog Items
lookup helper (the exact function name in `src/lib/amazon/catalog.ts` or equivalent needs a direct read
before implementation — **not verified in this research/spec pass**, flagged as an implementation-time
confirmation step, not assumed). This must **never** hit Seller Central pages (hard rule, matches the
founder's explicit instruction and this app's existing "no scraping outside the checker-worker's approved
Playwright checkers" discipline).

If, at implementation time, no clean reusable Catalog lookup helper exists, the fallback is: show the
autocomplete/typed ASIN with a plain, honest "Preview not available — add anyway?" state rather than
fabricate title/image/brand. This mirrors this codebase's established discipline of never inventing product
data (see the Pincode P0 fix's "never guess" principle, `BRAHMASTRA_MASTER_TRACKER.md` §20).

---

## 7. Product states (My Products tab, tracker table)

| State | Meaning |
|---|---|
| **Not tracked** | No `pincode_monitored_products` row exists for this catalog item yet. |
| **Partially tracked** | A monitored-product row exists, but fewer pincodes are configured than the current workspace defaults (a signal, not an error). |
| **Active** | Monitored, at least one `pincode_tracking_targets` row is `active`. |
| **Paused** | Monitored, but every target for this product is `paused` — no future checks will run. |
| **Archived** | The underlying `amazon_listing_items`/`tracked_asins` source (or the monitored-product row itself) is archived — all targets auto-paused (§`DATA_MODEL.md` §2, archived-cascade behavior), history preserved, visible only under the Archived filter (decision #10). |
| **Failed** | Every target for this product has exceeded its `consecutive_failures` threshold (see `IMPLEMENTATION_PLAN.md` §Scheduler retry policy) — distinct from Paused: this state means the system tried and couldn't get a clean signal, not that the seller chose to stop. |

## 8. Pincode-level states (expanded rows)

Same four-state vocabulary as the already-shipped Pincode P0 fix (`src/lib/pincode-status.ts`), reused
verbatim for consistency:

- **Available** — confirmed `available = true`.
- **Unavailable** — confirmed `available = false`.
- **Check failed** — a check was attempted and the checker itself failed/errored.
- **Not confirmed** — never checked yet, or an uncertain (non-success, non-thrown) result.

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
| Manual Check Now (product or single pincode) | new `POST /api/pincode-monitoring/check-now` (quota-gated, §`IMPLEMENTATION_PLAN.md`) |
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
3. A seller can add an Other Product by ASIN, see a real (or honestly-absent) preview, and enroll it,
   without it ever being written to `tracked_asins` as a side effect.
4. Enrolling the same ASIN twice (from either tab, or from both) never creates a duplicate
   `pincode_monitored_products` row.
5. The tracker table shows one row per enrolled product, expandable to per-pincode rows, never a flat
   product×pincode table.
6. Every availability/fulfillment cell uses the same four-state vocabulary as the existing Pincode P0 fix
   — no truthy-coercion regressions.
7. Archiving a product (in its source table) pauses its future checks, keeps its history queryable, and
   surfaces it only under an explicit Archived filter — never a silent disappearance.
8. Manual "Check Now" is rate/quota-limited and queued, never fires an unbounded/instant synchronous check.
9. `pincode_checks` and `pincode_availability_results` are unmodified by this phase — read-only legacy
   sources, still queryable for history where applicable.
10. The recurring scheduler (decision #8) runs at least once end-to-end against real enrolled data in a
    supervised, approved production check before the workstream is considered P0-complete (see
    `IMPLEMENTATION_PLAN.md` §Rollout).

---

## 13. Explicitly not in this document

- The exact schema (columns/types/constraints/indexes) — see `PINCODE_UNIFIED_PAGE_DATA_MODEL.md`.
- The scheduler's internal mechanics, phasing detail, test plan, and rollout/rollback plan — see
  `PINCODE_UNIFIED_PAGE_IMPLEMENTATION_PLAN.md`.
- Any actual code or migration — none was written in this round.
