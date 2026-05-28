# Sociomonkey — Amazon Seller Intelligence Platform
## Complete Project Brief for AI Assistance

---

## PRODUCT OVERVIEW

**Product name:** Sociomonkey
**Subline:** Amazon Intelligence
**What it does:** Amazon Seller Intelligence SaaS — lets sellers track BSR (Best Seller Rank), monitor Buy Box ownership, check product availability by pincode, track and research keyword rankings, all from one dashboard.
**Target market:** Amazon India sellers (small-to-mid size), managing 1–20 ASINs on amazon.in
**Monetisation:** Subscription SaaS, tiered plans priced in INR (Free / Starter / Growth / Pro / Agency). Payment gateway: **Razorpay** ✅ built May 2026. Self-serve upgrade flow: order creation → Razorpay modal → HMAC signature verify → subscription update.

---

## TECH STACK

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router (Turbopack), TypeScript |
| Styling | Tailwind CSS, shadcn/ui components |
| Auth + DB | Supabase — email/password auth, PostgreSQL, RLS, SSR cookies via `@supabase/ssr` |
| Scraping | Playwright + Requests (Python 3.14), spawned as child process from Next.js API routes, 90s timeout |
| Python binary | `C:\Python314\python.exe` via `BSR_PYTHON_BIN` env var |
| Charts | recharts |
| Toasts | sonner |
| Theme | next-themes (day/night) |
| Icons | lucide-react |
| Middleware | Custom `src/proxy.ts` (NOT standard `middleware.ts`) — handles Supabase session refresh + auth guard on `/dashboard/*` |
| Dev server | http://localhost:3000 |
| Deployment target | Render (`render.yaml` present) |

---

## DATABASE ARCHITECTURE (Supabase PostgreSQL)

### Tables

| Table | Key Fields | Notes |
|---|---|---|
| `profiles` | `id` (= auth.users.id), `full_name`, `company_name`, `email` | Created by DB trigger on signup |
| `workspaces` | `id`, `name`, `type` (seller/agency/brand) | Created by DB trigger on signup |
| `workspace_members` | `workspace_id`, `user_id`, `role` (owner/admin/member) | Join table |
| `subscription_plans` | `id`, `name`, `price_monthly`, `asin_limit`, `keyword_limit`, `pincode_check_limit`, `competitor_limit`, `report_limit`, `features` (JSONB) | Seeded rows: Free/Starter/Growth/Pro/Agency |
| `workspace_subscriptions` | `workspace_id`, `plan_id` (FK → subscription_plans), `status`, `current_period_start`, `current_period_end` | One row per workspace |
| `tracked_asins` | `id`, `workspace_id`, `asin`, `product_title`, `marketplace`, `status` (active/archived) | Manual add by user |
| `asin_snapshots` | `tracked_asin_id`, `asin`, `bsr_rank`, `bsr_category`, `price`, `rating`, `review_count`, `availability_score`, `buybox_is_self`, `buybox_seller_name`, `checked_at` | Inserted on each manual refresh |
| `pincode_snapshots` | `tracked_asin_id`, `pincode`, `available`, `delivery_date`, `checked_at` | Inserted on each pincode check |
| `buybox_snapshots` | `id`, `workspace_id`, `tracked_asin_id`, `buy_box_owner`, `buy_box_status` ('won'\|'lost'\|'suppressed'\|'unknown'), `buy_box_price`, `your_price`, `price_gap`, `fulfillment_type`, `checked_at` | Inserted on each buy box check |
| `tracked_keywords` | `id`, `workspace_id`, `tracked_asin_id`, `keyword`, `marketplace` | Upserted on keyword track |
| `keyword_rank_snapshots` | `tracked_asin_id`, `keyword`, `organic_rank`, `sponsored_rank`, `page_status`, `scan_status`, `checked_at` | Inserted by Python rank checker |
| `usage_counters` | `workspace_id`, `period_start`, `period_end`, `asin_count`, `keyword_count`, `pincode_checks_used`, `reports_generated`, `competitor_count` | Upserted after each resource add |
| `alerts` | `id`, `workspace_id`, `module` ('bsr'\|'buybox'\|'pincode'\|'keywords'), `rule`, `asin`, `title`, `description`, `severity` ('critical'\|'warning'\|'opportunity'\|'info'), `status` ('open'\|'read'\|'resolved'), `created_at` | Written by `POST /api/alerts/generate`; read by `/dashboard/alerts` and `/dashboard/buybox` |
| `reports` | `id`, `workspace_id`, `report_type`, `file_name`, `row_count`, `created_at` | Written by `POST /api/reports/generate` |

