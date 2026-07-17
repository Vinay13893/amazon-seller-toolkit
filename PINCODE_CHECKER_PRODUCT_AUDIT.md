# Pincode Checker — Product Audit

**Scope:** Static code audit only. No code changed, no migrations run, no production Supabase or Render
queries executed. All findings are traced to file paths and line numbers in the repo at
`C:\Vinay\amazon-seller-toolkit-pincode-cleanup` (worktree `audit/pincode-checker-product-cleanup`,
base commit `43c457e`) as of this session. `review-requests` code was not read or touched, per instructions.

**Note on repo layout:** the Next.js app root is `esolz-app/`, not the repo root — all `src/...` paths below
are relative to `esolz-app/`. The checker worker root is `checker-worker/`.

**Files read for this audit:**
`esolz-app/src/app/(dashboard)/dashboard/pincode-checker/page.tsx`,
`esolz-app/src/app/(dashboard)/dashboard/pincode/{page,layout}.tsx`,
`esolz-app/src/app/api/scraping/pincode-availability/jobs/{route,[jobId]/route,[jobId]/run/route,[jobId]/export/route}.ts`,
`esolz-app/src/app/api/asins/[asin]/pincode/route.ts`,
`esolz-app/src/app/(dashboard)/dashboard/asins/[asin]/page.tsx` (pincode widget section only),
`esolz-app/src/lib/integrations/amazon-pincode-adapter.ts`,
`esolz-app/src/lib/mock-pincode.ts`,
`esolz-app/src/lib/checkers/checker-worker-client.ts`,
`esolz-app/src/lib/checker-errors.ts`,
`esolz-app/src/lib/alerts/generate-alerts.ts`,
`esolz-app/src/lib/reports/generate-report-data.ts`,
`esolz-app/src/lib/internal/brahmastra-data-health.ts`,
`esolz-app/src/lib/supabase/usage.ts`, `esolz-app/src/app/api/usage/init/route.ts`,
`esolz-app/src/app/(dashboard)/dashboard/page.tsx`, `esolz-app/src/app/(dashboard)/dashboard/billing/page.tsx`,
`esolz-app/src/components/layout/{Sidebar,TopBar}.tsx`, `esolz-app/src/components/dashboard/DataFreshnessBadge.tsx`,
`esolz-app/src/components/asins/{AsinDashboardTable,ProductCard}.tsx`,
`esolz-app/supabase/migrations/{001_initial_schema,016_scraping_jobs_foundation}.sql`,
`checker-worker/src/checkers/pincodeAvailability.ts`, `checker-worker/src/scraping/queue.ts`,
`checker-worker/src/utils/{amazon,browser}.ts`, `checker-worker/src/server.ts`,
`scripts/check_pincode.py` (not opened in full — referenced only via the adapter and error-pattern matching),
`BRAHMASTRA_MASTER_TRACKER.md` §10, git log (`b0a1c5b`, `c9ce4b3` — the Buy Box status-masking fix cited as
precedent in the audit brief).

---

## 0. Headline finding

There are **two separate, non-communicating pincode-checking systems** live in this product at once, and the
one a seller is most likely to actually use — the single-pincode checker embedded in the ASIN detail page —
has the exact "error/rate-limit displayed as a negative truth" bug that was already found and fixed for Buy
Box (`b0a1c5b`). See §4 for the confirmed bug and §2/§3 for the two-systems finding.

---

## 1. Seller-facing purpose and workflow

There are **three** distinct pincode-related surfaces reachable in the product, not one:

1. **`/dashboard/pincode-checker`** — the live, nav-linked "Pincode Checker" (sidebar badge "Queue",
   `src/components/layout/Sidebar.tsx:30`). Workflow: paste up to 10 ASINs and up to 20 pincodes into two
   textareas → click "Start check" → a queued job is created and a worker trigger is fired → poll "Refresh
   status" until `status: done` → view a flat results table (one row per ASIN×pincode) → optionally export CSV
   or clear the job. CONFIRMED (`pincode-checker/page.tsx:114-490`).
