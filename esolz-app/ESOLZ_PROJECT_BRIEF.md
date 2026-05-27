# Sociomonkey — Amazon Seller Intelligence Platform
## Complete Project Brief for AI Assistance

---

## PRODUCT OVERVIEW

**Product name:** Sociomonkey
**Subline:** Amazon Intelligence
**What it does:** Amazon Seller Intelligence SaaS — lets sellers track BSR (Best Seller Rank), monitor Buy Box ownership, check product availability by pincode, track and research keyword rankings, all from one dashboard.
**Target market:** Amazon India sellers (small-to-mid size), managing 1–20 ASINs on amazon.in
**Monetisation:** Subscription SaaS, tiered plans priced in INR (Free / Starter / Growth / Pro / Agency). Payment gateway planned: **Razorpay** — NOT yet built.

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
| `buybox_snapshots` | `tracked_asin_id`, `is_self`, `seller_name`, `seller_id`, `price`, `fulfillment_type`, `checked_at` | Inserted on each buy box check |
| `tracked_keywords` | `id`, `workspace_id`, `tracked_asin_id`, `keyword`, `marketplace` | Upserted on keyword track |
| `keyword_rank_snapshots` | `tracked_asin_id`, `keyword`, `organic_rank`, `sponsored_rank`, `page_status`, `scan_status`, `checked_at` | Inserted by Python rank checker |
| `usage_counters` | `workspace_id`, `period_start`, `period_end`, `asin_count`, `keyword_count`, `pincode_checks_used`, `reports_generated`, `competitor_count` | Upserted after each resource add |

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
- Chart (7/14/30 day toggle) — chart uses mock generator seeded from real latest BSR value (not true time-series from DB yet)
- **Refresh BSR button** → `POST /api/asins/[asin]/refresh` → Python scraper → inserts row into `asin_snapshots` ✅

**Pincode Availability section:**
- Latest results from `pincode_snapshots` ✅
- **Check Pincode button** → `POST /api/asins/[asin]/pincode` → Playwright Python → inserts row into `pincode_snapshots` ✅
- 6-digit validation for India

**Buy Box section:**
- Latest status from `buybox_snapshots` ✅
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
- **Upgrade buttons**: all disabled with "Coming soon" tooltip — Razorpay not built yet (intentional) ✅

### Sidebar Plan Card
- Shows current plan name + ASIN count from live DB query ✅
- Graceful loading state ✅

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
| `/api/asins/[asin]/buybox` | POST | Python check → `buybox_snapshots` |
| `/api/asins/[asin]/keywords/track` | POST | Upsert `tracked_keywords` for ASIN + increment `keyword_count` |
| `/api/asins/[asin]/keywords/refresh` | POST | Python rank check → `keyword_rank_snapshots` for this ASIN |
| `/api/keywords/research` | POST | Amazon autocomplete API → suggestions |
| `/api/keywords/track` | POST | Upsert `tracked_keywords` at workspace level |
| `/api/keywords/refresh` | POST | Python rank check for all workspace keywords |
| `/api/usage/init` | POST | Upsert `usage_counters` row (accepts both `workspace_id` and `workspaceId`) |

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

## WHAT IS UI-ONLY / MOCK DATA (placeholder pages)

These pages have full built-out UI with charts, filters, and interactions but use hardcoded mock arrays from `/lib/mock-*.ts` files. **No DB queries. No real data.**

| Page | Route | Mock source |
|---|---|---|
| Dashboard Overview | `/dashboard` | `MOCK_BSR_SUMMARY`, `MOCK_INSIGHTS` |
| BSR Tracker | `/dashboard/bsr` | `MOCK_PRODUCT_SNAPSHOTS`, `generateBsrHistory()` |
| Pincode Checker | `/dashboard/pincode` | `MOCK_PINCODE_RESULTS` (shows "Demo mode" label in UI) |
| Buy Box Monitor | `/dashboard/buybox` | `MOCK_BUYBOX_ENTRIES`, `MOCK_BUYBOX_HISTORY`, `MOCK_COMPETITORS`, `MOCK_BUYBOX_ALERTS` |
| Alerts Center | `/dashboard/alerts` | `MOCK_ALERTS` |
| Reports | `/dashboard/reports` | `REPORT_TEMPLATES`, `RECENT_REPORTS` — download buttons do nothing |
| Competitors | `/dashboard/competitors` | `MOCK_COMPETITOR_ASINS`, `MOCK_BUYBOX_THREATS`, `MOCK_KEYWORD_OVERLAP` |

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

---

## TESTING DONE

- **TypeScript**: `npx tsc --noEmit` → **0 errors** (verified after all security + rebrand changes)
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
1. **Razorpay billing integration** — plan upgrade flow, payment, webhook to update `workspace_subscriptions`, failed payment handling
2. **Workspace creation trigger verification** — assumed to be a Supabase DB trigger on `auth.users` insert but not confirmed. If missing, every new signup gets no workspace → blank pages everywhere → broken onboarding

### High Priority
3. **Aggregate dashboard pages connected to real data** — `/dashboard` (overview), `/dashboard/bsr`, `/dashboard/buybox`, `/dashboard/pincode` all show mock data. These are core selling-point pages.
4. **Scheduled / automatic refreshes** — BSR, keyword ranks, pincode checks are all manual (button-click only). No cron, no background scheduler. Users won't return daily to click buttons.
5. **Alert system backend** — alerts page is full UI/mock. No logic evaluates thresholds, no notifications are sent.

### Medium Priority
6. **Report generation** — reports page is full UI/mock. No PDF/Excel export, no actual data compilation.
7. **Competitor tracking real data** — competitor page is full mock. No add/track flow connected to DB.
8. **Amazon Tool Settings persistence** — default marketplace and default pincodes in Settings don't save (no DB column or API call).
9. **Notification delivery** — notification toggles in Settings are local state only. No email/SMS sending.

### Lower Priority (post-MVP)
10. **Multi-user workspace invites** — `workspace_members` table supports it but no invite UI exists.
11. **Automated test suite** — zero unit/integration/E2E tests currently.
12. **BSR history chart from real DB data** — ASIN detail BSR chart uses mock generator seeded from latest real value, not actual historical snapshots from `asin_snapshots`.

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