### RLS Architecture
- **All 22 tables have RLS enabled** (verified live in Supabase dashboard — migration `004_lock_legacy_tables.sql` applied)
- Production tables (15) use policy: `workspace_id IN (SELECT public.user_workspace_ids())`
- `user_workspace_ids()` is a `SECURITY DEFINER` function querying `workspace_members WHERE user_id = auth.uid()`
- Legacy tables (7) are locked with RLS enabled and **zero policies** = full lockdown via REST API. Service-role client still has access.
  - Locked legacy tables: `seller_credentials`, `users`, `asins`, `bsr_history`, `job_logs`, `keyword_ranks`, `tool_usage`
  - These are safe to `DROP` once confirmed no external scripts reference them
- Two Supabase client types:
  - `createClient()` → SSR client reading session from cookies (used in pages and most API routes for auth checks)
  - `createAdminClient()` → service-role client bypassing RLS (used in API routes for INSERT/UPDATE)

---

## WHAT IS FULLY BUILT AND WORKING (real data, end-to-end)
> **Beta Sprint completed May 2026** — all mock dashboard pages are now connected to real Supabase data.
> **Hardening Sprint completed May 2026** — ASIN detail page fully migrated to real data (buybox timeline, alerts, BSR/price charts). Error boundary added. Zero mock function calls remain in any dashboard page.

### Auth Flow
- **Signup** (`/signup`): email + password + full_name + company_name → `supabase.auth.signUp()`. Email confirmation required. After call, redirects to `/signup/check-email?email=<encoded>` ✅
- **Check Email page** (`/signup/check-email`): shows "Check your email" confirmation with the email address from the `?email=` query param. Has "Already confirmed? Sign in" link ✅
- **Login** (`/login`): email/password. Redirect param validated (must start with `/`). Redirects to `/dashboard/asins`.
- **Logout:** Works from TopBar dropdown and Settings page. `signOut()` + router redirect.
- **Auth callback** (`/auth/callback`): exchanges `?code=` for session (email confirm, password reset, magic link). Has open-redirect protection.
- **Session refresh:** `proxy.ts` runs on all non-static routes — refreshes Supabase session cookie and redirects unauthenticated users to `/login?redirect=<path>`. Also bounces logged-in users away from `/login` and `/signup`.
- **Password reset:** Settings page sends `resetPasswordForEmail()` with redirect back to `/dashboard/settings`.

### Settings Page (`/dashboard/settings`)
- Loads `profiles` + `workspaces` (via `workspace_members` join) on mount.
- **Save Profile** → updates `profiles.full_name` and `profiles.company_name` ✅
- **Save Workspace** → updates `workspaces.name` and `workspaces.type` ✅ (only owner/admin)
- **Change Password** → sends reset email ✅
- **Logout** → works ✅
- **Theme toggle** → `next-themes`, persists in localStorage ✅
- ❌ NOT CONNECTED (local state only, has in-UI disclaimer): notification prefs, default marketplace, default pincodes

### Dashboard Overview (`/dashboard`)
- Real data: keyword count, BSR refresh count, buy box won/lost/suppressed, activity feed, recent alerts
- Queries: `tracked_asins`, `asin_snapshots`, `tracked_keywords`, `buybox_snapshots`, `alerts`
- Loading states ✅, empty states ✅

### BSR Tracker (`/dashboard/bsr`)
- Real data: tracked ASINs list with latest BSR rank, BSR history chart per ASIN (last 30 days from `asin_snapshots`)
- Source: `getTrackedAsins()` + `asin_snapshots` time-series query
- No mock data ✅

### Pincode Checker (`/dashboard/pincode`)
- Real data: latest pincode check results per ASIN from `pincode_snapshots`
- No "Demo mode" label; real DB reads ✅

### Alerts Center (`/dashboard/alerts`)
- Real data from `alerts` table
- **Generate Alerts** button → `POST /api/alerts/generate` — evaluates 4 rules: BSR spike, buybox lost, pincode unavailable, keyword rank drop
- Mark as Read / Resolve buttons persist to DB ✅
- Deduplication: won't insert duplicate alerts within 24h for same workspace+rule+asin ✅

