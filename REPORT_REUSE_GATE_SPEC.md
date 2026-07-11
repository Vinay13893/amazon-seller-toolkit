# Report Reuse Gate — Audit & Architecture Spec

**Scope:** Inspection and architecture design only. No code changed, no migration created or applied, no
report job modified, no credentials/tokens/profiles/Ads writes/payments/replenishment math touched.
All findings traced to file paths, table names, and line-level behavior in the repo at
`C:\Vinay\amazon-seller-toolkit-clean-sync`, read via `origin/master` (the real production branch — not the
locally-uncommitted `intern/asins-page-work` checkout, which is stale relative to master for report code).

---

## Part 1 — Audit of every current report-fetching workflow

### 1.1 Shared low-level SP-API client (used by 3 of the 4 workflows below)

`esolz-app/src/lib/amazon/reports.ts` — stateless HTTP wrapper: `createAmazonReport`, `getAmazonReport`,
`getAmazonReportDocument`, `downloadAmazonReportDocument`, `parseAmazonReportDocument`. **No reuse-checking
logic of any kind lives here** — it is a pure SP-API Reports API (`/reports/2021-06-30`) client. Any reuse gate
must sit in the calling code (today) or as a new layer wrapping this client (proposed).

### 1.2 Workflow: Business Reports (`GET_SALES_AND_TRAFFIC_REPORT`)

| Attribute | Value |
|---|---|
| Report type | `GET_SALES_AND_TRAFFIC_REPORT` (SP-API) |
| Requesting code path | `esolz-app/scripts/sync-business-reports.ts` (Render cron, daily), calling `esolz-app/src/lib/internal/business-report-sp-api-client.ts` |
| Scope | Single `amazon_connections` row per workspace (auto-selected: prefers the workspace with existing Business Report activity if multiple) |
| Marketplace scope | `--marketplace-id` flag or `connection.marketplace_id` |
| Requested period | Default last 14 days ending yesterday; `--days`/`--date-start`/`--date-end` overridable |
| Checks existing local data? | **No** — never queries `internal_business_report_sales_traffic_daily` / `internal_business_report_sku_sales_traffic` for existing coverage before deciding to fetch |
| Checks previous local report requests? | **Yes** — `findReusableReport()` queries `internal_data_refresh_runs` for a matching `report_request_key` within 6h (`REPORT_REUSE_WINDOW_MS`) |
| Checks Amazon `getReports`/existing provider reports? | **No** — only reuses a report ID **we already recorded**, never queries Amazon's report list independently |
| Duplicate concurrent requests possible? | **Yes, in a narrow race window** — `isSyncLocked()` is a SELECT-then-decide check, not atomic; two near-simultaneous invocations could both pass the lock check before either inserts its `running` row (same TOCTOU class of bug fixed in the Track ASIN work earlier this session) |
| In-progress report reused? | **Yes** — `reusable.amazonReportId` is reused and polled instead of creating a new one |
| Parsed results idempotently upserted? | **Yes** — `upsertByDateRows`/`upsertSkuRows` do select-existing-then-insert-or-update by natural key (`workspace_id, marketplace_id, report_date` for by-date; `workspace_id, marketplace_id, report_date, sku_norm/child_asin/parent_asin` for by-SKU) |
| Freshness/overlap policy | 6h "already succeeded, skip" window; unconditional overlap allowed otherwise (re-requesting overlapping ranges just re-upserts, no conflict) |
| Failure/retry | Stale `running` rows >2h auto-marked `failed` at next run start (`cleanupStaleRuns`); 429 backoff inside `waitForSalesAndTrafficReport`; no automatic re-queue of a `failed` run — next cron invocation naturally re-attempts the same rolling window |

### 1.3 Workflow: Amazon Ads reports (campaign + 3 deep reports)