2. **`/dashboard/pincode`** — a second, older, more elaborate page (per-ASIN city breakdown, KPI cards, buy
   box seller, fulfillment type, freshness badges). **This page is unreachable.** Its `layout.tsx` unconditionally
   redirects to `/dashboard/pincode-checker` before the page component ever renders:
   ```
   // src/app/(dashboard)/dashboard/pincode/layout.tsx
   export default function LegacyPincodeLayout() {
     redirect('/dashboard/pincode-checker')
   }
   ```
   CONFIRMED dead code — in Next.js App Router, a `redirect()` thrown from a layout fires before its child
   page is rendered, for every route under that layout. The function is even named `LegacyPincodeLayout`,
   which reads as an intentional deprecation, not an accident. All 649 lines of `pincode/page.tsx` (city
   presets, `PINCODE_CHECKS_PAUSED` gate, KPI cards, city-wise breakdown) are dead code.
3. **The ASIN detail page's inline "Pincode Availability" widget** (`asins/[asin]/page.tsx:1091-1229`) — a
   third, independent single-pincode checker: enter one pincode, click "Check", see the latest result plus a
   history table for that ASIN. This is **not** gated by the `PINCODE_CHECKS_PAUSED` flag (that flag only
   exists inside the dead page, §2) and **is** live and reachable today. CONFIRMED.

A seller has no way to know, from the UI, that #1 and #3 are unrelated tools writing to different tables (§2).
Nothing on either page links to or mentions the other.

## 2. Full inventory of pages/components/routes

**Bulk queue system (live, nav-linked):**
- `src/app/(dashboard)/dashboard/pincode-checker/page.tsx` — UI
- `src/app/api/scraping/pincode-availability/jobs/route.ts` — POST create job
- `src/app/api/scraping/pincode-availability/jobs/[jobId]/route.ts` — GET status+results, DELETE clear
- `src/app/api/scraping/pincode-availability/jobs/[jobId]/run/route.ts` — POST trigger worker
- `src/app/api/scraping/pincode-availability/jobs/[jobId]/export/route.ts` — GET CSV
- `checker-worker/src/scraping/queue.ts` (`runNextScrapingJob`) — worker-side job processor
- `checker-worker/src/checkers/pincodeAvailability.ts` (`runPincodeAvailabilityCheck`) — Playwright checker
- DB: `scraping_jobs` (job_type `PINCODE_AVAILABILITY_CHECK`) + `pincode_availability_results`
  (`supabase/migrations/016_scraping_jobs_foundation.sql:1-42`)

**Legacy per-ASIN system (dead page + live widget, sharing one table):**
- `src/app/(dashboard)/dashboard/pincode/page.tsx` — UI, **unreachable** (§1)
- `src/app/(dashboard)/dashboard/pincode/layout.tsx` — the redirect that kills it
- `src/app/(dashboard)/dashboard/asins/[asin]/page.tsx:328-604,1091-1229` — the live single-check widget
- `src/app/api/asins/[asin]/pincode/route.ts` — POST single check, shared by both of the above
- `src/lib/integrations/amazon-pincode-adapter.ts` — dev-only local Python fallback (§3)
- `scripts/check_pincode.py` — the Python/Playwright script the adapter spawns (dev only)
- `src/lib/mock-pincode.ts` — city presets (used by live dead-page code) + unused mock dataset (§8)
- DB: `pincode_checks` (`supabase/migrations/001_initial_schema.sql:168-182`)

**Shared plumbing (both systems, but each calls a different worker endpoint):**
- `src/lib/checkers/checker-worker-client.ts` (`runPincodeCheck` → worker `POST /pincode-availability`,
  used only by the single-check route) and `checker-worker/src/scraping/queue.ts` (worker `POST
  /scraping/run-next`, used only by the bulk job route) both ultimately call the same
  `runPincodeAvailabilityCheck()` in `checker-worker/src/checkers/pincodeAvailability.ts`, but through two
  different HTTP entry points with two different response-shaping layers on top. CONFIRMED.
- `src/lib/checker-errors.ts` — shared error-sanitization patterns, referenced by both systems' worker calls.

**Consumers that read only the legacy `pincode_checks` table (i.e., never see bulk-checker data — see §2a):**
- `src/lib/alerts/generate-alerts.ts:242-330` (pincode alerts — currently fully disabled, §7)
- `src/lib/reports/generate-report-data.ts:210-270` (`pincode-availability` report type)
- `src/lib/internal/brahmastra-data-health.ts:518-722` (Sync Health "Pincode Availability" source)
- `src/app/(dashboard)/dashboard/page.tsx:80-146,241-272,328-375` (dashboard KPI, action-plan item, recent
  activity)