### Reports (`/dashboard/reports`)
- Real data: recent reports from `reports` table; Generate buttons call `POST /api/reports/generate`
- 6 report types: BSR Summary, Keyword Performance, Pincode Availability, Buy Box Status, Full ASIN Report, Monthly Trend
- CSV generation with RFC 4180 escaping → browser download ✅
- Increments `usage_counters.reports_generated` on each generate ✅

### Buy Box Monitor (`/dashboard/buybox`)
- Real data from `buybox_snapshots` + `tracked_asins`
- KPI cards: total tracked, won, lost, suppressed, competitor sellers, win rate — all from DB
- Status table: latest snapshot per ASIN ✅
- History chart (last 7 days): `buybox_snapshots` time-series grouped by day ✅
- Competitor sellers panel: aggregated from lost snapshots by `buy_box_owner` ✅
- Alerts panel: `alerts` table filtered by `module='buybox'` ✅
- Check Buy Box form: dropdown of tracked ASINs → calls real `POST /api/asins/[asin]/buybox` ✅
- No mock data ✅

### ASIN Management (`/dashboard/asins`)
- Lists all tracked ASINs from `tracked_asins` with latest snapshot joined
- **Add ASIN** → inserts into `tracked_asins`, increments `usage_counters.asin_count` ✅
- **Delete ASIN** → sets `status = 'archived'` ✅
- **ASIN limit enforcement** → reads from `subscription_plans.asin_limit`. Disables Add button at limit, shows progress bar ✅
- **Summary KPI cards** → avg BSR, buy box won count, avg rating, avg availability — from real DB data ✅
- Table view + card view toggle ✅

### ASIN Detail Page (`/dashboard/asins/[asin]`)
Most feature-rich real-data page. Loads `getAsinDetail()` joining `asin_snapshots`, `pincode_snapshots`, `buybox_snapshots`.

**BSR section:**
- Latest BSR rank + delta vs previous snapshot ✅
- Chart (7/14/30 day toggle) — real time-series from `asin_snapshots` (all snapshots, sliced by selected range). Shows empty-state placeholder if no snapshots yet. ✅
- **Refresh BSR button** → `POST /api/asins/[asin]/refresh` → Python scraper → inserts row into `asin_snapshots` ✅

**Pincode Availability section:**
- Latest results from `pincode_snapshots` ✅
- **Check Pincode button** → `POST /api/asins/[asin]/pincode` → Playwright Python → inserts row into `pincode_snapshots` ✅
- 6-digit validation for India

**Buy Box section:**
- Latest status from `buybox_snapshots` ✅
- **7-day Buy Box timeline** (sidebar) — real `buybox_snapshots` rows mapped to winner/is_self shape. Shows empty-state if no checks yet. ✅
- **Recent Alerts** (sidebar) — real `alerts` table filtered by `tracked_asin_id` + workspace, non-resolved only. ✅
- **Check Buy Box button** → `POST /api/asins/[asin]/buybox` → Python → inserts row into `buybox_snapshots` ✅
- `?mock=1` dev shortcut skips Python

**Keyword Rankings section (on ASIN detail page):**
- Loads tracked keywords for this ASIN from `tracked_keywords` JOIN `keyword_rank_snapshots`
- **Track Keyword input** → `POST /api/asins/[asin]/keywords/track` → upserts `tracked_keywords`, increments `keyword_count` ✅
- **Refresh Ranks button** → `POST /api/asins/[asin]/keywords/refresh` → Python rank checker → inserts `keyword_rank_snapshots` ✅
- Table shows: keyword, rank, page status badge (Page 1 / Page 2 / Page 3 / Not Ranking), "Checked X ago"
- "Never checked" shown distinctly from "Not ranking" ✅

### Keyword Research Page (`/dashboard/keywords`)
- **Research tab**: input keyword → `POST /api/keywords/research` → Amazon autocomplete → returns suggestions ✅
- Results shown with intent badge (generic/long-tail/competitor/problem-based) — intent is computed heuristically, not from Amazon
- **Track button on results** → `POST /api/keywords/track` (workspace-level) → upserts `tracked_keywords` ✅
- **Tracked keywords tab**: lists all workspace-level tracked keywords with last rank, page status, and refresh
- **Refresh All** → `POST /api/keywords/refresh` → Python rank check for all tracked keywords ✅
- Search volume, CPC, competition score: all `null` — Amazon doesn't expose this; shown as "—"