| Attribute | Value |
|---|---|
| Report types | `spCampaigns`, `sdCampaigns`, `sbCampaigns`, `spAdvertisedProduct`, `spTargeting`, `spSearchTerm` (Ads Reporting API v3, **not** SP-API — separate base URL per region, separate LWA app) |
| Requesting code path | `esolz-app/scripts/sync-ads-reports.ts` (Render cron, daily), calling `esolz-app/src/lib/internal/amazon-ads-reporting-client.ts` |
| Scope | Single Brahmastra-selected Ads profile via `resolveBrahmastraProfile()` — never loops over all connected profiles |
| Marketplace scope | Implicit in the Ads profile/region, not a separate parameter |
| Requested period | Default last 7 days; `--days`/`--from`/`--to`/`--backfill` overridable |
| Checks existing local data? | **No** — same gap as Business Reports |
| Checks previous local report requests? | **Yes** — same `internal_data_refresh_runs` mechanism, `report_request_key`, plus a **second, longer** reuse window: `AMAZON_REPORT_RETENTION_MS` = 30 days (reuses a known report ID even after our own run failed/timed out, since Amazon retains generated reports ~30 days) |
| Checks Amazon `getReports`/existing provider reports? | **No** — same limitation: only reuses report IDs *we* already recorded |
| Duplicate concurrent requests possible? | **Yes, same TOCTOU race** as Business Reports — same lock pattern, same non-atomic check-then-insert |
| In-progress report reused? | **Yes** |
| Parsed results idempotently upserted? | **Yes** — `dedupe_key` unique-index-based upsert per row table (per WORK_DONE_SUMMARY.md, profile-scoped since migration 049) |
| Freshness/overlap policy | 6h success-skip + 30-day Amazon-retention reuse; per-report-type timeout override (SD campaigns: 25 min vs default 15 min) |
| Failure/retry | Same 2h stale-lock cleanup; bounded 429 retry-with-backoff on report **creation** specifically (3 attempts, 30s/90s backoff) — one report type failing never blocks the other 5 |

### 1.4 Workflow: Brand Analytics (SQP / Search Terms / Search Catalog Performance)

| Attribute | Value |
|---|---|
| Report types | `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`, `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`, `GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT` (SP-API) |
| Requesting code path | `esolz-app/src/app/api/amazon/brand-analytics/reports/request/route.ts` (**user-triggered, on demand**, owner/admin role required) + `.../[jobId]/sync/route.ts` (downloads/parses once `DONE`) |
| Scope | Single `amazon_connections` row per workspace |
| Marketplace scope | `marketplaceId` from request body, defaults to `A21TJRUUN4KGV` |
| Requested period | `dataStartTime`/`dataEndTime` from body, defaults to the last completed calendar week (UTC) |
| Checks existing local data? | **No** |
| Checks previous local report requests? | **No — zero reuse logic of any kind.** Every POST unconditionally calls `createAmazonReport`. |
| Checks Amazon `getReports`/existing provider reports? | **No** |
| Duplicate concurrent requests possible? | **Yes, trivially** — a double-click, a retried failed UI request, or two admins independently requesting the same ASIN+week all create separate Amazon reports with no warning. This is the single clearest, most reachable duplicate-request risk found in this audit. |
| In-progress report reused? | **No** — not checked |
| Parsed results idempotently upserted? | **Yes**, once synced — `upsert(..., { onConflict: 'workspace_id,report_id,search_query,asin' })` (or the search-term/catalog equivalents) — but keyed by `report_id`, so two duplicate reports for the same real-world scope produce two independent, non-conflicting sets of rows (no de-dup **across** report_ids for the same logical period) |
| Freshness/overlap policy | **None** |
| Failure/retry | `amazon_report_jobs.error_code`/`error_message` fields exist but nothing in the read code populates a retry path; user must manually re-request |

Registry table: `amazon_report_jobs` (+ `amazon_report_documents`) — migration `012_brand_analytics_reports_foundation.sql`. Unique constraint is `(workspace_id, report_id)` only — since `report_id` doesn't exist until *after* `createAmazonReport` already succeeded, this constraint cannot and does not prevent duplicate creation; it only prevents storing the same completed report twice.

### 1.5 Workflow: Inventory/FBA (`GET_LEDGER_DETAIL_VIEW_DATA`)

