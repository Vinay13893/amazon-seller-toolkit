# Beta Readiness Audit Report
**Date:** 2026-05-27  
**Scope:** Full Security, Schema, RLS, Auth, and Stability Review  
**Stack:** Next.js 15 App Router + Supabase + Python scrapers  
**Result:** 🔴 **NOT BETA-READY — 3 blockers must be fixed first**

---

## Audit Summary Table

| Area | Status | Blockers |
|------|--------|----------|
| Schema (15 production tables) | ✅ Clean | 0 |
| RLS — production tables | ✅ All enabled | 0 |
| RLS — legacy tables | 🔴 **All disabled** | **1 CRITICAL** |
| API Routes (9 routes) | ⚠️ Debug leaks | 1 MEDIUM |
| Auth / Middleware | ✅ Solid | 0 |
| Auth — Signup UX | ⚠️ Wrong redirect | 1 MEDIUM |
| Environment / Secrets | ✅ Fixed | 0 (fixed) |
| TypeScript | ✅ 0 errors | 0 |

---

## Section 1: Schema — All 22 Tables

### 1.1 Production Tables (in migration 001) — All ✅

| Table | RLS | Policies |
|-------|-----|----------|
| `alerts` | ✅ Enabled | SELECT, INSERT, UPDATE |
| `asin_snapshots` | ✅ Enabled | SELECT, INSERT |
| `buybox_snapshots` | ✅ Enabled | SELECT, INSERT |
| `competitor_asins` | ✅ Enabled | SELECT, INSERT, UPDATE, DELETE |
| `keyword_rank_snapshots` | ✅ Enabled | SELECT, INSERT |
| `pincode_checks` | ✅ Enabled | SELECT, INSERT |
| `profiles` | ✅ Enabled | SELECT, INSERT, UPDATE |
| `reports` | ✅ Enabled | SELECT, INSERT |
| `subscription_plans` | ✅ Enabled | SELECT (public read) |
| `tracked_asins` | ✅ Enabled | SELECT, INSERT, UPDATE, DELETE |
| `tracked_keywords` | ✅ Enabled | SELECT, INSERT, UPDATE, DELETE |
| `usage_counters` | ✅ Enabled | SELECT only (writes via admin client — intentional) |
| `workspace_members` | ✅ Enabled | SELECT, INSERT, UPDATE, DELETE |
| `workspace_subscriptions` | ✅ Enabled | SELECT only (writes via server trigger + admin client) |
| `workspaces` | ✅ Enabled | SELECT, INSERT, UPDATE, DELETE |

All 15 production tables use the `user_workspace_ids()` SECURITY DEFINER helper function.  
Snapshot tables (`asin_snapshots`, `keyword_rank_snapshots`, `pincode_checks`, `buybox_snapshots`, `reports`) correctly have **no UPDATE or DELETE** policy — snapshots are immutable by design. ✅

### 1.2 Legacy Tables — 🔴 **ALL 7 HAVE RLS DISABLED**

These tables were created before the migrations and have never had RLS applied.  
**With RLS disabled, any authenticated user can read ALL rows via the Supabase REST API using the `anon` key.** On the free plan the `anon` key is also usable by unauthenticated callers if the REST endpoint is hit directly.

| Table | RLS | Row estimate | Risk | In current code? |
|-------|-----|-------------|------|-----------------|
| `seller_credentials` | 🔴 **DISABLED** | ~24 rows | **CRITICAL** — name implies Amazon API keys/secrets | ❌ No |
| `users` | 🔴 **DISABLED** | ~248 rows | **HIGH** — old user data, PII | ❌ No |
| `asins` | 🔴 **DISABLED** | ~14 rows | Medium — scraped ASIN data | ❌ No |
| `bsr_history` | 🔴 **DISABLED** | ~36 rows | Low | ❌ No |
| `job_logs` | 🔴 **DISABLED** | ~48 rows | Low — internal logs | ❌ No |
| `keyword_ranks` | 🔴 **DISABLED** | ~32 rows | Low | ❌ No |
| `tool_usage` | 🔴 **DISABLED** | ~32 rows | Low | ❌ No |