### Billing Page (`/dashboard/billing`)
- Loads real plan from `workspace_subscriptions JOIN subscription_plans` ✅
- Loads all plans from `subscription_plans` for comparison table ✅
- Loads usage from `usage_counters` via `getOrCreateCurrentUsageCounter()` ✅
- `UsageBar` for each resource (ASINs, keywords, pincode checks, reports, competitors) — warning at 80%, critical at 95% ✅
- **Upgrade buttons**: live Razorpay checkout — `POST /api/billing/create-order` → Razorpay modal → `POST /api/billing/verify-payment` → subscription updated ✅
- Free plan and Agency plan cannot be self-served (blocked server-side) ✅
- Requires env vars: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (see `.env.local.example`)

### Sidebar Plan Card
- Shows current plan name + ASIN count from live DB query ✅
- Graceful loading state ✅

### Error Boundary (`src/app/(dashboard)/error.tsx`)
- Catches any unhandled render/fetch error in the entire `(dashboard)` layout group ✅
- Shows a user-friendly message with optional Error ID (Render digest) and a **Try again** button that calls Next.js `reset()` ✅

### Day/Night Mode
- `next-themes` ThemeProvider in root layout ✅
- Toggle in TopBar ✅
- Toggle in Settings page ✅
- `suppressHydrationWarning` set ✅

---

## API ROUTES (all under `/src/app/api`)

All routes have:
- `export const runtime = 'nodejs'`
- `export const maxDuration = 120`
- Auth check via `supabase.auth.getUser()` at start
- Admin client for DB writes (bypasses RLS)
- Debug logging at every step

| Route | Method | What it does |
|---|---|---|
| `/api/asins/[asin]/refresh` | POST | Python scraper → `asin_snapshots` |
| `/api/asins/[asin]/pincode` | POST | Playwright check → `pincode_snapshots` |
| `/api/asins/[asin]/buybox` | POST | Python check → `buybox_snapshots`. Accepts `?mock=1` in dev to skip scraper. |
| `/api/asins/[asin]/keywords/track` | POST | Upsert `tracked_keywords` for ASIN + increment `keyword_count` |
| `/api/asins/[asin]/keywords/refresh` | POST | Python rank check → `keyword_rank_snapshots` for this ASIN |
| `/api/keywords/research` | POST | Amazon autocomplete API → suggestions |
| `/api/keywords/track` | POST | Upsert `tracked_keywords` at workspace level |
| `/api/keywords/refresh` | POST | Python rank check for all workspace keywords |
| `/api/usage/init` | POST | Upsert `usage_counters` row (accepts both `workspace_id` and `workspaceId`) |
| `/api/alerts/generate` | POST | Evaluates 4 alert rules across all workspace ASINs → inserts into `alerts` table (with 24h dedup). Returns `{ created: N }` |
| `/api/reports/generate` | POST | Body: `{ type: ReportType }`. Generates CSV from DB data, saves to `reports` table, increments `usage_counters.reports_generated`, streams CSV download |
| `/api/billing/create-order` | POST | Body: `{ plan_id }`. Validates role (owner/admin), fetches price server-side, creates Razorpay order. Returns `{ order_id, amount, currency, key_id, plan_name }` |
| `/api/billing/verify-payment` | POST | Body: `{ razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id }`. HMAC-SHA256 signature verification → upserts `workspace_subscriptions`. Returns `{ success: true }` |

---

## PYTHON SCRAPING LAYER

Scripts in `esolz-app/scripts/` and project root:

| Script | Purpose | Status |
|---|---|---|
| `rank_check_adapter.py` | Keyword rank checker. Args: `--keyword`, `--asin`, `--marketplace`, `--pages`. Returns JSON: `{ organic_rank, page_status, scan_status }` | Tested, working |
| `bsr_requests_test.py` | BSR + price scraper using requests | Working |
| `amazon_bsr_tracker.py` | Original BSR tracker | Working |
| `bsr_stealth.py` | Playwright-based stealth scraper with fingerprint randomisation | Available |

- Python binary: `C:\Python314\python.exe` (env var `BSR_PYTHON_BIN`)
- All spawns have 90s timeout
- Output parsed from stdout JSON

