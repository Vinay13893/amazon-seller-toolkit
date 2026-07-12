-- Amazon India EasyHOME Review Request Automation: persistent state machine
-- and idempotency foundation. Schema only -- no jobs, no cron, no RPC, no
-- Amazon calls, no live sending. See REVIEW_REQUEST_AUTOMATION_SPEC.md and
-- BRAHMASTRA_MASTER_TRACKER.md sec18 for the full design and PR sequence.
--
-- Identity / idempotency:
--   UNIQUE (workspace_id, marketplace_id, amazon_order_id) is the hard
--   DB-level backstop against ever sending twice for the same order, and
--   the same key doubles as the order-lookup index (a UNIQUE constraint
--   already creates its own btree index -- no separate lookup index is
--   added below to avoid an exact duplicate).
--
-- Status model (solicitation_status, enforced by a check constraint):
--   Non-terminal (may still transition):
--     pending                 -- seen via Orders API, not yet eligibility-checked
--     too_early                -- GET eligibility checked; Amazon says not yet eligible
--     not_eligible_retryable   -- GET eligibility checked; no action now, may appear later
--     eligible_dry_run          -- GET showed productReviewAndSellerFeedback; dry-run only,
--                                  did not POST. NON-TERMINAL: any future POST still requires
--                                  a fresh GET immediately before sending -- this status is a
--                                  historical signal, never a cached authorization to send.
--     failed_retryable          -- transient error (429/5xx/network), safe to retry later
--     checking                  -- a worker is mid GET-eligibility-check for this row
--     send_claimed              -- a worker has claimed this row to attempt a POST; see the
--                                  claim fields below. Non-terminal because a claim can expire
--                                  or fail without a send actually happening.
--   Terminal (excluded from all future due-work selection):
--     sent                      -- POST succeeded
--     already_solicited         -- Amazon indicates a solicitation was already sent
--     expired                   -- order aged past Amazon's solicitation window
--     ineligible_terminal        -- Amazon has clearly established a permanent non-eligible
--                                  outcome (e.g. canceled/refunded order) -- NOT the same as
--                                  "productReviewAndSellerFeedback absent this check": absence
--                                  alone must map to not_eligible_retryable or too_early, never
--                                  straight to a terminal status, unless Amazon's response makes
--                                  the permanence explicit.
--     failed_terminal            -- a non-retryable API error after inspection (e.g. bad request)
--
-- Claim / concurrency design (schema only -- no RPC created here):
--   claimed_at / claimed_by / claim_expires_at exist so a future guarded
--   pre-POST claim can be implemented as a single conditional UPDATE
--   (... WHERE solicitation_sent = false AND solicitation_status IN
--   ('eligible_dry_run', ...) ...), mirroring the guarded-update pattern
--   already used by reclaimStuckJob() in the ASIN checker. claim_expires_at
--   lets a future worker safely reclaim a row whose claiming process died
--   mid-send, the same way background_jobs' locked_at + stale-timeout
--   reclaim works today, without needing a fixed in-code cutoff -- the
--   cutoff can be set per-claim. No RPC/function is created in this PR;
--   that guarded UPDATE is deferred to the PR that actually implements
--   sending.
--
-- PII: no buyer name, address, phone, or email column exists, matching the
-- internal_payment_transactions convention. last_eligibility_response is
-- meant to hold only the minimal sanitized eligibility payload (e.g. the
-- list of available action names) for audit/debugging -- a defensive check
-- constraint below rejects a few obviously PII-shaped top-level keys as a
-- best-effort guard; it is not a substitute for the application only ever
-- writing sanitized data here.