**Action required:** Run `004_lock_legacy_tables.sql` migration (see Section 6).

---

## Section 2: RLS Architecture

The RLS policy design is correct and well-structured:

```sql
-- All production tables share this pattern:
CREATE POLICY "member select" ON <table> FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));
```

`user_workspace_ids()` is `SECURITY DEFINER` and returns only workspace IDs where `auth.uid()` is a `workspace_members` row. This means:
- ✅ A user can only see rows in their own workspace
- ✅ Cross-workspace data leakage is impossible via the REST API
- ✅ Admin client (`createAdminClient()`) bypasses RLS safely on server only — `SUPABASE_SERVICE_ROLE_KEY` never has `NEXT_PUBLIC_` prefix ✅

The `usage_counters` table has SELECT-only RLS. All API routes that write to it use `createAdminClient()`. ✅

---

## Section 3: API Routes — 9 Routes Reviewed

### 3.1 Auth & Workspace Guard Pattern — ✅ Consistent

All routes that modify data follow this correct sequence:
1. `supabase.auth.getUser()` — verify session
2. `workspace_members` lookup — verify workspace membership (prevents forged `workspace_id`)
3. `tracked_asins` ownership check — prevents accessing another workspace's ASINs
4. `createAdminClient()` INSERT — writes bypass RLS safely server-side

### 3.2 Route-by-Route Summary

| Route | Auth | Workspace | ASIN ownership | Issues |
|-------|------|-----------|---------------|--------|
| `POST /api/asins/[asin]/refresh` | ✅ | ✅ | ✅ | `detail: String(adminErr)` leaks |
| `POST /api/asins/[asin]/pincode` | ✅ | ✅ | ✅ | Returns full DB record |
| `POST /api/asins/[asin]/buybox` | ✅ | ✅ | ✅ | Returns full DB record; `?mock=1` blocked in prod ✅ |
| `POST /api/asins/[asin]/keywords/track` | ✅ | ✅ | ✅ | `debug: { authErr, memberErr, asinErr }` leaks |
| `POST /api/asins/[asin]/keywords/refresh` | ✅ | ✅ | ✅ | `debug: { authErr, memberErr, asinErr }` leaks |
| `POST /api/keywords/track` | ✅ | ✅ | — | `debug: { authErr, memberErr }` leaks |
| `POST /api/keywords/refresh` | ✅ | ✅ | — | `debug: { authErr, memberErr }` leaks |
| `GET /api/keywords/research` | ✅ | — | — | Read-only, no DB write ✅ |
| `POST /api/usage/init` | ✅ | ✅ | — | ✅ Clean (fixed last session) |

### 3.3 ⚠️ DEBUG INFO LEAKS IN ERROR RESPONSES (MEDIUM)

Five routes return internal debug data in their JSON error responses:

```json
// Example from keywords/track — exposed to any API caller
{ "error": "Not a workspace member", "debug": { "user": "uuid-here", "memberErr": { "code": "PGRST...", "message": "..." } } }
```

What leaks:
- User UUIDs
- Internal Supabase/PostgREST error codes and messages
- PostgreSQL constraint names
- Internal table structure hints

Routes affected: `keywords/track`, `keywords/refresh`, `asins/[asin]/keywords/track`, `asins/[asin]/keywords/refresh`, `asins/[asin]/refresh`.

**Fix:** Remove the `debug` key from all production error responses. See Section 7.2.

### 3.4 Minor: Full DB Records in Success Responses

`POST /api/asins/[asin]/pincode` and `POST /api/asins/[asin]/buybox` return the full DB snapshot record, including `id`, `workspace_id`, `checked_at`, etc. This is not a vulnerability but is more than the client needs. Low priority.

---

