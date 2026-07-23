# SKU Performance P1-B -- SQL test suite

Committed, repeatable correctness tests for migration
`065_sku_performance_p1b_rpcs.sql`'s two RPCs
(`get_sku_performance_summary`, `get_sku_performance_daily`). Adapted
directly from `esolz-app/supabase/tests/pincode-p0a/` -- same safety
posture, same bootstrap approach, same "no flag to override any check"
design.

## What this proves

- The canonical cross-source SKU universe (sales-only/Ads-only/catalog-only
  SKUs all stay visible; a missing catalog match never hides real spend).
- Displayed raw-SKU precedence (catalog > Business Report > Ads > cost
  master) and `identity_conflict` detection (ASIN mismatch).
- Ads rows are aggregated to SKU/day *before* joining Sales -- three
  campaign-level rows for one SKU/day sum correctly and never multiply the
  sales side.
- The five-state coverage model's exact deterministic order
  (`REPORTED_VALUE` > `BEFORE_HISTORY` > `CONFIRMED_ZERO` >
  `SOURCE_NOT_COMPLETE` > `UNKNOWN`), including the "a later failed retry
  never erases an earlier successful run's `CONFIRMED_ZERO`" rule and the
  manual-CSV-shaped gap (no refresh-run row at all -> `UNKNOWN`, never
  `CONFIRMED_ZERO`).
- Base sales/spend trend states, the Attention-status flags, and the
  ACOS/TACOS zero-denominator truth table.
- Pagination and summary-count separation: summary totals and
  growing/declining counts are identical regardless of `p_limit`, proving
  they are full-filtered-scope aggregates, never derived from the current
  page.
- Filters narrow the set before pagination; sort order is deterministic.
- Currency-mismatch rejection, cross-workspace isolation, cross-marketplace
  isolation (including that `internal_ads_advertised_product_daily_rows`
  has no `marketplace_id` column of its own and must be scoped via
  `amazon_ads_profiles`).
- Every hard parameter ceiling on both RPCs is actually enforced.
- A representative-volume EXPLAIN ANALYZE check (500 SKUs x 90 days) that
  the underlying scans hit the existing workspace-prefixed indexes rather
  than an unbounded sequential scan.

## What this deliberately does NOT test

Unlike `pincode-p0a`, there is no `concurrency.sh` phase here: both RPCs
are pure reads with no claim/finalize-style row locking, so there is no
concurrent-mutation race condition analogous to pincode's claim contention
to exercise.

## Running

```
cd esolz-app/supabase/tests/sku-performance-p1b
./run-tests.sh                  # local socket, current OS user
PGHOST=localhost PGUSER=postgres ./run-tests.sh
./run-tests.sh --self-test      # exercises the safety gates only, touches no DB
```

Same safety gates as `pincode-p0a/run-tests.sh` (loopback-only connection,
disposable-named scratch database, no override flag) -- see that script's
own header comment for the full "why the connection cannot resolve
remotely" reasoning, which applies here unchanged.