| Attribute | Value |
|---|---|
| Report type | `GET_LEDGER_DETAIL_VIEW_DATA` (SP-API) |
| Requesting code path | `esolz-app/src/app/api/internal/stock-actions/fulfillment-report/route.ts` (**user-triggered**, internal-access-gated) |
| Scope | Single `amazon_connections` row per workspace |
| Marketplace scope | `connection.marketplace_id`, defaults `A21TJRUUN4KGV` |
| Requested period | `days` from body (default 30, max 365) → `dataStartTime`/`dataEndTime` computed from "now" |
| Checks existing local data? | **No** |
| Checks previous local report requests? | **No — same zero-reuse pattern as Brand Analytics.** |
| Checks Amazon `getReports`? | **No** |
| Duplicate concurrent requests possible? | **Yes, trivially** — identical risk shape to Brand Analytics |
| In-progress report reused? | **No** |
| Parsed results idempotently upserted? | Not inspected in depth this session (route continues past the `action==='continue'` branch, not fully read) — the `action: 'start'` half that creates the report has no reuse check regardless of downstream upsert behavior |
| Freshness/overlap policy | **None** |
| Failure/retry | `error_code`/`error_message` fields exist on `internal_fba_report_jobs`, same "no automatic retry" pattern as Brand Analytics |

Registry table: `internal_fba_report_jobs` — migration `028_internal_fba_fulfillment_reports.sql`. Structurally
near-identical to `amazon_report_jobs` (same `UNIQUE (workspace_id, report_id)` post-hoc-only pattern).

This report feeds **internal replenishment inputs** (`internal_fba_report_rows`, `event_type='Shipments'`,
per `WORK_DONE_SUMMARY.md`) — replenishment itself does not call any Amazon report endpoint; it only reads
already-stored tables, so it inherits whatever reuse behavior this workflow has rather than needing its own.

### 1.6 Workflow: Settlement / payment-related reports

**No auto-fetch exists.** Confirmed via repo-wide search — zero references to `GET_V2_SETTLEMENT_REPORT_*` or
any Settlement/Finances API call anywhere in `esolz-app/src` or `esolz-app/scripts`. Per `WORK_DONE_SUMMARY.md`
(§"Payment transaction / sales refresh foundation") this was deliberately not built: the exact Seller Central
"Payment Transactions" CSV isn't available as a direct SP-API report, and the closest equivalents (Settlement
Reports API, Finances API) would need new credential scope + a new parser. **Manual CSV import
(`esolz-app/src/app/api/internal/stock-actions/payment-transactions/import/route.ts`) is the only path today** —
confirmed zero `createReport`/`createAmazonReport` calls in that file. Not in scope for a reuse gate yet, but
the policy registry below is designed so this workflow can be added later without a new architecture.

### 1.7 Not a report-fetch workflow (excluded, noted for completeness)

`esolz-app/src/app/api/reports/generate/route.ts` — generates a **Brahmastra-internal CSV export** from
already-stored Supabase data (`asin-performance`, `bsr-movement`, etc.) via `generateReportData()`. It never
calls Amazon. Matched an early keyword search but is out of scope for this gate.

### 1.8 Summary of registry fragmentation

Three separate, structurally-incompatible registry tables already exist for the same underlying problem:

| Table | Used by | Has reuse logic? | Uniqueness |
|---|---|---|---|
| `internal_data_refresh_runs` | Ads sync, Business Report sync (cron scripts) | **Yes** — 6h/30-day windows, concurrency lock, stale-run cleanup, string-built `report_request_key` | none enforced at DB level (index only, not a constraint) |
| `amazon_report_jobs` + `amazon_report_documents` | Brand Analytics (on-demand UI) | **No** | `(workspace_id, report_id)` — post-hoc only |
| `internal_fba_report_jobs` | FBA Ledger (on-demand UI) | **No** | `(workspace_id, report_id)` — post-hoc only |

**No workflow anywhere checks trusted local data coverage before requesting** (`LOCAL_DATA_REUSE` does not
exist today), and **no workflow queries Amazon's own report list** (`PROVIDER_REPORT_REUSE` as "ask Amazon what
it already has" does not exist today — the closest analog, the Ads/Business-Report 30-day reuse window, still
depends entirely on *our own* prior memory of a report ID, not a live Amazon query).

---

## Part 2 — Central Report Reuse Gate design

### 2.1 Canonical request fingerprint