## Section 4: Authentication & Middleware

### 4.1 `src/proxy.ts` — Session Refresh + Auth Guard

- ✅ Session refresh on every request (no stale sessions)
- ✅ `/dashboard/*` routes are protected — unauthenticated users redirected to `/login`
- ✅ Authenticated users are bounced from `/login` and `/signup` to `/dashboard`
- ✅ `NEXT_PUBLIC_DEV_AUTH_BYPASS` is checked: if `=== 'true'`, entire guard is skipped
  - ⚠️ **Was defaulting to `true` in `.env.local.example` — FIXED** (now defaults to `false`)

### 4.2 Auth Callback — ✅ Safe

```typescript
// Open-redirect protection — correct
const safePath = next.startsWith('/') ? next : '/dashboard'
```

### 4.3 Login Page — ✅ Safe

Redirect param validated: `redirect && redirect.startsWith('/')` before use. ✅

### 4.4 ⚠️ Signup Page — Wrong Post-Signup Redirect (MEDIUM)

**Bug:** After `supabase.auth.signUp()` returns, the page calls `router.push('/dashboard/asins')` immediately, regardless of whether email confirmation is required.

**Impact:**
- User has no session yet (email unconfirmed)
- They land on `/dashboard/asins` with no data and no explanation
- Workspace trigger (`fn_handle_new_profile`) fires on email confirmation, not signup call
- User may think signup failed, retry, or give up

**Fix:** After `signUp()`, redirect to `/signup/check-email` (or show inline message) explaining "Check your inbox to confirm your email." See Section 7.3.

### 4.5 Triggers — ✅ Correct

- `fn_handle_new_user` fires on `auth.users` INSERT → creates `profiles` row
- `fn_handle_new_profile` fires on `profiles` INSERT → creates `workspace`, `workspace_members`, and `workspace_subscriptions` (Free plan) rows
- Both are `SECURITY DEFINER` — bypass RLS safely

---

## Section 5: Environment & Secrets

| Variable | Status | Notes |
|----------|--------|-------|
| `SUPABASE_URL` | ✅ | Committed in example with placeholder |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Public — browser safe |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Public — browser safe, RLS protects data |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Server-only, no `NEXT_PUBLIC_` prefix |
| `NEXT_PUBLIC_DEV_AUTH_BYPASS` | ✅ **FIXED** | Was `true`, now defaults to `false` |
| `BSR_PYTHON_BIN` | ✅ | Documented, server-only |
| `NEXT_PUBLIC_APP_URL` | ✅ | Safe |

`.env.local` is properly git-ignored (`.env*` rule in `.gitignore` with `!.env.local.example` exception). ✅

---

## Section 6: Required Fixes Before Beta

### 🔴 FIX 1 (BLOCKER): Lock Legacy Tables via RLS

**File:** Create and apply `esolz-app/supabase/migrations/004_lock_legacy_tables.sql`

```sql
-- Migration 004: Lock legacy tables by enabling RLS with zero-access policies
-- These tables predate the migration system. None are used by current application code.
-- Enabling RLS with no policies = complete lockdown (no anon or user access via REST API).
-- This does NOT delete any data.

-- seller_credentials (CRITICAL - may contain Amazon API secrets)
ALTER TABLE public.seller_credentials ENABLE ROW LEVEL SECURITY;

-- users (HIGH - contains old user PII, 248 rows)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- asins (old ASIN data, replaced by tracked_asins)
ALTER TABLE public.asins ENABLE ROW LEVEL SECURITY;

-- bsr_history (old BSR data, replaced by asin_snapshots)
ALTER TABLE public.bsr_history ENABLE ROW LEVEL SECURITY;

-- job_logs (old scheduler logs)
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;

-- keyword_ranks (old keyword data, replaced by keyword_rank_snapshots)
ALTER TABLE public.keyword_ranks ENABLE ROW LEVEL SECURITY;

-- tool_usage (old usage analytics)
ALTER TABLE public.tool_usage ENABLE ROW LEVEL SECURITY;
```

