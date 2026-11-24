# Brahmastra Ads automation control plane

## Operating loop

1. **Observe:** Ads Reporting provides reconciled daily campaign, advertised
   product, target, search-term and placement facts. Marketing Stream supplies
   the current hourly/daily restatements. Campaign-management APIs supply live
   bids, budgets, state, strategy and placement modifiers. SP-API supplies
   inventory, Buy Box, sales, returns and fees. Keyword tracking supplies
   organic and sponsored position by keyword + ASIN.
2. **Resolve identity:** profile → portfolio → campaign → ad group → target →
   product ad → ASIN/SKU. Never claim a keyword-to-ASIN result when a multi-ASIN
   ad group cannot be resolved to a specific product ad.
3. **Learn:** maintain immutable 90-day baselines plus 30/14/7-day windows by
   entity, ASIN, category and placement. Compare recent performance with its own
   learned range, weekday, seasonality and attribution maturity.
4. **Classify:** `explore`, `scale`, `defend`, `harvest`, `repair`, `waste` or
   `hold`. Low-volume entities borrow category priors but never inherit another
   workspace's data.
5. **Propose:** at most one non-conflicting entity change per cooldown window.
   Every proposal stores evidence, confidence, before-state and rollback data.
6. **Guard:** block on stale/incomplete data, attribution lag, low evidence,
   lost Buy Box, stock risk, profit uncertainty, budget caps or emergency stop.
7. **Experiment:** evaluate the primary metric and guardrails after a fixed
   maturation window. Keep, roll back or mark inconclusive; never silently
   stack changes.
8. **Explain:** show the user what changed, why, evidence used, expected result,
   risk, evaluation date and exact rollback.

## Decision hierarchy

Safety comes before growth:

1. identity and workspace isolation;
2. data freshness and reconciliation;
3. availability, Buy Box and inventory cover;
4. contribution-profit completeness;
5. campaign budget and loss caps;
6. statistically useful evidence;
7. organic rank, sponsored rank, placement and ad efficiency;
8. bounded bid/budget/placement proposal.

No recommendation may optimize ACOS while quietly worsening contribution
profit, returns, stockout risk or organic rank. When purchase cost is missing,
profit-dependent growth actions are held and labelled unavailable.

## Placement logic

Top of Search, Rest of Search and Product Pages are independent performance
surfaces. Brahmastra learns a baseline for each campaign + placement and does
not treat a campaign-average ACOS as proof that a placement modifier should
change. It also prevents a target-bid change and a placement-modifier change in
the same experiment window, because their effects would be confounded.

## Scale and reliability

- queue work by workspace + profile with per-profile rate limits;
- use idempotency keys for reports, Stream versions, proposals and writes;
- process Stream restatements by full dimension key + highest version;
- use dead-letter queues, freshness alerts and reconciliation totals;
- keep browser clients read-only; credentials and writes stay server-side;
- snapshot before every future write, read back after it, and retain rollback;
- cap initial bid changes at 10%, apply a 24-hour cooldown and daily loss caps;
- support allowlisted pilots before account-wide automation.
