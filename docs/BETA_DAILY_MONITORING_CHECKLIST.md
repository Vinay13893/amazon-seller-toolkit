# Beta Daily Monitoring Checklist

Run this once daily during first beta rollout.

## Daily Checks
- [ ] Check count of new users onboarded.
- [ ] Check Amazon connection success for new users.
- [ ] Check listing sync completed for active beta users.
- [ ] Check keyword refresh success rows for latest runs.
- [ ] Check Buy Box snapshot rows are being generated.
- [ ] Check BSR refresh rows for latest ASIN actions.
- [ ] Check pincode rows for null/failed statuses and trends.
- [ ] Check alerts for false positives (especially critical severity).
- [ ] Check Render worker health (availability, runtime errors, queue delays).
- [ ] Check Vercel errors for rising API/runtime failures.
- [ ] Check latest Supabase rows manually for core tables:
  - tracked_asins
  - asin_snapshots
  - tracked_keywords
  - keyword_rank_snapshots
  - buybox_snapshots
  - pincode_checks
  - alerts
- [ ] Note issues in daily log with severity and owner.

## Daily Summary Template
- Date:
- Active beta users:
- New users today:
- Core success rates (keyword, BSR, buybox, pincode):
- False alerts observed:
- Top 3 issues:
- P0/P1 incidents:
- Actions for next day:

## Escalation Trigger (Daily)
Escalate immediately if any condition is true:
- Repeated P0 incident in core flow.
- More than 20% failures in any core refresh path.
- New false critical alert pattern affecting multiple users.
