# Amazon India EasyHOME — Review Request Automation Spec

**Status:** Planning only. Nothing in this document has been implemented. No branch, migration, env
var, or code has been created. No Amazon API has been called. This is the locked design from
`BRAHMASTRA_MASTER_TRACKER.md` §18, expanded into an implementation-ready spec per founder request
(2026-07-12).

Scope: Amazon India / EasyHOME only. Uses only Amazon's official Solicitations API. No custom
messages. Dry-run by default; live sending gated behind an explicit env var.

---

## 1. Existing Orders API support

**Not implemented anywhere in this codebase.**

- `src/lib/amazon/spapi-client.ts` — the shared SP-API helper file — has functions for
  `getMarketplaceParticipations` (Sellers API), `searchListingsItems` (Listings Items API), and
  `probeInboundShipmentsAccess` (Fulfillment Inbound v0, permission-probe only). **No Orders API
  function exists.** No file in the repo calls `/orders/v0/orders` or any Orders API path.
- A grep for `amazon_order_id|orderId|/orders/v0|getOrders|OrdersV0` across `src/` returns matches
  only in `payment-transaction-parser.ts`, `easyhome-drop-diagnostic.ts`, and their API routes —
  these all read `order_id` out of **manually-imported settlement/payment CSV rows**
  (`internal_payment_transactions`, migration 033), never from a live Orders API call.
- **Shipped orders are not stored anywhere as live Orders API data.** `internal_payment_transactions`
  has order IDs but is settlement/transaction data (amounts, fees, category), not order/shipment
  status, and is sourced from manual CSV import — not a substitute for Orders API `OrderStatus`.
  Per `WORK_DONE_SUMMARY.md`, this table intentionally has **no buyer PII** (no name/email/phone/
  full address) — a constraint that must carry over to any new Orders-API-backed table.

**Reusable SP-API client/auth helpers:**

- `src/lib/amazon/lwa.ts` → `refreshAccessToken(refreshToken)` — exchanges a stored refresh token
  for a fresh LWA access token. Directly reusable, unchanged.
- `src/lib/amazon/crypto.ts` → `encryptToken`/`decryptToken` (AES-256-GCM, `SPAPI_ENCRYPTION_KEY`).
  Directly reusable, unchanged.
- The `amazon_connections` table (`id, status, marketplace_id, selling_partner_id,
  refresh_token_encrypted, access_token_encrypted, access_token_expires_at`) plus the
  `loadWorkspaceConnection()` / `loadConnection()` pattern already implemented twice
  (`src/app/api/asins/jobs/process-next/route.ts:93-119`, `scripts/process-asin-checker-jobs.ts`):
  look up the workspace's `amazon_connections` row, require `status='active'` and a non-null
  refresh token, decrypt it, call `refreshAccessToken`, re-encrypt and persist the new access
  token. Returns `{ accessToken, marketplaceId, sellingPartnerId }` or `null`. **This exact
  pattern should be extracted once (not re-copied a third time) into a shared helper** — e.g.
  `src/lib/amazon/connection.ts` — since review automation would otherwise be the third
  independent copy of this logic. This extraction is itself proposed as PR #1 below.

**Account/workspace/marketplace scope for EasyHOME:** workspace `55a321c9-7729-4662-a494-9f1f1aa86846`,
marketplace `A21TJRUUN4KGV` (IN) — same as every other Amazon-scoped job in this codebase.
`DEFAULT_MARKETPLACE_ID = 'A21TJRUUN4KGV'` is already a repeated local constant in three files
(`pincode-availability/jobs/route.ts`, `xhzu-stock/import/route.ts`, and one more) — the new work
should reuse `connection.marketplaceId ?? DEFAULT_MARKETPLACE_ID`, matching the existing fallback
convention in `process-next/route.ts`.

---

## 2. Existing Solicitations API support

**Not implemented at all.** A repo-wide grep for `Solicitation|solicitation` (case-sensitive and
case-insensitive) in `src/` returns **zero matches**. Neither `getSolicitationActionsForOrder` nor
`createProductReviewAndSellerFeedbackSolicitation` exists anywhere.