```ts
interface ReportRequestFingerprint {
  workspaceId: string
  provider: 'spapi' | 'ads_api'
  accountScope: {
    // SP-API: amazon_connections.id (one seller account per workspace today,
    // but the field exists so multi-account isn't a later migration).
    // Ads API: amazon_ads_profiles.id (profile_id).
    kind: 'seller_account' | 'ads_profile'
    id: string
  }
  reportType: string          // e.g. 'GET_SALES_AND_TRAFFIC_REPORT', 'spCampaigns'
  marketplaceIds: string[]    // sorted, deduped, for a stable hash
  periodStart: string         // normalized to UTC date or ISO instant per policy (below)
  periodEnd: string
  reportOptionsHash: string   // stable hash of a canonicalized (sorted-keys) reportOptions object
}
```

**Fingerprint hash** = a stable hash (e.g. SHA-256, hex, truncated to 32 chars for a DB column) over the
canonical JSON serialization of the above (marketplaceIds sorted, reportOptions keys sorted, dates normalized
to a single format). This replaces the current ad-hoc pipe-joined `report_request_key` strings, which are
already *conceptually* the same idea (see `sync-business-reports.ts`'s
`` `${workspaceId}|${marketplaceId}|${reportType}|${dateStart}|${dateEnd}|DAY|SKU}` `` and the Ads sync's
equivalent) — this design generalizes and centralizes what two workflows already do independently, rather than
inventing something new.

### 2.2 Decision state machine

```
                 ┌─────────────────────┐
                 │  incoming request    │
                 │  (fingerprint built) │
                 └──────────┬───────────┘
                            │
                 1. normalized data covers scope?
                            │yes                 │no
                            ▼                    │
                  LOCAL_DATA_REUSE                │
                  (serve from our tables,         │
                   0 API calls)                   │
                                                   ▼
                 2. matching completed report row in our registry
                    (status=success, within freshness TTL)?
                            │yes                 │no
                            ▼                    │
                  LOCAL_REPORT_REUSE              │
                  (re-parse/re-upsert from        │
                   the document we already have,  │
                   0 new Amazon API calls)         │
                                                   ▼
                 3. matching row already queued/processing
                    (status in running/IN_QUEUE/IN_PROGRESS)?
                            │yes                 │no
                            ▼                    │
                  WAIT_FOR_EXISTING               │
                  (poll/attach to that job         │
                   instead of creating a new one)  │
                                                   ▼
                 4. Amazon has a usable completed report
                    for this fingerprint (getReports lookup,
                    createdSince within provider retention)?
                            │yes                 │no
                            ▼                    │
                  PROVIDER_REPORT_REUSE           │
                  (skip create, go straight       │
                   to document download)          │
                                                   ▼
                 5. is the requested period stale/partial per
                    policy (e.g. an immutable closed period
                    already has a report, or scope doesn't
                    meet minimum-quality checks)?
                            │yes                 │no
                            ▼                    ▼
                  REJECT_STALE_OR_PARTIAL    CREATE_NEW
                  (no request made,          (call createAmazonReport /
                   caller told why)           requestAdsReport; this is
                                               the ONLY branch that spends
                                               an upstream report slot)

  Any unrecoverable error at any step → FAILED (recorded with the safe
  reason, existing registry row updated, no retry storm — mirrors the
  existing cleanupStaleRuns() pattern already proven in production).
```

Every state transition is recorded (not just the terminal one) so the Observability section below has real
counts to work from, and so `WAIT_FOR_EXISTING` can distinguish "waited then reused" from "waited then the
existing job failed, fell through to CREATE_NEW."

### 2.3 Per-report-type policy registry

A single, versioned config object (not a database table — the policy is code, not data, mirroring how
`REPORT_DEFS` already works in `sync-ads-reports.ts`) keyed by `(provider, reportType)`:

```ts
interface ReportTypePolicy {
  provider: 'spapi' | 'ads_api'
  reportType: string
  freshnessTtlMs: number            // LOCAL_REPORT_REUSE / LOCAL_DATA_REUSE window
  overlapWindowDays: number         // how much of a requested range may already be covered
                                     // by an adjacent/overlapping prior request before treating
                                     // it as a fresh request anyway (attribution windows, e.g.
                                     // Ads Bleed's day −17→−3 requirement, must never be silently
                                     // narrowed by an overly generous reuse)
  immutableAfterDays: number | null // e.g. settlement periods that Amazon will never revise
                                     // once closed — always LOCAL_DATA_REUSE if we have them,
                                     // never re-fetched regardless of TTL
  allowSupersetMatch: boolean       // may a prior WIDER request satisfy this NARROWER one?
                                     // (e.g. a 30-day Business Report already covers a 7-day ask)
  minQualityChecks: {
    minRowCount?: number
    requiredFields?: string[]
  }
  parserVersion: string             // bump forces CREATE_NEW even if a matching row exists,
                                     // so a parser bugfix doesn't silently keep serving old
                                     // mis-parsed data via LOCAL_REPORT_REUSE
}
```

Starting values, derived from what's **already proven correct in production** (not invented):

| provider/reportType | freshnessTtl | overlap | immutable | superset OK |
|---|---|---|---|---|
| spapi / GET_SALES_AND_TRAFFIC_REPORT | 6h (existing `REPORT_REUSE_WINDOW_MS`) | 0 (Amazon revises recent days) | null | yes |
| ads_api / spCampaigns, sdCampaigns, sbCampaigns, deep reports | 6h success-skip **and** 30d Amazon-retention reuse (existing) | 0 | null | yes |
| spapi / Brand Analytics (3 types) | proposed 6h (currently none) | 0 | null | yes (superset week ranges rare but harmless) |
| spapi / GET_LEDGER_DETAIL_VIEW_DATA | proposed 6h (currently none) | 0 | null | yes |
| spapi / settlement (future) | proposed: TTL = 0 once a settlement period is closed (`immutableAfterDays`), else short TTL while open | n/a | yes, once closed | yes |

### 2.4 Concurrency protection

Today's pattern (SELECT for `status='running'`, then decide, then INSERT) is not atomic — a genuine TOCTOU gap,
the same class of bug already found and fixed in `tracked_asins` this session (archive/reinsert race). The
gate must close this properly, not just reduce the odds:

- **Enforce, don't just check.** A partial unique index on the registry table:
  `UNIQUE (fingerprint_hash) WHERE status IN ('running', 'queued')`. A second concurrent request attempting to
  insert its own `running` row for the same fingerprint gets a Postgres `23505` and transitions straight to
  `WAIT_FOR_EXISTING` — the same "catch the constraint violation, resolve from current state" pattern already
  built and tested in `addOrRestoreTrackedAsin` (`esolz-app/src/lib/supabase/asins.ts`) this session. Reusing a
  proven pattern rather than a new one.
- Only the request that successfully inserts the `running` row may call `createAmazonReport`/`requestAdsReport`
  — this is what "only one request per fingerprint may create an upstream report" means concretely.
- Stale-lock cleanup (>2h, mirroring `cleanupStuckJobs()`/`cleanupStaleRuns()` already in production) remains
  necessary — the cron-verification session earlier found a live example of what happens without a reliable
  reclaim (10 stuck `background_jobs` rows from the still-active Render worker). The reuse gate must not repeat
  that failure mode: stale-row reclaim needs to be provably running, not just present in code (see §4, next).

### 2.5 Security

- **No credentials exposed**: the gate never stores `accessToken`/`refreshToken` — it only stores fingerprints,
  statuses, and Amazon-assigned IDs (`reportId`, `reportDocumentId`), exactly like the three existing registry
  tables already do correctly today. No change needed here, just preserved.
- **No reusable storage of expiring pre-signed URLs**: `AmazonReportDocumentResult.url` (from
  `getAmazonReportDocument`) is a short-lived pre-signed S3 URL. It must **never** be written to the registry
  table — only `reportDocumentId` (stable) should be persisted; the URL is fetched fresh, used once, and
  discarded, exactly as `downloadAmazonReportDocument` already does today. The gate must not introduce a new
  cache of these URLs.