**Effect:** Enables RLS on all 7 legacy tables. With RLS enabled and no policies defined, no user (authenticated or anonymous) can access these tables via the REST API. Admin client (service role) bypasses RLS and retains access. Data is preserved. This is a non-destructive, fully reversible change.

**To apply:** Run this SQL in the Supabase SQL editor, then commit the file.

---

### ⚠️ FIX 2 (MEDIUM): Strip Debug Fields from API Error Responses

**Affected files:**
- `src/app/api/keywords/track/route.ts`
- `src/app/api/keywords/refresh/route.ts`
- `src/app/api/asins/[asin]/keywords/track/route.ts`
- `src/app/api/asins/[asin]/keywords/refresh/route.ts`
- `src/app/api/asins/[asin]/refresh/route.ts`

**Pattern to remove (examples):**
```typescript
// REMOVE these debug fields:
return NextResponse.json({ error: 'Auth error', debug: { authErr } }, { status: 401 })
return NextResponse.json({ error: 'Not a member', debug: { user: user.id, memberErr } }, { status: 403 })
return NextResponse.json({ error: 'Server error', detail: String(adminErr) }, { status: 500 })
```

**Replace with:**
```typescript
return NextResponse.json({ error: 'Auth error' }, { status: 401 })
return NextResponse.json({ error: 'Not a member' }, { status: 403 })
return NextResponse.json({ error: 'Server error' }, { status: 500 })
```

Log the actual error server-side (`console.error(authErr)`) if you need it for debugging.

---

### ⚠️ FIX 3 (MEDIUM): Fix Signup Redirect UX Bug

**File:** `src/app/(auth)/signup/page.tsx`

**Current (broken):**
```typescript
await supabase.auth.signUp({ ... })
router.push('/dashboard/asins')  // ← wrong: user has no session yet
```

**Fix:** Replace the `router.push` with a redirect to a "check email" confirmation page. The simplest approach (no new page needed):

```typescript
const { error } = await supabase.auth.signUp({ ... })
if (!error) {
  router.push('/signup/check-email')
}
```

Create `src/app/(auth)/signup/check-email/page.tsx` with a simple message:
> "We've sent a confirmation email to **[email]**. Click the link to activate your account."

---

## Section 7: Already-Fixed Items

| Item | Fix Applied |
|------|-------------|
| `NEXT_PUBLIC_DEV_AUTH_BYPASS` defaulting to `true` in `.env.local.example` | ✅ Changed to `false` |
| `usage/init` route rejected `workspace_id` (snake_case) | ✅ Fixed last session |
| `middleware.ts` conflict with `proxy.ts` | ✅ Removed `middleware.ts` |

---

## Section 8: What Is Verified Safe ✅

- All 15 production tables have RLS enabled with workspace-scoped policies
- `user_workspace_ids()` helper is `SECURITY DEFINER` — safe RLS pattern
- `createAdminClient()` uses `SUPABASE_SERVICE_ROLE_KEY` — never exposed to browser
- All API routes verify workspace membership before acting
- ASIN-scoped routes verify ASIN ownership within the workspace
- Auth callback has open-redirect protection
- Login has redirect parameter validation
- `?mock=1` scraper shortcut is disabled in production
- TypeScript: **0 compile errors**
- No unused `middleware.ts` conflict

---

## Section 9: Recommended Action Sequence

```
1. Apply migration 004_lock_legacy_tables.sql in Supabase SQL editor
2. Commit the migration file
3. Strip debug fields from 5 API routes (quick code change)
4. Fix signup redirect to /signup/check-email
5. Test full signup → email confirm → dashboard flow
6. Deploy to staging, verify no TypeScript errors
7. → BETA READY
```

**Do not delete the legacy tables yet** — confirm no external tools or scripts reference them first. After beta launch, you can evaluate dropping them.