- `src/app/(dashboard)/dashboard/billing/page.tsx:510-516` (usage bar, always reads `usage_counters`, not
  `pincode_checks` directly, but the counter is never incremented by either system — §8)

### 2a. The two systems don't talk to each other — this is the structural finding

CONFIRMED, traced end to end: the bulk "Pincode Checker" (the page in the sidebar) writes results to
`pincode_availability_results`, scoped to a `job_id`. Every other pincode-aware surface in the product —
the dashboard home KPI card, the "low pincode availability" action-plan item, the recent-activity feed, the
pincode alerts generator, the pincode report export, and the internal Sync Health monitor — reads from
`pincode_checks` instead, which is only populated by the ASIN-detail single-check widget (§1, item 3).

**Practical consequence:** a seller who runs a 10-ASIN × 20-pincode bulk job via the main "Pincode Checker"
nav item gets zero contribution to their dashboard KPIs, zero alerts, zero report data, and zero Sync Health
credit from that work — those systems have no query against `pincode_availability_results` anywhere in the
codebase (confirmed via repo-wide search: `pincode_availability_results` appears only in the four bulk-system
files listed above and nowhere else in `src/`). The only place bulk-job results are visible again is the job's
own results table/CSV export while that job/browser session is still around.

## 3. Data source per displayed field

### Bulk Pincode Checker (`pincode-checker/page.tsx`)

| UI field | Source | Notes |
|---|---|---|
| Status (available/unavailable/blocked/unknown) | `pincode_availability_results.availability_status`, computed by `toAvailabilityStatus()` (`checker-worker/src/scraping/queue.ts:118-124`) from the live Playwright checker's `status`/`available` | CONFIRMED live, correctly distinguishes error states (§4) |
| Delivery message | `pincode_availability_results.delivery_message`, cleaned client- and server-side by an identical `cleanDeliveryMessage()` duplicated in three files (`pincode-checker/page.tsx:95-112`, `jobs/[jobId]/route.ts:20-37`, `jobs/[jobId]/export/route.ts:32-49`) | CONFIRMED live; §9 flags the triplication |
| Price column | Boolean `price_detected` only — **no numeric price is ever stored or shown** by this system; the table has no `price` column (`016_scraping_jobs_foundation.sql:25-42`) | CONFIRMED. Matches the page's own copy ("price visibility"), not misleading, but a real capability gap vs. the page's implied breadth |
| Buy Box column | Boolean `buy_box_detected` = whether add-to-cart/buy-now DOM selectors were found (`checker-worker/src/checkers/pincodeAvailability.ts:326-333`), **not** whether the seller's own listing won the Buy Box | CONFIRMED. The label "Buy Box: Detected" is easy to misread as "you have the Buy Box"; it actually means "a buy box exists on this rendered page" |
| Seller name | Captured (`pincode_availability_results.seller_name`) and exported to CSV, but **not rendered anywhere in the on-screen table** (`pincode-checker/page.tsx:443-450` has no seller column) | CONFIRMED — data captured, UI gap |
| Checked timestamp | `result.checked_at`, raw `toLocaleString()` | CONFIRMED live; no staleness/freshness indicator on this page at all (contrast with §6) |
| Job progress %, Available/Unavailable/Unknown counts | `scraping_jobs.result_summary`, updated by the worker after every single check (`checker-worker/src/scraping/queue.ts:513-525`) | CONFIRMED live |

### ASIN-detail pincode widget (`asins/[asin]/page.tsx`)

