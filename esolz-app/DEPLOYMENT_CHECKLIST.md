# Vercel Deployment Checklist

## Before pushing to GitHub

- [ ] `.env.local` is listed in `.gitignore` — **verified, do not commit it**
- [ ] `SPAPI_HANDOFF.txt` and `SAAS_CONTEXT.txt` are listed in `.gitignore` — **verified**
- [ ] No real secrets in any committed file — run the check:
  ```
  git grep -E "amzn1\.oa2-cs|sb_secret|sb_publishable|SPAPI_ENCRYPTION_KEY=[0-9a-f]{64}"
  ```
  Expected: no output.

---

## Step 1 — Push to GitHub

```bash
# From e:\amazon-bsr-tracker\esolz-app
cd e:\amazon-bsr-tracker\esolz-app
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<your-org>/<your-repo>.git
git push -u origin main
```

> **Do not run `git add .env.local`** — it is gitignored.

---

## Step 2 — Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository
3. Set **Root Directory** to: `esolz-app`
4. Framework preset: **Next.js** (auto-detected)
5. Click **Deploy** — let the first build run (it will fail on missing env vars, that is fine)

You will receive a URL like:
```
https://esolz-app.vercel.app
```
(or a custom domain you configure)

---

## Step 3 — Add Environment Variables in Vercel

Go to: **Vercel Project → Settings → Environment Variables**

Add every variable below. Replace `https://YOUR-VERCEL-DOMAIN` with your actual Vercel URL.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://okxfwcfxxrtmijmvztdq.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | *(from .env.local)* |
| `SUPABASE_SERVICE_ROLE_KEY` | *(from .env.local)* |
| `BSR_PYTHON_BIN` | leave blank or omit — Python not available on Vercel |
| `NEXT_PUBLIC_API_URL` | `https://YOUR-VERCEL-DOMAIN` |
| `NEXT_PUBLIC_DEV_AUTH_BYPASS` | `false` |
| `APP_PUBLIC_URL` | `https://YOUR-VERCEL-DOMAIN` |
| `NEXT_PUBLIC_APP_URL` | `https://YOUR-VERCEL-DOMAIN` |
| `SPAPI_APPLICATION_ID` | *(from .env.local)* |
| `SPAPI_LWA_CLIENT_ID` | *(from .env.local)* |
| `SPAPI_LWA_CLIENT_SECRET` | *(from .env.local)* |
| `SPAPI_LOGIN_URI` | `https://YOUR-VERCEL-DOMAIN/api/amazon/connect/login` |
| `SPAPI_REDIRECT_URI` | `https://YOUR-VERCEL-DOMAIN/api/amazon/connect/callback` |
| `SPAPI_ENCRYPTION_KEY` | *(from .env.local — 64 hex chars)* |
| `RAZORPAY_KEY_ID` | *(leave blank until KYC approved)* |
| `RAZORPAY_KEY_SECRET` | *(leave blank until KYC approved)* |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | *(leave blank until KYC approved)* |

After adding all variables, **Redeploy** from the Vercel dashboard.

---

## Step 4 — Update Supabase Auth Redirect URLs