---

## REMAINING MOCK / PLACEHOLDER PAGES

Only one dashboard section remains on mock data:

| Page | Route | Mock source | Notes |
|---|---|---|---|
| Competitors | `/dashboard/competitors` | `MOCK_COMPETITOR_ASINS`, `MOCK_BUYBOX_THREATS`, `MOCK_KEYWORD_OVERLAP` | No competitor tracking in DB yet — deferred post-MVP |

All other dashboard pages are connected to real Supabase data as of May 2026.

---

## BUGS FIXED IN RECENT SESSIONS

1. **`tracked_keywords.ignoreDuplicates: false`** → changed to `true` (was crashing on duplicate keyword track)
2. **`tracked_asin_id = null`** — keyword track route was silently saving with null `tracked_asin_id` if ASIN wasn't found → fixed to return hard 404
3. **Missing `keyword_count` increment** → added increment in both keyword track routes
4. **`usage/init` body field mismatch** → route expected `workspaceId` (camelCase) but `usage.ts` sends `workspace_id` (snake_case) → fixed to accept both
5. **No debug logging in keyword routes** → added step-by-step numbered logging in all 4 keyword routes
6. **Ambiguous "—" in rank table** → "Never checked" and "Not ranking" now shown with distinct badges and "Checked X ago" text
7. **[SECURITY] 7 legacy tables had RLS disabled** → applied `supabase/migrations/004_lock_legacy_tables.sql` live. `seller_credentials` and `users` (PII) were publicly readable via API keys. All 22 tables now confirmed RLS ENABLED.
8. **[SECURITY] API routes leaked internals** — 17 occurrences of `debug: { authErr }`, `debug: { user.id }`, `debug: { memberErr }`, `detail: String(err)` in JSON error responses → stripped from all 9 API routes. Routes fixed: keywords/track, keywords/refresh, keywords/research, asins/[asin]/refresh, asins/[asin]/pincode, asins/[asin]/keywords/refresh, asins/[asin]/keywords/track
9. **[SECURITY] Signup redirected before email confirmed** → now redirects to `/signup/check-email?email=...` with proper confirmation page. User no longer lands on blank dashboard with no session.
10. **[SECURITY] `.env.local.example` had `NEXT_PUBLIC_DEV_AUTH_BYPASS=true`** → changed to `false` so it is not accidentally copied to production.
11. **ASIN detail page mock data** → `generateBsrHistory`, `generatePriceHistory`, `generateBuyBoxHistory`, `getMockAlerts` all removed. BSR/price charts use real `asin_snapshots` (empty-state if no data). Buy Box 7-day timeline uses real `buybox_snapshots`. Recent Alerts uses real `alerts` table filtered by `tracked_asin_id`. Bug caught: original code was querying `.eq('asin', textString)` on alerts table — fixed to `.eq('tracked_asin_id', detail.id)` (UUID) matching the actual DB schema.
12. **Error boundary added** → `src/app/(dashboard)/error.tsx` created. Catches all dashboard-level render errors with graceful UI + reset button.
13. **Onboarding trigger hardened** → `supabase/migrations/005_verify_and_harden_onboarding_trigger.sql` written and **applied to production Supabase (27 May 2026)**. Adds ON CONFLICT guards, exception handlers, RAISE WARNING for missing Free plan, backfills all 4 onboarding rows for existing users. ✅
14. **`timeAgo` epoch-zero bug** → Keywords page showed "~20600d ago" for keywords never rank-checked. Cause: `new Date(0).toISOString()` (Unix epoch) used as fallback instead of `null`. Fixed in `keywords/page.tsx` (fallback → `null`), `mock-keywords.ts` (type `string | null`), and added `null` guard to inline `timeAgo` in `dashboard/page.tsx` and `InsightFeed.tsx`. Never-checked keywords now display `—`.
15. **Razorpay billing MVP** → `POST /api/billing/create-order` and `POST /api/billing/verify-payment` created. Billing page upgrade buttons wired to Razorpay checkout.js modal. Plan price always fetched server-side. HMAC-SHA256 signature verified before subscription update. Free and Agency plans blocked server-side. `.env.local.example` updated with `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`.

---

## TESTING DONE

