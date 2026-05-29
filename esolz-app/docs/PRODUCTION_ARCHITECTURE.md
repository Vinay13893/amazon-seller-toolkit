# Production Architecture

## Canonical Backend

All active SaaS features use **Next.js API routes** inside `esolz-app`.

```
esolz-app/src/app/api/
```

Do not implement new business logic in any other backend unless this document is
explicitly updated to reflect a decision.

---

## Stack

| Layer       | Technology                          | Location                        |
|-------------|-------------------------------------|---------------------------------|
| Frontend    | Next.js (App Router)                | Vercel                          |
| Backend API | Next.js API routes (serverless)     | Vercel (same project)           |
| Database    | Supabase Postgres                   | Supabase (hosted)               |
| Auth        | Supabase Auth                       | Supabase                        |
| Amazon Auth | OAuth 2.0 / LWA (SP-API)            | Next.js API routes              |
| Payments    | Razorpay (not yet active)           | Next.js API routes (when built) |

---

## Amazon SP-API OAuth Flow

Implemented entirely in Next.js API routes:

- `GET  /api/amazon/connect/login`    — Generate CSRF state, redirect to Amazon
- `GET  /api/amazon/connect/callback` — Handle OAuth callback, store encrypted tokens
- `GET  /api/amazon/connect/status`   — Return connection state (no tokens returned)
- `POST /api/amazon/sync/basic`       — Refresh token + verify marketplace participations
- `POST /api/amazon/sync/listings/start` — Initiate full listings sync

**Never return tokens to frontend. Never log tokens.**

---

## Legacy / Inactive Services

| Service                  | Status            | Notes                                          |
|--------------------------|-------------------|------------------------------------------------|
| `saas-backend/` FastAPI  | Inactive          | Render endpoints returning 404. Do not treat as primary. Revive only if explicitly decided. |
| Root `app.py` Flask app  | Legacy            | BSR scraping tool. No active managed DB.       |

---

## Deployment Checks

Run these after every deployment:

| Endpoint                             | Expected                                     |
|--------------------------------------|----------------------------------------------|
| `GET /`                              | 200                                          |
| `GET /api/health`                    | 200 `{ ok: true, ... }`                      |
| `GET /api/amazon/connect/status`     | 401 when unauthenticated                     |
| `POST /api/amazon/sync/basic`        | 401 when unauthenticated (GET returns 405)   |

---

## Decision Rule

> All new active SaaS features go into `esolz-app` (Next.js + Supabase)
> unless a team decision explicitly moves a workload to a separate service.