create table if not exists public.review_solicitation_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  amazon_order_id text not null,
  marketplace_id text not null,

  order_status text,
  purchase_date timestamptz,
  shipped_at timestamptz,
  amazon_last_updated_at timestamptz,

  first_seen_at timestamptz not null default now(),
  next_check_at timestamptz,
  last_checked_at timestamptz,

  solicitation_status text not null default 'pending',
  solicitation_sent boolean not null default false,
  solicitation_sent_at timestamptz,

  -- Claim fields for a future guarded pre-POST claim (see design note above).
  -- No RPC uses these yet -- columns only.
  claimed_at timestamptz,
  claimed_by text,
  claim_expires_at timestamptz,

  check_attempts integer not null default 0,
  last_eligibility_response jsonb,
  last_error_code text,
  last_error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint review_solicitation_orders_identity_uidx
    unique (workspace_id, marketplace_id, amazon_order_id),

  constraint review_solicitation_orders_status_chk
    check (solicitation_status in (
      'pending', 'too_early', 'not_eligible_retryable', 'eligible_dry_run',
      'failed_retryable', 'checking', 'send_claimed',
      'sent', 'already_solicited', 'expired', 'ineligible_terminal', 'failed_terminal'
    )),

  -- solicitation_sent and solicitation_status='sent' must always agree --
  -- neither can be true/set without the other.
  constraint review_solicitation_orders_sent_status_chk
    check ((solicitation_status = 'sent') = solicitation_sent),

  -- A sent row must always have a sent timestamp (implied by the constraint
  -- above once solicitation_status='sent', but stated explicitly for clarity).
  constraint review_solicitation_orders_sent_at_chk
    check (not solicitation_sent or solicitation_sent_at is not null),

  constraint review_solicitation_orders_send_claimed_chk
    check (
      solicitation_status <> 'send_claimed'
      or (claimed_at is not null and claim_expires_at is not null)
    ),

  constraint review_solicitation_orders_check_attempts_chk
    check (check_attempts >= 0),

  -- Best-effort defense in depth: reject a few obviously PII-shaped top-level
  -- keys. Not exhaustive -- the application is the real enforcement point.
  constraint review_solicitation_orders_no_pii_in_eligibility_chk
    check (
      last_eligibility_response is null
      or not (
        last_eligibility_response ? 'buyerName'
        or last_eligibility_response ? 'BuyerName'
        or last_eligibility_response ? 'buyerEmail'
        or last_eligibility_response ? 'BuyerEmail'
        or last_eligibility_response ? 'buyerPhone'
        or last_eligibility_response ? 'BuyerPhone'
        or last_eligibility_response ? 'shippingAddress'
        or last_eligibility_response ? 'ShippingAddress'
        or last_eligibility_response ? 'BuyerInfo'
      )
    )
);

-- Due-work selection: the daily job's "select due, non-terminal rows" query.
-- Terminal statuses are excluded from the index entirely so it stays small
-- and so a terminal row can never be accidentally selected for new work.
create index if not exists review_solicitation_orders_due_idx
  on public.review_solicitation_orders (workspace_id, marketplace_id, next_check_at)
  where solicitation_status not in (
    'sent', 'already_solicited', 'expired', 'ineligible_terminal', 'failed_terminal'
  );

-- Status/reporting (e.g. the dry-run volume report from spec PR #7).
create index if not exists review_solicitation_orders_status_idx
  on public.review_solicitation_orders (workspace_id, solicitation_status);

-- Sent audit trail. Partial: only rows that actually have a sent timestamp.
create index if not exists review_solicitation_orders_sent_audit_idx
  on public.review_solicitation_orders (workspace_id, solicitation_sent_at)
  where solicitation_sent_at is not null;

-- Order lookup by (workspace_id, marketplace_id, amazon_order_id) is already
-- served by the unique constraint's own index above -- no separate index
-- needed.

alter table public.review_solicitation_orders enable row level security;

-- Read-only for workspace members. No INSERT/UPDATE/DELETE policy is
-- created for the authenticated role: unlike background_jobs (which allows
-- a member-triggered manual "Check Now" insert), nothing in this workstream
-- is user-triggered -- all writes come from server-side automation using
-- the service-role key, which bypasses RLS entirely. This is intentionally
-- more restrictive than background_jobs's policy set.
drop policy if exists "review_solicitation_orders: internal select" on public.review_solicitation_orders;
create policy "review_solicitation_orders: internal select"
  on public.review_solicitation_orders
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));

drop trigger if exists trg_review_solicitation_orders_updated_at on public.review_solicitation_orders;
create trigger trg_review_solicitation_orders_updated_at
  before update on public.review_solicitation_orders
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