- **TypeScript**: `npx tsc --noEmit` → **0 errors** (verified after Beta Sprint + Hardening Sprint + Razorpay Sprint, May 2026)
- **Manual E2E on localhost:3000**:
  - Signup → login → add ASIN → view ASIN detail ✅
  - BSR refresh (Python scraper ran, snapshot inserted into Supabase) ✅
  - Keyword track + keyword rank refresh (Python ran 90s, results saved to `keyword_rank_snapshots`) ✅
  - Buy box check (`?mock=1` for dev) ✅
  - Settings profile save + workspace save (verified in Supabase dashboard) ✅
  - Billing page loads real plan + usage data ✅
  - Sidebar shows real ASIN count ✅
  - Logout + unauthenticated redirect ✅
  - Session protection on `/dashboard/*` via `proxy.ts` ✅
- **Python rank checker**: tested directly via CLI — returns correct `page_status` JSON
- **Supabase RLS**: all 22 tables confirmed RLS ENABLED in Supabase Policies dashboard. 7 legacy tables locked via migration 004.
- **Security audit**: full audit of all 22 tables, 9 API routes, auth flows, env files — 4 issues found and fixed (see Bugs Fixed #7–10)
- **No automated tests** (no Jest, no Playwright E2E, no Vitest) — zero test coverage

---

## PLANS STRUCTURE (in `subscription_plans` table)

| Plan | Price | ASIN Limit | Keyword Limit | Target user |
|---|---|---|---|---|
| Free | ₹0 | 5 | 10 | New signups (default) |
| Starter | TBD | ~15 | ~25 | Individual sellers |
| Growth | TBD | ~30 | ~50 | Growing sellers |
| Pro | TBD | ~60 | ~100 | Power sellers |
| Agency | TBD | Unlimited | Unlimited | Multi-client agencies |

---

## WHAT IS NOT BUILT YET — MVP GAPS

### Critical (blocks launch)
1. ~~**Razorpay billing integration**~~ ✅ **DONE (27 May 2026)** — self-serve upgrade flow built. `POST /api/billing/create-order` + `POST /api/billing/verify-payment`. Razorpay checkout modal, HMAC signature verification, `workspace_subscriptions` upsert on success. No webhooks (MVP intentional). Requires `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` env vars.
2. ~~**Apply migration 005 to production Supabase**~~ ✅ **DONE (27 May 2026)** — migration applied. Triggers hardened, subscription_plans seeded (5 plans), all existing users backfilled. New signups now get the full onboarding chain reliably.

### High Priority
3. ~~**Aggregate dashboard pages connected to real data**~~ ✅ **DONE** — all dashboard pages now use real Supabase data (completed May 2026 Beta Sprint)
4. **Scheduled / automatic refreshes** — BSR, keyword ranks, pincode checks are all manual (button-click only). No cron, no background scheduler. Users won't return daily to click buttons.
5. ~~**Alert system backend**~~ ✅ **DONE** — `POST /api/alerts/generate` evaluates 4 real rules and persists to `alerts` table

### Medium Priority
6. ~~**Report generation**~~ ✅ **DONE** — 6 CSV report types, download via browser, saved to `reports` table
7. **Competitor tracking real data** — competitor page is still mock. No add/track flow connected to DB.
8. **Amazon Tool Settings persistence** — default marketplace and default pincodes in Settings don't save (no DB column or API call).
9. **Notification delivery** — notification toggles in Settings are local state only. No email/SMS sending.

### Lower Priority (post-MVP)
10. **Multi-user workspace invites** — `workspace_members` table supports it but no invite UI exists.
11. **Automated test suite** — zero unit/integration/E2E tests currently.

---

## CONSTRAINTS / RULES FOR THIS PROJECT

- Do not over-engineer. Only build what's needed for MVP.
- No new UI/features until real data flows through existing mock pages.
- No Razorpay until all core tracking flows are stable.
- Keep Python scrapers as-is — do not rewrite in Node.
- India-first: amazon.in, INR pricing, Indian pincodes (6 digits), marketplace code `IN`.
- Dev server: `localhost:3000`. Python: `C:\Python314\python.exe`.

---

## QUESTIONS FOR YOU

Based on everything above:

1. What are the absolute must-have items to complete before I can call this MVP and show it to paying beta users?
2. What is the right order to build them?
3. What can I defer to post-MVP?
4. Are there any architectural risks or silent bugs I should address before acquiring users?
