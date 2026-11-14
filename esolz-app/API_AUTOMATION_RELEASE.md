# API automation transition — 12 November 2026

## Release authorization update

The user subsequently requested "update this and stock also live", authorizing the dashboard and Stock Reconciliation Production release. Earlier no-Production notes below describe the previous gate. Finance activation remains separate and unavailable in this website release. Production Stock credentials are scoped to the same existing read-only Google service account; the release build runs `scripts/verify-stock-release.mjs` before Next.js to fail closed on a broken source connection. No PR merge or worker redeployment is needed for this exact-commit website release.

## Implemented for Preview

- Eleven manual import HTTP endpoints now authorize the workspace then return 410. Unauthorized callers still receive 404. They no longer parse files, read local report directories or write rows. Historical data is retained.
- Internal Dashboard opens a simple Ads & Sales / Stock Reconciliation navigation page. The legacy upload-driven stock dashboard is no longer the entry page.
- Ads defaults to the latest 14 India calendar days. View latest Ads data uses Ads freshness alone, immediately loads the range, and uses a preceding equal-length comparison period.
- Data & Sync shows workspace/profile-scoped run status for all six Ads datasets, Sales & Traffic and Finance. Refresh status reads saved state; it does not invoke Amazon.
- The overview does not substitute historical settlement uploads for missing Sales & Traffic. Settlement analysis is explicitly unavailable until API figures are reconciled.
- Purchase costs, supplier bills and off-Amazon stock are unavailable by the user's instruction. Actual profit/off-Amazon replenishment are not exposed on the replacement landing page. Existing worksheet output is retained read-only and is not newly certified as current.
- New Finance API collector reads v2024-06-19 listTransactions, with India scope, bounded windows, empty-page pagination, throttling/retries, token refresh and transaction-ID upserts. A separate ledger avoids double counting against CSV records. It stores net transaction amounts, not invented gross-sales/fee/tax allocations; no descriptions, buyer data or raw payloads are saved.
- New ledger migration has workspace RLS, authenticated read-only access, service-only writes and an atomic per-workspace/marketplace running-job constraint.

## Live evidence observed before this release

- Six Ads sync sources succeeded on 12 November, through 11 November.
- The independent Ads comparison succeeded; the seven-day readiness requirement remains in force.
- Sales & Traffic succeeded for 10 November. The 11 November attempt failed because the Amazon response lacked that day's by-date row. Existing logic rejects that response and retries unconfirmed dates on later scheduled runs.

## Validation and rollout gates

- 39 focused tests passed (Finance API behavior, dates, Ads reconciliation and Business Report grain/completeness).
- Next production build passed. Existing broad-file-tracing warning remains in the pincode integration, outside this change.
- Finance migration is NOT applied. Finance worker is NOT deployed or scheduled. Its Amazon Finance and Accounting authorization has NOT been tested live.
- To activate after review: apply the ledger migration; run the worker with an explicit workspace and `--days=1 --dry-run`; inspect safe counts; run ingestion and compare representative transaction totals/statuses with Amazon; add the worker to an approved schedule. Default rolling window is 30 days; older deferred status corrections require a deliberate longer rescan (maximum 180 days/request).
- Do not mark net Finance transaction receipts as product sales. Detailed fee/refund/product allocation and its downstream diagnostic replacement still require implementation and reconciliation before settlement analysis can be enabled.
- Ads change-history API access is not verified. The historical view is retained; new manual imports are retired and absence is labelled unavailable.
- The Google workbook, working Apps Script and Amazon campaigns remain unchanged. No Production website release or PR merge is authorized in this task.

## Reference

Amazon Finance API: https://developer-docs.amazon/sp-api/docs/finances-api
API model: https://github.com/amzn/selling-partner-api-models/blob/main/models/finances-api-model/finances_2024-06-19.json
