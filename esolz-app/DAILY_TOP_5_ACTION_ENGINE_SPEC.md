# Daily Top 5 Actions Engine — Spec (v1.1, Fable red-team guardrails applied)
**Status:** APPROVED SPEC — do not build yet. Docs only. No DB changes, no sync changes, no Ads API write endpoints.
**Updated:** 2026-07-07

## Core thesis
Brahmastra is a **decision engine, not a dashboard**. The product's unit of value is a correct, safe, explainable recommended action — not a chart.

**Core loop:** sync → diagnose → recommend → act → measure.

Every card the engine emits must survive this test: "If the seller does exactly this and it's wrong, how much money is lost, and would the card have warned them?"

## V1 action categories
1. **Ads Bleed** — spend with no acceptable return; recommend pause/reduce.
2. **Capped Winner** — profitable campaign/target constrained by budget; recommend raise.
3. **Buy Box Loss** — we lost the Buy Box on a tracked ASIN.
4. **Listing Down** — listing suppressed/inactive/unavailable.
5. **Margin Anomaly** — realized margin diverges from expected for an ASIN.

**Stockout Risk is Phase 2 — deferred, NOT deleted.** It re-enters after Settlement→ASIN P&L and inventory freshness are trustworthy.

## Global guardrails (apply to every rule)
- **Freshness gate:** any snapshot-based rule (Buy Box Loss, Listing Down) requires underlying snapshot ≤ **6 hours** old. Stale input → no card, log `suppressed_stale_input`.
- **Sync Health precondition:** a rule only runs if its data sources are green in the Sync Health Layer. Broken sync must never manifest as a business recommendation (e.g., missing ads rows ≠ "spend dropped").
- **States:** `proposed → approved → acted → measured`, plus `dismissed`, `expired`, `suppressed_*`. Add **`needs_client_approval`**: mandatory intermediate state before any action on Sage Royal / Keshananda workspaces — internal EasyHOME may auto-skip it; client workspaces may not.
- **Founder QA gate:** for **weeks 1–2** after go-live, Vinay reviews the full queue every morning before cards become visible. A card unreviewed by 10:00 IST stays hidden. Exit criteria: 2 consecutive weeks with false-positive rate <10%.
- **Per-card "before you act" checklist:** every card renders 2–4 rule-specific checks the human confirms (see per-rule sections). Checklist confirmation is logged with the action.
- **Dismiss reason taxonomy (required on every dismiss):**
  - `already_known` — seller was already aware/handling it
  - `data_wrong` — underlying numbers are incorrect (auto-flags the rule + source for review)
  - `deliberate_strategy` — e.g., launch spend, ranking push
  - `too_risky` — agree with diagnosis, won't take the action
  - `bad_timing` — deal week, festival, stock constraints
  - `duplicate` — same issue already surfaced
  - `other` (free text, discouraged)
  `data_wrong` dismissals feed directly into fixture tests.
- **Known-false-positive fixture tests:** every rule ships with a fixture suite of real historical cases where the naive rule fires wrongly. A rule cannot leave shadow mode until its fixtures pass. Fixtures grow from every `data_wrong` / `deliberate_strategy` dismissal.
- **No autonomous writes in V1.** The engine recommends; humans act. Ads API write endpoints are out of scope for this spec.

## Rule specs

