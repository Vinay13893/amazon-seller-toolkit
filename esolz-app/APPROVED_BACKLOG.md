# Approved Backlog — Brahmastra Action Engine
**Status:** APPROVED ORDER — do not reorder without founder sign-off. Docs only; no build authorization. Updated 2026-07-07.
Source specs: `DAILY_TOP_5_ACTION_ENGINE_SPEC.md`, `PRODUCT_STRATEGY_90_DAY.md`.

## Build order (locked)

| # | Item | Gate to start | Gate to ship |
|---|------|---------------|--------------|
| 1 | **Sync Health Layer** | P0 hardening green | Every rule source reports green/amber/red; red source blocks dependent rules; freshness SLAs wired (ads 36h, snapshots 6h) |
| 2 | **Ads warehouse trailing 14-day re-upsert correctness check** | #1 shipped | Nightly re-upsert of day −14→−1 verified: spot-check job compares warehouse vs fresh API pull for 3 random days; discrepancy >2% fails the check and blocks Ads Bleed |
| 3 | **Ads Bleed** | #2 green 7 consecutive days | Window day −17→−3 enforced; never last-3-days (fixture-tested); min clicks = max(20, 3 ÷ expected CVR); false-positive fixtures pass; founder QA gate weeks 1–2 |
| 4 | **Capped Winner** | #3 live on EasyHOME | Max +25% budget recommendation; deal weeks skipped; marginal ACOS shown; +7d measured follow-up auto-created; fixtures pass |
| 5 | **Listing Down** | #1 shipped | SP-API cross-confirmation mandatory; 6h freshness gate; scraper-rate-limited fixture passes (top false-positive source) |
| 6 | **Buy Box Loss — shadow/investigate** | #1 shipped | Default "investigate", never "match price"; hijacker classification on every card; ≥2 consecutive loss observations; shadow until precision proven at founder QA |
| 7 | **Action acceptance/dismiss tracking** | ships alongside #3 | All state transitions logged incl. `needs_client_approval`; dismiss reason taxonomy enforced (no dismiss without reason); `data_wrong` dismissals auto-create fixture candidates |
| 8 | **Weekly Digest** | #7 live 2 weeks | Per-rule: emitted / accepted / dismissed-by-reason / measured impact; goes to founder first, brands later |
| 9 | **Settlement → ASIN P&L (`asin_pnl_daily`)** | Payment dedupe (P0-6) permanent + unique key held for 4 weeks | Daily ASIN-level P&L; reconciliation job vs books runs weekly |
| 10 | **Margin Anomaly — shadow mode** | #9 shipped | Shadow only. Seller-visible ONLY after `asin_pnl_daily` reconciles with books within ±3% for 4 consecutive weeks |

## Phase 2 (deferred, not deleted)
- **Stockout Risk** — re-enters after #9 + inventory freshness proven. Explicitly not deleted from the product; deliberately sequenced after money-grade data exists.
- Margin Anomaly seller-visible go-live (post ±3%/4-week soak).
- Keshananda-specific onboarding polish (week 9).

## Explicitly NOT approved (do not build, do not spec)
- External SaaS signup / self-serve onboarding / billing integration.
- Autonomous Ads API writes or price automation of any kind (engine recommends, humans act).
- "Match price" as a Buy Box response.
- Proxy pools / anti-bot evasion for scraping.
- Any Ganga Realty or Advatix/XPDEL schema, workspace, or flag.
- New rule categories beyond the five V1 categories (proposals land here first).

## Client-safety invariants (apply to every backlog item)
1. `needs_client_approval` state required before Sage Royal (week 5) and Keshananda (week 9) see actionable cards.
2. Founder QA gate: Vinay reviews queue every morning, weeks 1–2 of each rule's go-live.
3. No rule reaches a client workspace without ≥2 weeks on EasyHOME.
4. Known-false-positive fixture suite is a merge gate per rule, seeded from every `data_wrong` dismissal.
5. Snapshot-based rules carry a 6h freshness gate; stale input suppresses the card, never degrades to guessing.