1. Go to: [Supabase Dashboard → Authentication → URL Configuration](https://supabase.com/dashboard/project/okxfwcfxxrtmijmvztdq/auth/url-configuration)
2. Under **Redirect URLs**, add:
   ```
   https://YOUR-VERCEL-DOMAIN/**
   ```
3. Save.

---

## Step 5 — Update Amazon Portal OAuth URIs

1. Go to: [Amazon Solution Provider Portal](https://solutionproviderportal.amazon.com) → your app
2. Click **Edit App**
3. Update these two fields:

   | Field | Value |
   |---|---|
   | **OAuth Login URI** | `https://YOUR-VERCEL-DOMAIN/api/amazon/connect/login` |
   | **OAuth Redirect URI** | `https://YOUR-VERCEL-DOMAIN/api/amazon/connect/callback` |

4. Save / Submit changes.

> Note: App is in **Draft** status — OAuth URLs with `version=beta` in the consent URL are correct for Draft.  
> Remove `version=beta` only after Amazon approves the app for production.

---

## Step 6 — OAuth End-to-End Test

Run this sequence exactly:

1. Open `https://YOUR-VERCEL-DOMAIN/dashboard/settings` in a fresh browser (or incognito)
2. Log in with your Amazon seller account credentials for Sociomonkey
3. Navigate to **Settings → Amazon Seller Account**
4. Confirm: no "Dev notice" orange banner (means domain is correct)
5. Click **Connect Amazon Account**
6. Expected: redirected to `https://sellercentral.amazon.in/apps/authorize/consent?application_id=<SPAPI_APPLICATION_ID>...`
7. On Amazon consent page: authorize the app
8. Expected: redirected back to `https://YOUR-VERCEL-DOMAIN/dashboard/settings?amazon=connected`
9. Expected: green toast "Amazon account connected successfully!"
10. Expected: Settings card shows Seller ID, Marketplace = Amazon India, Status = Active

**If OAuth fails**, check the `?amazon=error&reason=` param in the URL:
- `missing_params` — Amazon did not send required params; check portal URI fields
- `state_mismatch` — CSRF cookie expired or domain mismatch; retry from step 1
- `session_expired` — Supabase session cookie missing; log in first
- `token_exchange` — LWA credentials wrong; check `SPAPI_LWA_CLIENT_ID` and `SPAPI_LWA_CLIENT_SECRET`
- `db_error` — Supabase write failed; check service-role key and RLS

---

## Step 7 — Verify in Supabase

Run these SQL queries in [Supabase SQL Editor](https://supabase.com/dashboard/project/okxfwcfxxrtmijmvztdq/sql/new):

```sql
-- Should show 1 row with status='active' and your real Seller ID
-- Do NOT select refresh_token_encrypted or access_token_encrypted
SELECT selling_partner_id, marketplace_id, marketplace_name, status, connected_at, last_sync_at
FROM amazon_connections;
```

```sql
-- Should show 1 'oauth_connect' event
SELECT event_type, created_at, metadata
FROM amazon_audit_logs
ORDER BY created_at DESC;
```

---

## After Deployment

Your local `.env.local` should have blank values for the OAuth vars during normal development:

```env
# Leave blank for local dev — OAuth runs on Vercel only
APP_PUBLIC_URL=
NEXT_PUBLIC_APP_URL=
SPAPI_LOGIN_URI=
SPAPI_REDIRECT_URI=
```

> Amazon OAuth requires HTTPS and a registered callback domain. It cannot run from localhost.
> Use the Vercel deployment URL for all OAuth testing.

---

## Known Issues / Remaining Work

| Item | Status |
|---|---|
| Vercel deployment | ⏳ Pending |
| OAuth end-to-end test | ⏳ Blocked on deployment |
| SP-API token refresh (access_token expires 1h) | ⏳ Phase 1C — not built yet |
| Supabase type generation for amazon_* tables | ⏳ Run after OAuth confirmed |
| Razorpay payments | ⏳ Blocked on KYC (~2–3 days from 2026-05-28) |
| SP-API data sync | ⏳ Phase 2 — not started |
| LWA credential rotation deadline | ⚠️ 2026-09-29 — set a calendar reminder |

---

## Security Rules — Never Break

- `refresh_token_encrypted` and `access_token_encrypted` must never appear in any API response, client component, or `console.log`
- `encryptToken` / `decryptToken` (from `src/lib/amazon/crypto.ts`) must only be called from server-side route handlers
- All `amazon_*` table writes must use `createAdminClient()` (service-role)
- `SPAPI_LWA_CLIENT_SECRET`, `SPAPI_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — server-only, never prefix with `NEXT_PUBLIC_`