- **Encrypted handling for sensitive report content**: reports containing anything beyond aggregate metrics
  (none of the audited workflows currently store raw report bytes at rest — all parse-then-discard into
  structured tables) should continue that pattern. If a future report type needs raw-content caching for
  `LOCAL_REPORT_REUSE` to avoid re-downloading, that content must be encrypted at rest using the existing
  `SPAPI_ENCRYPTION_KEY`/`encryptToken`-style primitives already in `esolz-app/src/lib/amazon/crypto.ts` — not
  a new encryption scheme.
- **Workspace/account isolation**: every fingerprint includes `workspaceId` and `accountScope.id` as first-class
  fields (not inferred from a join), and the registry table's RLS must mirror the existing
  `internal_data_refresh_runs`/`amazon_report_jobs` pattern (service-role write, workspace-scoped
  authenticated read gated to Internal Tester accounts) — no change in isolation posture, just consistent
  enforcement across a table that today is fragmented three ways.

### 2.6 Observability

Minimum counters, one row per gate decision (not aggregated in application memory — durable, queryable):

- `reports_reused_local_data` (LOCAL_DATA_REUSE count)
- `reports_reused_local_report` (LOCAL_REPORT_REUSE count)
- `reports_waited_for_existing` (WAIT_FOR_EXISTING count, plus outcome: resolved-reused vs resolved-created-after-failure)
- `reports_reused_provider` (PROVIDER_REPORT_REUSE count)
- `reports_created` (CREATE_NEW count — this is the only number that maps 1:1 to actual Amazon API report-creation calls)
- `reports_rejected_stale_or_partial` (REJECT_STALE_OR_PARTIAL count, with reason)
- `reports_failed` (FAILED count, with safe reason — mirrors existing `error_message` fields)
- **API calls saved** = `reports_reused_local_data + reports_reused_local_report + reports_reused_provider +
  (WAIT_FOR_EXISTING outcomes that avoided a create)` — directly answers "how much duplicate-request risk did
  this prevent," the same shape of number the cron-verification audit already computes for the ASIN snapshot
  pipeline's throughput (this session's prior task), so reporting stays consistent across subsystems.
- **Cost/rate-limit impact**: since Amazon Ads and SP-API Reports both enforce per-account rate limits (already
  the reason `sync-ads-reports.ts` has 429 backoff), every avoided `CREATE_NEW` is a direct reduction in
  exposure to the 429/cooldown class of failure this session's cron audit already documented in depth for the
  ASIN snapshot pipeline (§16 of the tracker) — the gate is this problem's general-purpose fix, not a one-off.

---

## Part 3 — Can an existing table act as the registry?

**Partially — `internal_data_refresh_runs` is the strongest existing candidate**, but none of the three
existing tables is sufficient as-is:

- It already has: `workspace_id`, `source`, `status` (with a `skipped` state already added), `date_from`/
  `date_to`, `started_at`/`finished_at`, `profile_id` (Ads), `marketplace_id`/`report_type`/`report_options`/
  `report_document_id` (Business Reports), and — critically — `report_request_key`/`amazon_report_id` already
  built for exactly this purpose (migration 050).
- What it's **missing** for a fully generic gate: a `provider` column (today inferred from the `source` string
  by convention, not stored explicitly); a structured/hashed fingerprint instead of an ad-hoc per-script string
  (risk of two workflows building slightly different key formats and silently failing to reuse each other's
  work — not observed as a live bug today since Ads and Business Reports don't overlap in report type, but a
  latent risk); and the atomic partial-unique-index concurrency guarantee described in §2.4 (today's lock is
  application-level only).
- `amazon_report_jobs` and `internal_fba_report_jobs` are **not** suitable as the central registry as-is — they
  have no reuse columns at all and are structurally near-duplicates of each other (same
  `UNIQUE (workspace_id, report_id)`-only pattern). The cleanest path is for Brand Analytics and FBA to start
  writing into the **same** central registry `internal_data_refresh_runs` uses (or its successor), while
  keeping their existing job/document tables for what they're good at today (storing the human-facing job
  status and downloaded document metadata) — the registry decides reuse; the job tables keep recording outcomes.

### Migration (proposed, NOT created or applied)

If/when implementation begins, an additive migration on `internal_data_refresh_runs` would likely be needed:

```sql
-- PROPOSED — not applied. For review only.
alter table public.internal_data_refresh_runs
  add column if not exists provider text,                 -- 'spapi' | 'ads_api'
  add column if not exists fingerprint_hash text;          -- stable hash of the canonical fingerprint

create unique index if not exists internal_data_refresh_runs_fingerprint_inflight_uidx
  on public.internal_data_refresh_runs (fingerprint_hash)
  where status in ('running', 'queued');                   -- the atomic concurrency guarantee from §2.4

create index if not exists internal_data_refresh_runs_fingerprint_recent_idx
  on public.internal_data_refresh_runs (fingerprint_hash, started_at desc)
  where fingerprint_hash is not null;                       -- fast LOCAL_REPORT_REUSE lookups
```

Brand Analytics and FBA would additionally need either (a) a thin adapter that writes a matching row into
`internal_data_refresh_runs` alongside their existing `amazon_report_jobs`/`internal_fba_report_jobs` insert, or
(b) a follow-up migration adding the same reuse columns directly to those two tables. Option (a) is smaller and
reversible; recommended as the first step. **No migration is being created or applied as part of this task.**

---

## Part 4 — Recommended implementation sequence (not implemented)

1. **Extract a shared fingerprint-builder function** (`buildReportFingerprint()`) — pure, no DB/network calls.
   Zero risk, no migration, immediately makes the existing ad-hoc `report_request_key` strings in
   `sync-ads-reports.ts`/`sync-business-reports.ts` consistent, and is a prerequisite for everything else.
2. **Build the gate as a new module** (`src/lib/reports/report-reuse-gate.ts`, name illustrative) implementing
   the state machine in §2.2, initially reading/writing `internal_data_refresh_runs` as-is (no migration yet) —
   proves the design against the two workflows that already have partial reuse logic before touching the two
   that have none.
3. **Migrate Business Reports and Ads sync onto the gate first** (lowest risk — they already have equivalent
   logic; this is a refactor to a shared implementation, not new behavior) and delete the duplicated
   `findReusableReport`/`isSyncLocked`/`cleanupStaleRuns` implementations once the gate covers their exact
   behavior, verified against production logs the same way the ASIN cron work was verified this session.
4. **Apply the proposed migration** (§3) once the gate module is proven, to get the atomic concurrency
   guarantee and the `provider`/`fingerprint_hash` columns.
5. **Migrate Brand Analytics and FBA onto the gate** — this is where real, new duplicate-request protection
   gets added (today: zero), and is the highest-value, highest-risk step since it changes live user-facing
   behavior (a double-click will now say "already requested" instead of silently creating a second report).
6. **Add settlement/payment auto-fetch through the gate from day one**, if/when that work is ever approved —
   avoids ever having a fifth ad-hoc reuse implementation.

Each step is independently revertible and independently observable via the counters in §2.6.

---

## Appendix — Files read for this audit

`esolz-app/src/lib/amazon/reports.ts`, `esolz-app/scripts/sync-business-reports.ts`,
`esolz-app/src/lib/internal/business-report-sp-api-client.ts`, `esolz-app/scripts/sync-ads-reports.ts`,
`esolz-app/src/lib/internal/amazon-ads-reporting-client.ts`,
`esolz-app/src/app/api/amazon/brand-analytics/reports/request/route.ts`,
`esolz-app/src/app/api/amazon/brand-analytics/reports/[jobId]/sync/route.ts`,
`esolz-app/src/app/api/internal/stock-actions/fulfillment-report/route.ts`,
`esolz-app/src/app/api/reports/generate/route.ts`,
`esolz-app/src/app/api/internal/stock-actions/payment-transactions/import/route.ts`,
`esolz-app/supabase/migrations/046_internal_data_refresh_runs.sql`,
`esolz-app/supabase/migrations/049_amazon_ads_profile_isolation.sql`,
`esolz-app/supabase/migrations/050_ads_sync_lock_and_report_reuse.sql`,
`esolz-app/supabase/migrations/053_business_report_sp_api_sync.sql`,
`esolz-app/supabase/migrations/012_brand_analytics_reports_foundation.sql`,
`esolz-app/supabase/migrations/028_internal_fba_fulfillment_reports.sql`, `WORK_DONE_SUMMARY.md`,
`BRAHMASTRA_MASTER_TRACKER.md` (origin/master).