**Are current SP-API permissions/scopes likely sufficient? Unknown — cannot be determined from code.**
SP-API role grants (Orders, Product Reviews and Seller Feedback / Solicitations) are authorized in
Seller Central at the application level, not visible from this repository. Every SP-API integration
built so far (Listings, Pricing, Catalog, Fulfillment Inbound) required its own role grant, and the
Fulfillment Inbound integration (`probeInboundShipmentsAccess`) was explicitly built as a **read-only
permission probe** for exactly this reason — to test access before building real functionality on top
of an assumption.

**Per instruction: stopping here rather than assuming.** Recommendation for PR #1 (below) is to add an
equivalent read-only probe — a single `GET /solicitations/v1/orders/{amazonOrderId}` call against one
known-shipped, already-old EasyHOME order — before any catch-up/daily-job code is written. If that
probe returns 403/`Unauthorized`, the correct next step is to report the exact error back (likely
requiring the founder to add the "Product Reviews and Seller Feedback" role to the SP-API app in
Seller Central) — not to write around it or fake eligibility.

---

## 3. Data model

### `review_solicitation_orders`

```sql
create table review_solicitation_orders (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id),
  marketplace_id              text not null,
  amazon_order_id             text not null,

  order_status                text,           -- Amazon OrderStatus: Shipped, Unshipped, Canceled, etc.
  purchase_date                timestamptz,
  last_updated_at              timestamptz,    -- Amazon's LastUpdateDate from Orders API

  first_seen_at                timestamptz not null default now(),
  next_check_at                timestamptz not null default now(),
  last_checked_at              timestamptz,

  solicitation_status          text not null default 'pending',  -- see state machine below
  solicitation_sent            boolean not null default false,
  solicitation_sent_at         timestamptz,

  check_attempts                integer not null default 0,
  last_eligibility_response     jsonb,          -- raw GET response, for audit only, no PII beyond order id
  last_error_code                text,
  last_error_message             text,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint review_solicitation_orders_order_unique unique (workspace_id, marketplace_id, amazon_order_id)
);

create index review_solicitation_orders_due_idx
  on review_solicitation_orders (workspace_id, next_check_at)
  where solicitation_status not in ('sent', 'already_solicited', 'expired', 'failed_terminal', 'ineligible_terminal');
```

The unique constraint on `(workspace_id, marketplace_id, amazon_order_id)` is the **hard DB-level
idempotency backstop** — mirrors the `(workspace_id, profile_id, dedupe_key)` pattern already used for
Ads warehouse tables and the `tracked_asins` uniqueness pattern in `addOrRestoreTrackedAsin`.

No buyer name, email, phone, or address column exists — matches the `internal_payment_transactions`
PII convention. `last_eligibility_response` stores Amazon's raw GET response (order id + eligibility
actions only, no buyer data) for audit/debugging, same spirit as `internal_data_refresh_runs` keeping
raw job metadata.

### Solicitation status state machine

