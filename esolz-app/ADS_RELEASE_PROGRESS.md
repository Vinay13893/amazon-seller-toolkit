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
2. Compare three days against freshly generated Amazon reports using matching
   profile, currency and attribution. Persist reconciliation evidence and
   enforce the discrepancy threshold. The existing structural audit alone
   does not satisfy this requirement.
3. Observe seven consecutive verified days. No historical green run count
   substitutes for this independent evidence.
4. Implement Ads Bleed and Top 5 with acceptance/dismissal reasons, then Capped
   Winner and measured follow-up, according to APPROVED_BACKLOG.md.
5. Verify the intended enabled profiles with the founder before changing them.

No live Ads reports were requested, profile selections changed, database writes
performed, or campaign/bid/budget changes made during this implementation.