| UI field | Source | Notes |
|---|---|---|
| Latest Check "✓ Available / ✗ Not Available" | `pincode_checks.available` rendered via `latestCheck.available ? '✓ Available' : '✗ Not Available'` (`asins/[asin]/page.tsx:1145-1147`) | CONFIRMED BUG — see §4 |
| Recent Checks table check/X icon | Same truthy check on `check.available` (`asins/[asin]/page.tsx:1192-1200`) | CONFIRMED BUG — see §4 |
| Delivery Options | `pincode_checks.delivery_promise`, parsed from raw Amazon DOM text via a hand-rolled splitter in the API route (`api/asins/[asin]/pincode/route.ts:190-215`) | CONFIRMED live |
| Fulfillment (FBA/FBM) | `pincode_checks.fulfillment_type`, derived as `result.amazon_fulfilled ? 'FBA' : 'FBM'` — but when the request went through the checker worker (`isWorkerConfigured()` branch), `amazon_fulfilled` is **hardcoded to `false`** (`api/asins/[asin]/pincode/route.ts:158`), so every worker-sourced check is labeled FBM regardless of the true fulfillment type | CONFIRMED BUG, see §5 |
| Seller | Regex-parsed from `merchant_text` ("Sold by X" / "Ships from X") (`route.ts:217-231`) | CONFIRMED live, best-effort text parsing |
| Price | `pincode_checks.price` column exists but the insert always sets it to `null` with the comment `// Not extracted by tool` (`route.ts:243`) | CONFIRMED — column present, never populated by the current write path |

### Mock data (`src/lib/mock-pincode.ts`)

`MOCK_PINCODE_RESULTS` (18 realistic-looking rows with prices, delivery days, Buy Box sellers) and
`checkAsinPincodeAvailability()` (an explicit `// TODO: Replace with real scraper call` stub,
`mock-pincode.ts:186-194`) are **not imported by any live or dead page** — grep confirms only
`mock-pincode.ts` itself references them. Only `CITY_PRESETS`, `parsePincodes()`, and `scoreToStatus()` from
this file are imported elsewhere, and only by the dead `pincode/page.tsx` (§1). CONFIRMED: the fake dataset
is inert, not wired into any reachable code path today — but it sits in the same file as code that other
pages do still import, which is a landmine for an accidental future import (§9/§12).

## 4. Availability status correctness — the confirmed error-masking bug