### 1. Ads Bleed
- **Evaluation window: day −17 to day −3.** Never day −2 to day 0. Amazon ads attribution back-fills for up to ~72h; the last 3 days always understate sales and would systematically recommend pausing profitable targets.
- **Hard rule: never use the last 3 days of ads data for a bleed recommendation.** Fixture test enforces this.
- **Data dependency:** ads warehouse must **re-upsert the trailing 14 days nightly** so late attribution lands. Bleed cards are blocked unless the trailing-14d re-upsert correctness check (build item #2) is green for the window.
- **Minimum evidence:** clicks in window ≥ **max(20, 3 ÷ expected CVR)** for the target. Below that, statistical noise — no card. Expected CVR from the ASIN's trailing 90d, falling back to category default.
- **Recommendation:** pause or bid-down; card shows spend, sales, clicks, window dates, and the counterfactual ("₹X spend, 0 orders across N clicks where ~M expected").
- **Before-you-act checklist:** (1) not a launch/ranking campaign? (2) no deal/event inside the window? (3) attribution window fully closed (window ends ≥ day −3)?
- **Fixtures:** late-attribution case (target looks dead at day −2, profitable at day −5); low-click noise case; deal-week spike case.

### 2. Capped Winner
- **This rule spends money — tightest guardrails of the five.**
- **Max recommended budget increase: +25%** per card, per campaign, per week. Never compound within a week. No "double it" cards ever.
- **Skip deal weeks:** if the evaluation window overlaps a deal/event/festival flag, do not emit — performance during deals does not predict baseline.
- **Measure marginal ACOS, not average:** justification must use performance in lost-impression-share hours / budget-capped periods, not campaign lifetime averages. Card must state expected marginal ACOS of the incremental spend.
- **Follow-up is mandatory:** an accepted card auto-creates a `measured` check at +7 days comparing realized marginal ACOS vs predicted; misses feed fixtures.
- **Before-you-act checklist:** (1) inventory can absorb +25% sales velocity? (2) no upcoming deal that will consume the budget anyway? (3) margin per unit confirmed positive?
- **Fixtures:** deal-week winner (looks capped, isn't); low-inventory winner (raise would cause stockout); average-vs-marginal divergence case.

### 3. Buy Box Loss
- **Default recommendation: "investigate" — never "match price".** Auto-price-matching against a hijacker or Amazon retail is a margin-destruction loop; the engine must not suggest reflexive price cuts.
- **Hijacker risk check:** card must classify the winning offer: Amazon retail / known FBA competitor / new-unknown seller (potential hijacker). New-unknown seller → card escalates to "possible hijacker — verify authenticity, consider report" and explicitly warns against price matching.
- **Freshness gate:** buy-box snapshot ≤ 6h old, and ≥2 consecutive observations of loss (single-poll blips don't fire).
- **Ships in shadow/investigate mode** per build order item #6 — cards visible to founder QA only until precision proven.
- **Before-you-act checklist:** (1) who holds the Buy Box now? (2) is our offer active and in stock? (3) price gap vs winner? (4) hijacker classification reviewed?
- **Fixtures:** Amazon-retail-wins case (no action available); out-of-stock-self case (root cause is stock, not price); single-poll flicker case.

### 4. Listing Down
- **SP-API cross-confirmation required before emitting.** A scrape/snapshot saying "unavailable" alone never fires — rate-limited or bot-walled scrapes look identical to suppressed listings. Must be confirmed by SP-API listing/catalog status (e.g., listings item status or inventory summaries) before a card exists.
- **Freshness gate:** both signals ≤ 6h old.
- **Severity:** this is the highest-urgency category (revenue = 0 while down); confirmed cards jump to top of queue.
- **Before-you-act checklist:** (1) SP-API status value shown; (2) suppression reason if available; (3) recent listing edits in change history?
- **Fixtures:** scraper-rate-limited-but-listing-fine case (the 94%-rate-limited snapshot reality makes this the #1 false-positive source); marketplace-outage case.

### 5. Margin Anomaly
- **Shadow mode ONLY at launch.** Cards generated, logged, visible to founder QA — never shown to sellers.
- **Go-live gate:** `asin_pnl_daily` must reconcile with the books within **±3% for 4 consecutive weeks**. Until settlement→ASIN P&L attribution proves itself against accounting reality, margin alerts are noise with authority — worse than nothing.
- **Depends on:** build items #9 (Settlement → ASIN P&L) and the payment dedupe/idempotency work (P0-6) being complete; duplicate settlement rows would fire fake anomalies.
- **Before-you-act checklist (post-go-live):** (1) reconciliation status green? (2) known cost change (freight, COGS revision) in window? (3) fee change on Amazon side?
- **Fixtures:** duplicate-settlement-rows case; COGS-master-updated-late case; TCS/TDS timing case.

## Measurement
Every card records: emitted_at, rule version, input snapshot ids/windows, state transitions with actor + timestamp, dismiss reason, checklist confirmations, and (for acted cards) the +7d/+14d outcome vs prediction. Weekly Digest (build item #8) reports per-rule: cards emitted, acceptance rate, false-positive rate (from dismissals), measured impact.

## Final build order (approved — do not reorder without founder sign-off)
1. Sync Health Layer
2. Ads warehouse trailing 14-day re-upsert correctness check
3. Ads Bleed
4. Capped Winner
5. Listing Down
6. Buy Box Loss shadow/investigate
7. Action acceptance/dismiss tracking
8. Weekly Digest
9. Settlement → ASIN P&L
10. Margin Anomaly shadow mode

Rationale: nothing above item 2 is trustworthy until sync health and ads re-upsert correctness exist; the two money-touching rules (3, 4) come before snapshot-dependent rules because their data path hardens first; Margin Anomaly is last because it depends on item 9 plus a 4-week reconciliation soak.
