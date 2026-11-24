# Shadow Agent Readiness Audit — 24 November 2026

Base: `origin/master` at `9c7f9e0`. Scope: `esolz-app`, `checker-worker`.
Production evidence was read through the connected Supabase service. No Amazon
reports were created and no Brand Analytics sync or scraping jobs were triggered.
The existing local Ads audit lacked server credentials; its aggregate checks were
executed as read-only SQL instead. Re-run `esolz-app/scripts/audit-shadow-agent-readiness.sql`
for a current snapshot. Historical counts below are evidence, not ongoing guarantees.

## Findings

| Check | Verified result |
| --- | --- |
| Selected Ads profile | Primary, enabled, active; workspace/profile isolated |
| Last accepted Ads day | 2026-11-23, all six report sources |
| Seven-day gate | All six sources clean on each day, November 18–24 |
| Re-upsert campaign rows | 2,361 rows; 14 days; zero duplicate keys; 2,055/2,069 older rows touched |
| Re-upsert advertised-product rows | 7,974 rows; 14 days; zero duplicates; 6,805/6,805 touched |
| Re-upsert targeting rows | 6,625 rows; 14 days; zero duplicates; 5,678/5,678 touched |
| Re-upsert search-term rows | 11,049 rows; 14 days; zero duplicates; 9,359/9,382 touched |
| Brand Analytics | Zero search-term rows; old job and document summaries claim 691,247 |
| Keyword rank | 18 tracked keywords, 15 own-product; latest snapshot November 23, 15:18 UTC |
| Pincode | One active product, two configured active targets; both overdue; last check November 23, 15:15 UTC |
| Existing shadow engine | Initially zero settings, runs, actions |

Re-upsert evidence validates repeated writes and key uniqueness, not a new comparison
against downloaded Amazon source documents. No warehouse ingestion rewrite is warranted.
The audit script now orders pages and requires successful, zero-rejection overlap for
each source in the selected profile; failed or unrelated-profile runs cannot turn it green.

## Brand Analytics root-cause boundary

The sole historical job has `processing_status=DONE`, `sync_status=done`, claimed
stored count 691,247, and retained `store_rows_failed`, `57014`, failed batch 0 metadata.
The document repeats the claimed stored count. The actual table is empty. No row
triggers exist. This proves inconsistent ingestion metadata, not when or why the rows
became absent. Historical deletion/deployment/query logs are needed to establish that.
Do not label the 57014 timeout the proven cause of today's empty table.

Verified code defects fixed: input offsets were derived from row counts; duplicate
ignores were counted as new stored rows; exact zero counts did not override historical
positive summaries in the status response. Recovery now replays from offset zero with
idempotent conflicts, bisects timeout batches to a bounded minimum, and requires an
exact final count. No destructive clear, new report, or automatic recovery was run.
A recovery of the existing document still requires a separately authorized sync and
availability of that old Amazon document; its retention is not assumed.

## Scheduler and decision-input boundary

`master` contains manual keyword refresh and pincode checks plus pincode claim/finalize
RPCs, but no recurring keyword job or consumer invoking the pincode scheduling RPCs.
Vercel's existing product-snapshot cron does not run these scrapers. Recent successful
manual results cannot establish scheduler health. Do not mark unattended tracking ready.
The missing consumers remain a rollout dependency; this PR does not introduce browser
scraping schedules or alter existing scraper cadence.

The shadow runner joins profile-scoped advertised products by campaign/ad group only
when exactly one ASIN is supported in the accepted window. Multi-product groups stay
unknown. Rank joins require that own ASIN, exact normalized keyword, and marketplace.
Competitor/research keywords are excluded. Latest failed/blocked checks override older
success. Rank/pincode freshness is 48 hours; rank comparison history is seven days.
Pincode availability requires configured active targets and complete confirmed coverage;
one confirmed unavailable target flags fulfillment risk. Unknown is never unavailable.

Recommendations retain these signals. Improving organic rank halves the allowed
high-ACOS reduction (maximum 5%); it does not imply that Ads caused the improvement.
No increases are supported. Profit margin, TACOS, inventory, and Buy Box are not inferred
from missing data and are still requirements for any later scaling/autopilot release.

## Activation and rollout

One production settings row was initialized for the verified primary profile:
`enabled=true`, `mode=shadow`, `emergency_stop=true`, max decrease 5%, minimum 15 clicks,
minimum spend 500 in the profile currency, lookback 14 days, cooldown 24 hours,
maximum report age two days. Existing settings would not be overwritten.

The new authenticated cron is daily at 05:30 UTC (11:00 IST), after the observed Ads
sync. It uses the same service as the CLI and becomes scheduled only on deployment.
The previous deployed runner skips while emergency stop is true; no production shadow
run is claimed before this PR is deployed. The new runner refuses approval/autopilot
settings and stores only proposed actions. There is no Amazon write client in this path.
The emergency stop stays engaged for execution; set `enabled=false` to stop shadow output.

Require complete latest successful targeting and product windows, zero rejections,
fresh dates, unchanged coverage during reads, and unchanged settings before inserting.
Idempotent action keys prevent duplicate recommendations from retries. Missing/broken
inputs fail closed or remain unknown. Monitor runs and review evidence for two weeks;
this elapsed validation cannot be replaced by unit tests. Live bid/budget changes remain
gated and are not implemented here.

## Validation

App: 527/527 tests pass, TypeScript and targeted lint clean, production build passes.
Worker: TypeScript build passes and 3/3 timeout/count regression tests pass. Runner integration tests cover tenant isolation,
accepted-window gating, emergency-stop shadow operation and repeated invocation.
Build emits an existing tracing warning in the unrelated stock cost import route.
Locked worker dependencies report existing audit advisories; no broad upgrades made.
No production deploy, new Amazon report, Brand Analytics re-ingestion or live Ads write.