This is the same bug class already found and fixed for Buy Box in `b0a1c5b` ("Fix Buy Box status masking on
rate-limited Pricing checks") and `c9ce4b3`. **The bulk Pincode Checker does not have it; the ASIN-detail
widget does.**

**Bulk Pincode Checker — CONFIRMED CORRECT.** The worker's `runPincodeAvailabilityCheck()` returns four
distinct statuses (`'success' | 'unavailable' | 'blocked' | 'failed'`,
`checker-worker/src/checkers/pincodeAvailability.ts:26`), and `available` stays `null` on anything other than
a confirmed positive/negative read (e.g. `checker-worker/src/checkers/pincodeAvailability.ts:716-736` for
`'failed'`, `:518-529` and `:607-617` for `'blocked'`). `toAvailabilityStatus()`
(`checker-worker/src/scraping/queue.ts:118-124`) maps this to the four UI-visible states `available` /
`unavailable` / `blocked` / `unknown` without ever collapsing a `null` into `unavailable`. The bulk page's
`statusTone()`/`statusIcon()` (`pincode-checker/page.tsx:81-93`) render `blocked` in amber with a warning
icon and `unknown`/anything else in a neutral clock icon — a captcha block or timeout is visibly distinct
from a confirmed "unavailable" red X. This is a solid design, not just an accident: the CSV export and the
per-row "Reason" column also expose `error_code`/`error_message` for exactly this reason.

**ASIN-detail widget — CONFIRMED BUG.** `pincode_checks.available` is a nullable boolean, and the write path
correctly preserves `null` for uncertain outcomes — the API route's own comment says so:
```
// Preserve null from worker so uncertain checks are stored as failed/unknown, not unavailable.
// api/asins/[asin]/pincode/route.ts:153-154
is_buyable: workerRes.available,   // can be null
```
and on a hard failure (worker unreachable, exception thrown) it explicitly inserts `available: null` with a
`"Check failed: ..."` marker in `delivery_promise` (`route.ts:118-137`). **The UI then throws that
distinction away.** Both render sites use a plain JS truthy check on a `boolean | null`:
```
// asins/[asin]/page.tsx:1145-1147 (Latest Check summary)
<p className={cn('text-sm font-medium', latestCheck.available ? 'text-green-400' : 'text-red-400')}>
  {latestCheck.available ? '✓ Available' : '✗ Not Available'}
</p>

// asins/[asin]/page.tsx:1192-1200 (Recent Checks table)
{check.available ? (<Check .../>) : (<X .../>)}
```
`null` is falsy in JavaScript, so a worker outage, a timeout, or a captcha block on this widget renders
**exactly** the same red "✗ Not Available" / red X as a genuine confirmed-unavailable result. A seller
cannot tell "Amazon says this product can't be delivered here" from "our checker couldn't complete the
check" — the precise failure mode the Buy Box fix was written to eliminate. This is the single most
important finding in this audit (P0, §12).

**Same bug, same file, different surface — dashboard Recent Activity.** `src/app/(dashboard)/dashboard/page.tsx:368-375`:
```
description: `${e.pincode as string}: ${e.available ? 'Available ✓' : 'Not available'} — ${labelMap[...]}`,
severity: (e.available ? 'success' : 'warning') as Insight['severity'],
```
`e` comes straight from `pincode_checks` (`page.tsx:328-335`), same nullable `available` column, same
truthy-check bug — a failed check shows on the dashboard's Recent Activity feed as a warning-severity "Not
available" event, indistinguishable from a real availability problem. CONFIRMED.

**Contrast — the same file gets it right elsewhere.** `dashboard/page.tsx:241-262` (the "low pincode
availability" action-plan item) explicitly preserves the three-way split before computing a percentage:
```
list.push({ available: row.available === true ? true : (row.available === false ? false : null) })
...
const confirmed = rows.filter(r => r.available === true || r.available === false)
```
This proves the correct pattern was known and used in this exact file, just not applied consistently — the
Recent Activity feed 100 lines later regressed to the naive truthy check. CONFIRMED.

**Dead page — also gets it right (for what it's worth).** The unreachable `pincode/page.tsx:50-56` has
`isFailedCheck()` / `isAvailabilityUnknown()` helpers that correctly distinguish failed/unknown/available/
unavailable — but this page is never rendered (§1), so the correct logic that exists in the codebase is on
the one surface nobody can reach.

## 5. Price, delivery promise, and seller/Buy Box truth

- **Price**: never shown as a number on the bulk Pincode Checker (by design, boolean-only, §3). On the
  ASIN-detail widget, the `pincode_checks.price` column exists but is always `null` (§3) — no seller-visible
  price ever comes from this feature on either surface. CONFIRMED.
- **Delivery promise**: live-scraped text on both surfaces, best-effort DOM extraction, not guaranteed
  complete or accurate — this is inherent to Playwright/DOM scraping and not a code bug, INFERRED reasonable
  given the extraction approach in `checker-worker/src/checkers/pincodeAvailability.ts:247-289`.
- **Fulfillment type (FBA/FBM)**: CONFIRMED BUG on the ASIN-detail widget. When routed through the checker
  worker, `amazon_fulfilled` is hardcoded `false` before the FBA/FBM label is derived
  (`api/asins/[asin]/pincode/route.ts:158,234`), so every worker-backed check on this surface is mislabeled
  FBM even when the product is actually FBA. This is a silent wrong-value bug distinct from the null-masking
  bug in §4 — worth flagging separately because it's a *positive* false claim ("this is FBM") rather than an
  unknown-as-negative one. The bulk Pincode Checker doesn't have an FBA/FBM field at all, so it's unaffected.
- **Buy Box / seller**: bulk system stores a boolean "was a buy box detected on the page" (§3) — genuinely
  live signal about page rendering, not about whether the seller's own offer won it. ASIN-detail widget
  regex-parses "Sold by"/"Ships from" text into a seller name — live, best-effort, not cross-validated against
  the seller's own account.

## 6. Freshness and last-checked logic

- **Bulk Pincode Checker**: raw `new Date(result.checked_at).toLocaleString()`, no staleness classification,
  no "stale" warning regardless of age (`pincode-checker/page.tsx:477-479`). CONFIRMED — freshness is not
  surfaced at all on this page.
- **ASIN-detail widget**: uses the shared `DataFreshnessBadge` component
  (`src/components/dashboard/DataFreshnessBadge.tsx`), default `staleAfterHours = 24`
  (`asins/[asin]/page.tsx:1100`, `checkedAt={latestCheck?.checked_at ?? null}`). Straightforward age
  comparison against `Date.now()`, correctly falls back to "Never checked" on `null`/`NaN`. CONFIRMED
  correct, no bug found here.
- **Internal Sync Health** (`brahmastra-data-health.ts:112,518-521,710-722`) uses `PINCODE_STALE_AFTER_HOURS
  = 48` and explicitly queries `pincode_checks` filtered `.not('available', 'is', null)` for the "latest
  confirmed" timestamp — i.e. it correctly excludes failed/null checks from the freshness clock, unlike the
  buggy UI renders in §4. A code comment here (`:100-102`) notes keyword/pincode data was observed
  "200-950+ hours stale" in production at time of writing, which the comment explicitly frames as expected/
  real signal for an on-demand-only feature, not a bug. CONFIRMED (comment content), UNKNOWN whether that
  staleness has changed since.

## 7. Unknown vs unavailable vs error vs rate-limited

- **Bulk Pincode Checker**: four states correctly modeled end to end — `available` / `unavailable` /
  `blocked` / `unknown` — from checker to DB to UI to CSV (§4). CONFIRMED good.
- **ASIN-detail widget / dashboard**: effectively two states as far as the UI is concerned — `available` and
  "everything else," because `null` (unknown/failed) is rendered identically to `false` (confirmed
  unavailable) (§4). The DB and API layers correctly preserve three states; only the presentation layer
  collapses them. CONFIRMED bug, not a data-model gap.
- **Pincode alerts** (`generate-alerts.ts:242-330`) *do* correctly distinguish "checker failed for all
  checks" (a distinct "Pincode Checker Unavailable" alert, `:274-291`) from "genuinely low availability"
  (`:296-329`) — but this entire code path is dead at runtime: `PINCODE_ALERTS_PAUSED = true`
  (`generate-alerts.ts:27`), hardcoded, with the comment "Temporarily disabled during pincode reliability
  pause." CONFIRMED — correct logic, permanently switched off.

## 8. Fake, inferred, placeholder, or misleading values

1. **`pincode_checks_used` usage counter never increments.** CONFIRMED via repo-wide search: the field is
   read in `src/lib/supabase/usage.ts:140` (falls back to existing value or `0`) and
   `api/usage/init/route.ts:65` (seeds `0`), and displayed in `billing/page.tsx:513-516` ("Pincode checks
   this month") and the dead `pincode/page.tsx:479` ("Checks This Month"). **No code path anywhere in
   `src/` ever writes a non-zero value to it** — neither the bulk job route (`jobs/route.ts`) nor the
   single-check route (`api/asins/[asin]/pincode/route.ts`) touches `usage_counters`. The billing page will
   show "0 of 100 pincode checks used" forever regardless of actual usage. This looks like a real, tracked
   metric; it is decorative.
2. **`pincode_check_limit` is never enforced.** CONFIRMED — grep for the column finds it only in
   `billing/page.tsx` display code, never in a quota-check `if` anywhere in an API route. The bulk job route
   enforces its own fixed `MAX_ASINS=10 / MAX_PINCODES=20 / MAX_CHECKS=200` constants
   (`jobs/route.ts:8-10`), unrelated to the plan's `pincode_check_limit` value shown on the billing page.
3. **Unused mock dataset with realistic fake data sits in a file other pages import from.**
   `MOCK_PINCODE_RESULTS` (`mock-pincode.ts:56-96`) — 18 rows with specific prices (₹1299), specific sellers
   ("Daily Herbs Official", "NutriMart India"), specific delivery-day counts — is not imported anywhere live
   (§3), but `CITY_PRESETS` from the same file is imported by the (dead) `pincode/page.tsx`. If that page or
   its city-preset feature is ever revived, the adjacent mock data is one accidental import away from
   leaking into a real UI.
4. **Buy Box "Detected" label** (§3, §5) is a page-rendering signal, not a seller-outcome signal — easy to
   misread as "you have the Buy Box in this pincode," which it does not mean.
5. **FBA/FBM mislabeling** (§5) is a genuine wrong-value bug, not merely an unclear label — every
   worker-routed check on the ASIN-detail widget reports FBM even for FBA listings.

## 9. Broken controls and incomplete features

- **TODO left in production code path**: `jobs/[jobId]/route.ts:167` — `// TODO: replace manual clearing
  with scheduled retention for pincode results older than 7-30 days.` The only current cleanup mechanism is
  the user manually clicking "Clear current results"; there is no retention job. CONFIRMED, matches
  BRAHMASTRA_MASTER_TRACKER.md §10's "no scheduler" description for this pipeline generally.
- **`cleanDeliveryMessage()` is copy-pasted three times**, byte-for-byte identical logic, in
  `pincode-checker/page.tsx:95-112`, `jobs/[jobId]/route.ts:20-37`, and `jobs/[jobId]/export/route.ts:32-49`.
  Not broken, but a maintenance risk — a future fix to one copy is easy to forget in the other two.
- **Stuck/orphaned jobs on trigger failure**: if `/run` fails (worker not configured, or the 80s
  `AbortController` timeout in `jobs/[jobId]/run/route.ts:77-78` fires before the worker responds — plausible
  for a full 200-check job, since each check can take up to ~55s server-side,
  `checker-worker/src/checkers/pincodeAvailability.ts:63`), the UI shows a soft notice ("Worker trigger
  failed safely; refresh after the worker runs") but there is no retry button for that specific job and no
  automatic re-trigger — the user must trust that the worker kept running server-side after the HTTP call
  aborted (INFERRED likely true, since `runNextScrapingJob()`'s Supabase writes are not tied to the Express
  response object, but not verified against a live run) or start an entirely new job, leaving the old one
  `queued`/`running` forever with no sweep to reconcile it. No cron/scheduled process calls
  `/scraping/run-next` — confirmed via repo-wide search, the only callers are the two `/run` routes
  (pincode and buy-box), both manually triggered from their respective UI pages.
- **No plan-quota gate on job creation** (§8, item 2) — a technically "incomplete" feature relative to what
  the billing page implies exists.

## 10. Empty/loading/partial-error states

- **Bulk Pincode Checker**: empty state before any job is honest — "Results will appear after the worker
  processes the queued job." (`pincode-checker/page.tsx:433-437`). Error banner shows the raw `errorCode`/
  `message` from the API (`:388-392`) — functional, if a little raw/technical for an end user (e.g. would
  show `worker_trigger_not_configured` verbatim in some paths). CONFIRMED reasonably honest, no silent
  failures found on this page — every failure path sets `error` or `notice` state.
- **ASIN-detail widget**: "No pincode checks yet" / "Enter a pincode above to check availability"
  (`asins/[asin]/page.tsx:1223-1227`) — honest empty state. But per §4, a *failed* check does not land in an
  honest error state at all — it's misrepresented as a normal negative result, which is worse than a scary
  error state would be, because it doesn't look like an error.
- **Dead `pincode/page.tsx`**: has the most thorough honest-messaging design of the three (paused banner,
  "Checker unavailable" badge for `status === null`, "Not calculated" for empty confirmed-check sets) — but
  none of it is reachable (§1).

## 11. Mobile/desktop layout (code-level observation only, not visually verified)

All findings in this section are INFERRED from JSX/class inspection only — no browser was used to render
either page, per the audit's read-only static-analysis scope.

- **Bulk Pincode Checker table** (`pincode-checker/page.tsx:439-486`): wrapped in `overflow-x-auto`, which
  prevents page-level horizontal overflow, but all 8 columns (ASIN, Pincode, Status, Delivery, Price, Buy
  Box, Reason, Checked) render unconditionally at every breakpoint — no `hidden md:table-cell`-style
  responsive column hiding. INFERRED: on a narrow viewport this likely requires horizontal scrolling to see
  the later columns (Reason, Checked), which is functional but not optimized.
  - Contrast: the ASIN-detail widget's history table (`asins/[asin]/page.tsx:1177-1220`) *does* use
    responsive hiding (`hidden sm:table-cell`, `hidden md:table-cell`) — the two surfaces are inconsistent in
    how much mobile polish they received.
- **Bulk Pincode Checker form section** (`:281-341`): uses `grid gap-4 lg:grid-cols-[1.1fr_0.9fr]` for the
  two-column layout and `md:grid-cols-2` for the ASIN/pincode textareas, both of which collapse to a single
  column below their breakpoints. INFERRED reasonable stacking behavior on mobile.
- **KPI row** (`:367`): `grid-cols-2 sm:grid-cols-4` — INFERRED reasonable.
- No dedicated mobile layout, drawer, or card-based fallback exists for the results table on either page;
  both rely solely on `overflow-x-auto` plus (on the ASIN-detail page only) column hiding.

## 12. Recommended P0/P1/P2 cleanup

**P0 — actively misleading, should block trusting this feature (2 items)**

1. **Fix the availability null-masking bug on the ASIN-detail pincode widget and the dashboard Recent
   Activity feed** (§4). `latestCheck.available ? ... : ...` and `check.available ? ... : ...` in
   `asins/[asin]/page.tsx:1145-1147,1192-1200`, and `e.available ? ... : ...` in `dashboard/page.tsx:372,374`,
   must distinguish `available === false` (genuine unavailable) from `available === null` (failed/rate-limited/
   worker-unavailable check) — the same fix pattern already applied for Buy Box in `b0a1c5b`. This is the
   only reachable surface where a seller sees a false negative presented as a confirmed fact.
2. **Fix the hardcoded `amazon_fulfilled: false` for worker-routed single checks** (§5,
   `api/asins/[asin]/pincode/route.ts:158`) — every FBA product checked through this path is currently
   mislabeled FBM, a positive wrong-value claim, not just an ambiguous one.

**P1 — should fix soon, not urgent (5 items)**

3. **Decide the fate of the dead `/dashboard/pincode` page and its parallel `pincode_checks` data model**
   (§1, §2a). Either restore it as the "real" dashboard-integrated pincode UI (it has better freshness/error
   handling than the bulk page in several respects, §10) or delete it and consolidate all consumers
   (alerts, reports, Sync Health, dashboard KPIs) onto `pincode_availability_results`, or vice versa. Today
   the product silently maintains two parallel, disconnected data models and nobody using the nav-linked
   "Pincode Checker" gets any downstream benefit (alerts/reports/KPIs) from their own checks.
4. **Wire up or remove the usage counter and quota** (§8, items 1-2) — `pincode_checks_used` is currently
   theater; either increment it from both write paths and enforce `pincode_check_limit`, or remove the
   billing-page line so it stops implying a tracked, enforced limit that doesn't exist.
5. **Re-enable or explicitly retire pincode alerts** (`PINCODE_ALERTS_PAUSED = true`,
   `generate-alerts.ts:27`) — the underlying logic is correct and already distinguishes failure from
   confirmed low-availability (§7); it's just switched off, silently, with no UI indication that alerts for
   this module don't exist.
6. **Address the 80s trigger-timeout vs. up-to-200×55s worst-case job duration mismatch** (§9) — either
   surface an explicit "this may take a while, keep refreshing" expectation-setting message for large jobs, or
   add a way to re-trigger/resume a stuck `queued`/`running` job without starting a brand-new one.
7. **De-duplicate `cleanDeliveryMessage()`** (§9) into a shared lib function — three independent copies is a
   drift risk.

**P2 — nice-to-have polish (4 items)**

8. Surface `seller_name` in the bulk Pincode Checker's on-screen table, not just the CSV export (§3).
9. Make the bulk checker's "Buy Box: Detected/Not detected" and "Price: Detected/Not detected" columns
   status-aware — show "—"/"N/A" instead of "Not detected" when `availability_status` is `blocked` or
   `unknown`, so a captcha block doesn't visually read the same as "no buy box on this listing" (§4, minor
   version of the same pattern found in the P0 item, but this surface already shows the status column
   alongside it, so the risk is lower).
10. Delete or clearly quarantine `MOCK_PINCODE_RESULTS` / `checkAsinPincodeAvailability()` in
    `mock-pincode.ts` (§8, item 3) — split the file so the still-used `CITY_PRESETS`/`parsePincodes`/
    `scoreToStatus` utilities aren't sitting next to inert fake data with real-looking prices and seller names.
11. Add a staleness indicator to the bulk Pincode Checker's results table (§6) — it has none today, unlike
    the ASIN-detail widget and Sync Health, which both track staleness for the same underlying kind of data.
12. Add responsive column hiding to the bulk Pincode Checker's results table to match the ASIN-detail
    widget's approach (§11).

---

**Totals: 2 P0, 5 P1, 4 P2.**