| Status | Meaning | Terminal? | Retryable? |
|---|---|---|---|
| `pending` | Seen, not yet checked for eligibility | No | Yes (next `next_check_at`) |
| `too_early` | Checked; Amazon says not yet eligible (order too recent) | No | Yes, later |
| `eligible_dry_run` | GET shows `productReviewAndSellerFeedback` eligible; dry-run mode recorded it, did not POST | No (unless catch-up leaves it here permanently by design — see §4) | Yes, once live mode is enabled |
| `sent` | POST succeeded | **Yes** | No |
| `already_solicited` | Amazon's GET/POST response indicates a solicitation was already sent (e.g. by another channel/tool, or a prior run) | **Yes** | No |
| `ineligible_terminal` | GET shows no eligible actions and the order is old enough that eligibility will not appear later (e.g. canceled, refunded, or past Amazon's solicitation window) | **Yes** | No |
| `expired` | Order aged past the point Amazon allows solicitation (per Amazon's own window, observed via repeated `too_early`→no-longer-appears-eligible transition) | **Yes** | No |
| `failed_terminal` | Non-retryable API error (e.g. 400 validation, order not found) after inspection | **Yes** | No |
| `failed_retryable` | Transient error (429, 5xx, network) | No | Yes, with backoff |

**Terminal statuses:** `sent`, `already_solicited`, `ineligible_terminal`, `expired`, `failed_terminal`.
**Retryable statuses:** `pending`, `too_early`, `eligible_dry_run` (in dry-run mode only — see below),
`failed_retryable`.
**Dry-run-only status:** `eligible_dry_run` — this status must never itself trigger a POST; it only
becomes actionable once `REVIEW_REQUESTS_ENABLED=true` promotes the daily job's live-mode check.

### Idempotency rules

1. DB unique constraint on `(workspace_id, marketplace_id, amazon_order_id)` — a second upsert for
   the same order updates the existing row, never inserts a duplicate.
2. Before any POST: re-check `solicitation_sent = false` AND `solicitation_status` is not any
   terminal status, inside the same transaction/guarded-update as the POST-success write (see §6).
3. `solicitation_sent` flips to `true` and `solicitation_status` to `sent` in a single guarded UPDATE
   keyed on `id` + `solicitation_sent = false`, mirroring the `.eq('status','running').eq('locked_at', snapshot)`
   guarded-update pattern already established in `reclaimStuckJob()` (`process-asin-checker-jobs.ts`)
   — this is the concurrency guard, not a separate row lock.
4. Amazon's own solicitation endpoint is itself idempotent-safe in the sense that a repeat POST
   after a real send is expected to come back as an "already sent" style error/ineligible action —
   but this app must not rely on Amazon to be the only line of defense; the DB guard is primary.

### Locking / concurrency approach

Same atomic-claim pattern as the ASIN checker job queue (no new mechanism invented):
- Selecting due rows for the daily job uses `next_check_at <= now()` and excludes terminal statuses
  (via the partial index above).
- If this job ever runs from two schedulers concurrently (a realistic risk, given the ASIN cron
  already has two independent schedulers), each row must be claimed with a guarded UPDATE
  (`.eq('id', id).eq('solicitation_status', expectedStatus)` before proceeding), not a plain
  `SELECT` then unconditional `UPDATE` — this is the exact bug class fixed in PR #24 for the ASIN
  checker and must not be reintroduced here.
- Recommend **one single scheduler only** for this job (see §8) specifically to avoid needing to
  re-solve the dual-scheduler problem the ASIN checker still has open.

---

## 4. One-time catch-up (last 30 days only)

Design, not implemented:

1. **Fetch:** call Orders API `GET /orders/v0/orders` with `MarketplaceIds=A21TJRUUN4KGV`,
   `CreatedAfter` = now − 30 days, paginated via `NextToken`. **Do not** fetch further back — this is
   the explicit "no 120-day backfill" product decision.
2. **Upsert:** for each returned order, upsert into `review_solicitation_orders` on the unique
   `(workspace_id, marketplace_id, amazon_order_id)` key — insert if new (`solicitation_status='pending'`),
   update `order_status`/`last_updated_at` if it already exists (never touch `solicitation_status`,
   `solicitation_sent`, or `solicitation_sent_at` on an upsert-only path).
3. **Eligibility check:** for each upserted order not already terminal, call Solicitations API
   `GET /solicitations/v1/orders/{amazonOrderId}` (throttled — see below). Record the raw response in
   `last_eligibility_response`, set `solicitation_status` to `eligible_dry_run` if
   `productReviewAndSellerFeedback` is present, else `too_early` or `ineligible_terminal` per Amazon's
   response.
4. **Never POST in dry-run**, unconditionally — the catch-up script does not read
   `REVIEW_REQUESTS_ENABLED` at all; it is structurally incapable of sending, not just
   default-disabled. This is a stronger guarantee than an env check and matches the founder's "if
   uncertain, do not send" instruction.
5. **Throttle:** 1 Solicitations GET per 1100ms (`REVIEW_REQUESTS_RATE_LIMIT_MS`), sequential — same
   `await sleep(ms)` pattern already used in `sync-ads-reports.ts`'s `requestAdsReportWithRetry`
   backoff, not a new concurrency primitive.
6. **Batch size:** process orders in batches of 300 (`REVIEW_REQUESTS_BATCH_SIZE`) — this bounds a
   single script invocation's runtime and matches the existing `--limit` pattern used by
   `process-asin-checker-jobs.ts`.
7. **Idempotent to re-run:** running the catch-up twice must not create duplicates (unique constraint)
   and must not re-send anything (it never sends).

---

## 5. Daily forward job

Design, not implemented:

1. **Recent shipped-order fetch:** `GET /orders/v0/orders` with `LastUpdatedAfter` = now − ~2 days
   (small rolling window, catches status transitions Orders API reports after the initial catch-up),
   `MarketplaceIds=A21TJRUUN4KGV`.
2. **Upsert:** same upsert-only semantics as catch-up step 2 — never touches solicitation fields.
3. **Select due, non-terminal rows:** `next_check_at <= now()` AND `solicitation_status` not in the
   terminal set (the partial index from §3 serves this directly).
4. **GET eligibility** per due row, same throttle (1100ms) and batch size (300) as catch-up.
5. **POST only if:**
   - GET response includes `productReviewAndSellerFeedback`, **and**
   - `REVIEW_REQUESTS_ENABLED=true` is explicitly set, **and**
   - all safety gates in §6 pass.
   Otherwise: update status per the state machine (§3) and advance `next_check_at` (e.g. `too_early`
   → recheck in N days; the exact backoff schedule for `too_early` is a follow-up detail, not blocking
   this spec, but should not be tighter than once/day per order to avoid unnecessary Solicitations
   calls).
6. **Safe terminal handling:** once a row is terminal, the daily job's due-row query excludes it by
   construction (partial index) — no explicit "skip" branch needed, but the send path must still
   defensively re-check status before POST (§6) rather than trusting the query alone, exactly as
   `reclaimStuckJob()` re-verifies before counting a write.
7. **Retry handling:** `failed_retryable` rows get a short backoff (e.g. 30 min, mirroring
   `RETRY_DELAY_MINUTES` in the ASIN checker) before re-appearing as due; `check_attempts` increments
   each check regardless of outcome, for observability — no hard max-attempts cutover to `failed_terminal`
   is proposed here without founder input on the right ceiling (the ASIN checker's `max_attempts`
   pattern is the template if one is wanted later).

---

## 6. Safety gates (before every POST, all must pass)

1. Local DB: `solicitation_sent = false`.
2. Local DB: `solicitation_status` not in `{sent, already_solicited, expired, failed_terminal, ineligible_terminal}`.
3. **Fresh** GET eligibility call (not a cached/stale `last_eligibility_response`) includes
   `productReviewAndSellerFeedback` in its actions — re-checked immediately before POST, not reused
   from an earlier check in the same run.
4. DB lock/idempotency guard succeeds: the guarded UPDATE
   (`.eq('id', id).eq('solicitation_sent', false)` → then POST → then confirm the UPDATE's returned
   row count before treating the send as real) — same verify-after-write discipline as
   `reclaimStuckJob()`. If the guarded pre-claim UPDATE affects 0 rows, another worker already claimed
   this order; skip, do not POST.
5. Env gates: `REVIEW_REQUESTS_ENABLED=true` AND `REVIEW_REQUESTS_DRY_RUN=false` (both, not either —
   belt-and-suspenders; see §7).
6. **Uncertainty means no send.** If the GET response is ambiguous, partially parsed, or the eligibility
   action list can't be confidently read (e.g. an unexpected shape from Amazon), treat as not eligible
   and log `last_error_code`/`last_error_message` — never default to "send anyway."

---

## 7. Environment design

```
REVIEW_REQUESTS_ENABLED=false          # master live-send switch — must be explicitly true to ever POST
REVIEW_REQUESTS_DRY_RUN=true           # secondary explicit gate — both must agree to send live
REVIEW_REQUESTS_MARKETPLACE_ID=A21TJRUUN4KGV
REVIEW_REQUESTS_CATCHUP_DAYS=30
REVIEW_REQUESTS_BATCH_SIZE=300
REVIEW_REQUESTS_RATE_LIMIT_MS=1100
```

Two independent gates (`ENABLED` + `DRY_RUN`) rather than one, so a single misconfigured/forgotten
env var cannot alone flip the system into live sending — both need to be explicitly changed
(`ENABLED=true` and `DRY_RUN=false`) for a real POST to ever fire. This is stricter than the founder's
minimum spec (`REVIEW_REQUESTS_ENABLED=true` only) and is offered as a recommendation, not a
requirement — flagging for approval since it's an addition beyond what was asked.

---

## 8. Cron architecture

- **Where:** Render, as its own dedicated cron job (new service, not appended to
  `easyhome-asin-live-checker`). Keeping it a fully separate script/service avoids any shared-state or
  shared-cadence coupling with the ASIN checker, and keeps this workstream's logs/failures
  independently visible.
- **Recommended schedule:** once daily (e.g. `0 3 * * *`, off-peak UTC) — matches the product decision
  ("daily forward processing"); no need for anything more frequent given Amazon's own eligibility
  window moves in days, not hours.
- **Why it won't conflict with current cron jobs:** it touches a new table
  (`review_solicitation_orders`) and new SP-API endpoints (Orders, Solicitations) that no existing job
  reads or writes — zero table or queue overlap with the ASIN checker (`background_jobs`,
  `asin_snapshots`), Ads sync (`internal_ads_*`), or Business Report sync. Distinct rate-limit budget
  (Solicitations API is a separate Amazon throttle bucket from Pricing/Catalog).
- **Retry/failure visibility:** same convention as `process-asin-checker-jobs.ts` — a single
  aggregate-count JSON summary line per run (`{fetched, upserted, checked, eligible, sent (0 unless
  live), tooEarly, ineligible, failedRetryable, failedTerminal}`), no per-order logging (order IDs are
  not printed per the terminal-output aggregate-only rule).
- **One-time catch-up: a protected route or a manually-invoked script, not a cron job.** Recommend a
  plain `npx tsx scripts/review-request-catchup.ts` script (matching the existing `scripts/*.ts`
  convention), run once manually after founder approval, rather than a route — it should not be
  possible to accidentally trigger via an HTTP request, and it only ever needs to run once (idempotent
  if re-run, per §4.7, but has no reason to be scheduled).

---

## 9. Tests (to define when implementation starts — none written yet)

Plain `scripts/test-*.ts` files, no test framework, matching repo convention
(`test-stuck-job-reclaim.ts`, `test-retry-or-fail-update.ts`, `test-track-asin.ts` as templates):

1. Dry-run mode never calls the POST function, for any eligibility response shape (including a
   crafted "eligible" response) — assert the POST helper is never invoked (spy/counter, not a mock
   that could silently succeed).
2. Live mode requires **both** `REVIEW_REQUESTS_ENABLED=true` and `REVIEW_REQUESTS_DRY_RUN=false` —
   test each single-flag-true combination independently sends nothing.
3. An order with `solicitation_sent=true` is excluded from the due-row query and, even if manually
   passed to the send function directly, is rejected by the pre-POST guard (gate 1, §6).
4. GET eligibility response without `productReviewAndSellerFeedback` → no POST, status set to
   `too_early` or `ineligible_terminal` per Amazon's specific reason code.
5. Two upserts of the same `amazon_order_id` (simulating a re-run of catch-up or overlapping daily
   jobs) never produce two rows and never send twice — exercised against a fake Supabase client
   enforcing the real unique-constraint behavior, same fidelity bar as `test-stuck-job-reclaim.ts`'s
   fake (which simulates the real NOT NULL constraint).
6. Every terminal status (`sent`, `already_solicited`, `expired`, `failed_terminal`,
   `ineligible_terminal`) is excluded from the due-row selection query/logic.
7. Rate limiter: N sequential eligibility checks take ≥ `(N-1) × 1100ms` wall-clock (or a
   fake-timer-based equivalent) — confirms the throttle is real, not a no-op.
8. Two concurrent "workers" (simulated: two calls racing on the same row) — only one succeeds in
   claiming the guarded pre-POST UPDATE; the second sees 0 affected rows and skips, mirroring the
   `test-stuck-job-reclaim.ts` guarded-update test.
9. Amazon "already solicited" style response (however that surfaces — a specific error code or an
   eligibility action already absent) is handled by setting `already_solicited` (terminal), not
   retried, not treated as a hard failure needing alerting.
10. `too_early` handling: an order eligibility-checked before Amazon's window opens is retried later
    (non-terminal, `next_check_at` advanced), not marked failed; an order past Amazon's window
    (`expired`) is terminal and not retried.

---

## 10. Implementation plan — proposed PR sequence

Each PR should be small, reviewed, and merged only on explicit approval, matching this session's
established discipline (PR #24/#26/#28 pattern: code PR opened → founder reviews → merge only when
told → verify live before closing).

1. **PR: Extract shared Amazon-connection helper.** Pulls the duplicated
   `loadWorkspaceConnection`/`loadConnection` logic (currently in `process-next/route.ts` and
   `process-asin-checker-jobs.ts`) into `src/lib/amazon/connection.ts`. Zero behavior change,
   refactor-only, low risk — a prerequisite so review automation doesn't become a third copy.
2. **PR: Migration `059_review_solicitation_orders.sql`** (additive only, per repo migration rule —
   confirmed next free number is `059` via `origin/master`, not `056` as the stale CLAUDE.md note
   says). Table + partial index only, no application code wired to it yet.
3. **PR: Solicitations permission probe.** A read-only `probeSolicitationsAccess()` in
   `spapi-client.ts`, mirroring `probeInboundShipmentsAccess` — calls `GET
   /solicitations/v1/orders/{amazonOrderId}` for one known order, returns ok/statusCode/amazonErrorCode
   only, no PII, no send capability at all in this PR. **Must be run and confirmed successful (or its
   exact failure reported) before PR 5.**
4. **PR: Orders API + Solicitations API client functions.** Add `listOrders`,
   `getSolicitationActionsForOrder`, `createProductReviewAndSellerFeedbackSolicitation` to
   `spapi-client.ts`, following the existing function shape/error-handling convention (no wiring to
   cron/routes yet — pure client functions, unit-testable in isolation with fetch mocked).
5. **PR: One-time catch-up script**, dry-run only, structurally incapable of sending (§4). Requires
   founder approval to actually run against production Amazon data even though it never POSTs, since
   it does make real Orders/Solicitations GET calls.
6. **PR: Daily forward job** (cron-wired), dry-run by default via env gates (§5–§7). Deployed with
   `REVIEW_REQUESTS_ENABLED=false` — running live in dry-run/no-op mode in production is the intended
   first deployment state.
7. **PR: Dry-run reporting** — a small read-only summary (aggregate counts: how many orders are sitting
   in `eligible_dry_run`, by age bucket) so the founder can review real eligibility volume before
   deciding to go live. No new Amazon calls — reads `review_solicitation_orders` only.
8. **Live-enable checklist (not a PR — an operational step):** founder reviews the dry-run report from
   PR 7 over some observation period, then explicitly sets `REVIEW_REQUESTS_ENABLED=true` and
   `REVIEW_REQUESTS_DRY_RUN=false` in Render's env — no code change required to go live, by design.

---

## Open questions for founder decision (not blocking this document, flagged for visibility)

- Exact `too_early` recheck cadence (proposed: daily, same as the main job cycle — no separate
  cadence needed unless Amazon's window is known to open faster than that).
- Whether `failed_retryable` needs a hard max-attempts → `failed_terminal` ceiling (ASIN checker
  precedent exists if wanted).
- Whether the two-flag `ENABLED` + `DRY_RUN` env gate (§7) is wanted, or the single-flag
  `REVIEW_REQUESTS_ENABLED` from the original product decision is preferred as simpler.
