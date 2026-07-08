# Brahmastra — 90-Day Product Strategy (v1.1, red-team guardrails applied)
**Status:** APPROVED. Docs only — no build authorization implied. Updated 2026-07-07.

## Thesis
Brahmastra is a **decision engine, not a dashboard**. We win when a seller trusts the Top 5 queue enough to run their morning from it. Everything that is not `sync → diagnose → recommend → act → measure` is scope creep.

We are **not doing external SaaS in this 90-day window**. Three managed brands, onboarded by hand, in this order:

| Phase | Brand | Role |
|-------|-------|------|
| Weeks 1–4 | **EasyHOME** | Internal proof brand. All rules debut here. Founder QA gate active weeks 1–2 of engine go-live. |
| Week 5 → | **Sage Royal Ayurveda** | First client workspace. `needs_client_approval` state mandatory before any action card is actionable. |
| Week 9 → | **Keshananda** | Second client workspace. Same approval gate. Onboarding must be repeatable from the Sage Royal runbook, not bespoke. |

**Explicitly out of Brahmastra schema for now:** Ganga Realty, Advatix/XPDEL. No plans, workspaces, tables, or flags for them.

## Phasing

### Phase 0 (prerequisite, in flight): P0 hardening
Per `brahmastra-p0-execution-handoff-2026-07-07.md`: entitlements, RPC revokes, token isolation, ads 401/429 pipeline repair, payment dedupe, DB separation (day 9–10, schema frozen first). **The action engine does not start until P0 is green** — a decision engine on top of a broken warehouse is a liability generator.

### Phase 1 (weeks 1–8): Top 5 Actions V1
Build order (locked — see spec):
1. Sync Health Layer — no rule runs on red sources; broken sync must never read as a business signal.
2. Ads warehouse trailing 14-day nightly re-upsert + correctness check — late attribution lands before any bleed logic reads it.
3. Ads Bleed (window day −17→−3, min clicks max(20, 3÷CVR), never last-3-days).
4. Capped Winner (max +25% budget, skip deal weeks, marginal ACOS).
5. Listing Down (SP-API cross-confirmation, 6h freshness).
6. Buy Box Loss — shadow/investigate mode (default "investigate", hijacker classification, never "match price").
7. Action acceptance/dismiss tracking (dismiss taxonomy, checklist logging).
8. Weekly Digest (per-rule precision + measured impact).

Trust mechanics in Phase 1: founder QA gate weeks 1–2, per-card before-you-act checklists, known-false-positive fixture tests as merge gates, 6h freshness gate on snapshot rules.

### Phase 2 (weeks 9–13): money-grade analytics
9. Settlement → ASIN P&L (`asin_pnl_daily`) — depends on payment dedupe (P0-6) being permanent.
10. Margin Anomaly — **shadow mode only** until `asin_pnl_daily` reconciles with books within ±3% for 4 consecutive weeks.
11. **Stockout Risk — deferred to Phase 2, not deleted.** Enters only after inventory freshness and P&L attribution are proven.

### Not in the 90 days
External SaaS signup, billing/payments integration, autonomous Ads API writes, price automation, proxy/anti-bot scraping expansion, any Ganga Realty / Advatix schema work.

## Success criteria (day 90)
- EasyHOME: ≥8 weeks of Top 5 queue, per-rule false-positive rate <10% (measured via dismiss taxonomy), ≥60% acceptance on Ads Bleed cards.
- Sage Royal: onboarded ≥5 weeks, `needs_client_approval` flow used in production, zero incidents of a card firing on stale/broken sync.
- Keshananda: onboarded ≥1 week from the runbook without code changes.
- Ads pipeline: 7-consecutive-clean-days standard maintained (rolling).
- Margin Anomaly: reconciliation soak in progress or passed; no seller-visible margin card unless the ±3%/4-week gate passed.

## Standing constraints
- Client workspaces (Sage Royal, Keshananda) never see a rule that hasn't run ≥2 weeks on EasyHOME first.
- Any rule whose `data_wrong` dismissal rate exceeds 20% in a week is auto-demoted to shadow mode pending fixture work.
- No new rule categories in V1 beyond the five. Requests go to APPROVED_BACKLOG.md, not into scope.
