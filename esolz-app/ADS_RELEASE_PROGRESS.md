# Ads implementation progress — 8 November 2026

The founder authorized the proposed Ads roadmap. Existing release constraints
remain: PR #74 is not merged and Production is not deployed.

## Prepared locally

- Report creation preserves Retry-After and respects Amazon's cooldown within
  the existing bounded retry loop. Cooldowns above five minutes defer to the
  next scheduled run. Response bodies are excluded from creation errors.
- Ads health scopes refresh history to the selected workspace and profile.
- Every required report must have a successful refresh within 36 hours.
  Missing tables, failed reports and throttling cannot appear healthy because
  another report has fresh rows. Skipped duplicate runs do not mask evidence.
- The warehouse audit uses stable pagination, excludes today, and counts only
  successful refreshes for the selected profile. It explicitly cannot unlock
  Ads Bleed without independent reconciliation and seven verified days.

## Observed live evidence

The read-only audit found four Sponsored Brands failures in the trailing
14 days, classified as HTTP 429 during report creation. The previous audit
found data through 7 November. This does not establish complete reconciliation.
Retry-After presence on those historical responses is unverified, so the code
change is a reliability improvement, not proof that live throttling is resolved.

## Remaining release work

1. Verify protected Preview and worker rollout for these changes separately
   from the stock-reconciliation PR. Complete that PR's outstanding UI gate.
2. Run the newly implemented independent verifier in the configured worker.
   It compares three random dates across the six reports, preserving existing
   attribution definitions and the selected profile's currency and timezone.
   Five metrics per dataset/date must agree within 2%. Evidence is saved in
   internal_data_refresh_runs under brahmastra_ads_reconciliation. The existing
   structural audit alone does not satisfy this requirement.
3. Observe seven consecutive verified days. No historical green run count
   substitutes for this independent evidence.
4. Implement Ads Bleed and Top 5 with acceptance/dismissal reasons, then Capped
   Winner and measured follow-up, according to APPROVED_BACKLOG.md.
5. Verify the intended enabled profiles with the founder before changing them.

No live Ads reports were requested, profile selections changed, database writes
performed, or campaign/bid/budget changes made during this implementation.

## Reconciliation implementation

- `npm run verify:ads-reconciliation -- --workspace-id=<workspace UUID>`
  requests fresh reports and stores aggregate verification results only.
- Add `--check-config` to validate credentials and the selected profile without
  requesting reports or writing evidence. This local checkout has no runtime
  database/Amazon credentials, so that check currently fails safely.
- Run in the configured worker after the nightly Ads sync completes. Do not
  overlap it with a sync. Allow up to 25 minutes per report, six reports.
- The daily sync default is now 14 days. Existing explicit `--days` arguments
  still take precedence, so inspect the deployed worker command before rollout.
- Authenticated `/api/internal/ads-readiness` reads only the caller's workspace
  and selected profile. The dashboard displays consecutive verified days.
- No schema migration is needed. Live inspection confirmed the existing table
  has the required JSON evidence column and authenticated users have a SELECT
  policy only. The worker uses its existing server credentials for evidence.
- Seven consecutive days are counted by profile calendar date. Repeated runs
  do not advance the streak. A latest failed/running attempt or a gap blocks it.
- The readiness panel is a prerequisite indicator, not an enabled Ads Bleed
  engine. Ads Bleed, Capped Winner, action outcomes and rollout remain pending
  the approved build-order gates.

## Verification

The new reconciliation and reliability suites passed 12 tests. Production build
and targeted lint passed. The build reports an existing tracing warning from
the stock cost-master import route. Live authenticated UI verification and an
independent Amazon comparison have not yet run for this branch.

## Preview follow-up

- Copied the existing stock branch's public Supabase configuration and workbook
  identifier to this Ads branch's Preview scope. No Production values changed.
- A protected Preview of c45b018 returned 404 for unsigned-in readiness requests
  after the configuration fix; the earlier missing-configuration 500 is resolved.
- Readiness now uses the authenticated Supabase client. Live SELECT policies on
  both required tables restrict reads to workspace membership; no service-role
  key is needed by this read-only endpoint. Explicit workspace/profile filters
  remain in place.
- The Render Ads cron still deploys master at 3af7a88 and runs a 14-day sync at
  08:00 IST. Sign-in succeeded, but its web shell remained on Connecting. No
  worker command, deployment, schedule or credentials were changed.
- Latest local production build and all 12 reconciliation/reliability tests pass.
  Signed-in Preview verification and live independent comparisons remain pending.
