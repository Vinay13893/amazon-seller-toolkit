// Phase 2A: "Findings & Actions Table" — a flattened, easier-to-scan view of
// the Brahmastra Action Queue for the selected Range A / Range B comparison.
// Pure function: takes the already-computed action queue (with correlated
// change-history events attached) and reshapes it into one row per finding.
// Every row is a correlation-based suggestion for manual review, never a
// causal claim or an automated action.

import type { ActionItemWithChanges } from './easyhome-change-history-diagnostic'
import type { ActionEntityType, ActionIssueType, ActionStatus } from './easyhome-action-queue'
import type { CampaignRow } from './easyhome-ads-campaign-diagnostic'
import type { AdvertisedProductRow, SearchTermRow, TargetingRow } from './easyhome-ads-deep-diagnostic'
import { entityDisplayLabel, resolveEasyhomePortfolio } from './portfolio-labels'

export type FindingIssueLabel =
  | 'Spend cut'
  | 'Spend stopped / traffic cut'
  | 'Efficiency collapse'
  | 'Waste spend'
  | 'High spend zero orders'
  | 'New spend in Range B'
  | 'New spend with poor sales'
  | 'New spend with zero orders'
  | 'New target/search term needs review'
  | 'Conversion/listing issue suspected'
  | 'Search term negative review'
  | 'Budget/campaign review'
  | 'Mapping cleanup'
  | 'Data incomplete'
  | 'High ACOS'
  | 'Low ROAS'
  | 'Spend with zero ad sales'

export type FindingExplanation = {
  problem: string
  whyItMatters: string
  whatToCheckFirst: string
  recommendedManualAction: string
  expectedOutcome: string
  riskCaution: string
}

export type FindingRow = {
  actionKey: string
  priority: string
  portfolio: string
  campaignName: string | null
  adGroupName: string | null
  entityName: string
  entityType: ActionEntityType
  issueType: FindingIssueLabel
  spendA: number | null
  spendB: number | null
  spendChange: number | null
  salesA: number | null
  salesB: number | null
  salesChange: number | null
  acosA: number | null
  acosB: number | null
  roasA: number | null
  roasB: number | null
  whatChanged: string
  problem: string
  whyItMatters: string
  evidence: string
  whatToCheckFirst: string
  recommendedManualAction: string
  expectedOutcome: string
  riskCaution: string
  reviewStatus: ActionStatus
}

export type GoodWorkingRow = {
  rank: number
  portfolio: string
  campaignName: string | null
  adGroupName: string | null
  entityName: string
  entityType: 'Campaign' | 'Keyword / Target' | 'SKU' | 'Search Term'
  whyGood: string
  spendA: number
  spendB: number
  salesA: number
  salesB: number
  acosA: number | null
  acosB: number | null
  roasA: number | null
  roasB: number | null
  suggestedAction: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function roasOf(spend: number | null, sales: number | null): number | null {
  if (spend === null || sales === null || spend <= 0) return null
  return round2(sales / spend)
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return round2(b - a)
}

/** Maps metrics onto the Findings vocabulary the team asked for. Findings are Ads-only, so only Ads completeness can trigger 'Data incomplete' — payment-transaction lag must not. */
function findingIssueLabelOf(item: ActionItemWithChanges, adsDataIncomplete = false): FindingIssueLabel {
  if (adsDataIncomplete) return 'Data incomplete'
  if (item.issueType === 'Mapping cleanup') return 'Mapping cleanup'
  const spendA = item.beforeMetrics.spend ?? 0
  const spendB = item.afterMetrics.spend ?? 0
  const salesB = item.afterMetrics.sales ?? 0
  const purchasesB = item.afterMetrics.purchases ?? 0
  const hasNewSpend = spendA === 0 && spendB > 0
  if (hasNewSpend && item.entityType === 'Search Term' && purchasesB === 0) return 'New spend with zero orders'
  if (hasNewSpend && salesB === 0) return 'New spend with zero orders'
  if (hasNewSpend && item.entityType === 'Target') return 'New target/search term needs review'
  if (hasNewSpend && item.afterMetrics.acos !== null && item.afterMetrics.acos > 40) return 'New spend with poor sales'
  if (hasNewSpend) return 'New spend in Range B'
  if (spendA > 0 && spendB === 0 && (item.beforeMetrics.sales ?? 0) > salesB) return 'Spend stopped / traffic cut'
  if (spendB > 0 && salesB === 0) return item.entityType === 'Search Term' ? 'High spend zero orders' : 'Waste spend'
  if (item.issueType === 'High spend zero orders') {
    return item.entityType === 'Search Term' ? 'Search term negative review' : 'Waste spend'
  }
  if (item.issueType === 'Clicks continued but sales collapsed' || item.issueType === 'Conversion/listing issue suspected') {
    return 'Conversion/listing issue suspected'
  }
  if (item.issueType === 'Efficiency collapse') {
    return item.entityType === 'Campaign' ? 'Budget/campaign review' : 'Efficiency collapse'
  }
  return 'Spend cut'
}

/** Factual "what changed" summary — which change types happened, and when, near this range. */
function whatChangedOf(item: ActionItemWithChanges): string {
  if (item.relatedChanges.length === 0) return 'No change-history activity found near this period.'
  const before = item.relatedChanges.filter(c => c.timing === 'Changed before decline').length
  const during = item.relatedChanges.filter(c => c.timing === 'Changed during decline window').length
  const types = [...new Set(item.relatedChanges.map(c => c.changeType))]
  const parts: string[] = []
  if (before > 0) parts.push(`${before} changed before`)
  if (during > 0) parts.push(`${during} changed during`)
  return `${item.relatedChanges.length} change(s) (${types.join(', ')}) — ${parts.join(', ')}. Compare old vs current.`
}

function inr(v: number | null): string {
  return v === null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`
}
function pctStr(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}

/** Numbers-only factual one-liner — kept separate from the qualitative "Problem" sentence. */
function evidenceOf(metrics: { spendA: number | null; spendB: number | null; salesA: number | null; salesB: number | null; acosA: number | null; acosB: number | null }): string {
  return `Spend ${inr(metrics.spendA)}→${inr(metrics.spendB)}, Sales ${inr(metrics.salesA)}→${inr(metrics.salesB)}, ACOS ${pctStr(metrics.acosA)}→${pctStr(metrics.acosB)}.`
}

export type FindingsFreshness = {
  latestAdsDate: string | null
  latestSalesDate: string | null
  selectedRangeEnd: string
}

/** Data-incomplete rows must explain exactly which dates are missing, not show a bare zero. */
function dataIncompleteEvidenceOf(freshness?: FindingsFreshness): string {
  if (!freshness) return 'Selected range includes dates beyond available data.'
  return `Latest Ads data: ${freshness.latestAdsDate ?? 'unknown'}. Latest Sales/payment data: ${freshness.latestSalesDate ?? 'unknown'}. Selected end date: ${freshness.selectedRangeEnd}.`
}

/** A true zero baseline (no spend, no sales) is not missing data — label it as new activity, not a collapse. */
function noBaselineActivityEvidenceOf(metrics: { spendB: number | null; salesB: number | null }): string {
  return `Baseline had no spend/sales; Selected Range spent ${inr(metrics.spendB)} and generated ${inr(metrics.salesB)} sales.`
}

/** Plain-business-English explanation templates, keyed by Finding issue type. Every field is non-empty. */
const EXPLANATION_TEMPLATES: Record<FindingIssueLabel, FindingExplanation> = {
  'Search term negative review': {
    problem: 'This search term spent money but did not generate sales.',
    whyItMatters: 'It may be wasting budget that could go to better converting targets.',
    whatToCheckFirst: 'Check relevance, match type, product fit, and whether this term is already negative.',
    recommendedManualAction: 'Review adding this search term as negative or reducing exposure manually.',
    expectedOutcome: 'Lower wasted spend and improved ACOS if the term is irrelevant.',
    riskCaution: 'Do not negative it if it is strategically important or assists organic ranking.',
  },
  'New spend in Range B': {
    problem: 'This item has new ad spend in Range B but no spend in Range A.',
    whyItMatters: 'It is a new or newly active traffic path, so comparing it as an efficiency collapse would be misleading.',
    whatToCheckFirst: 'Check whether this campaign, target, SKU, or search term was newly launched or newly matched in Range B.',
    recommendedManualAction: 'Review early performance manually before scaling or cutting.',
    expectedOutcome: 'Cleaner decisions on new spend without blaming an old baseline that did not exist.',
    riskCaution: 'New tests can need learning time; do not cut solely because Range A was zero.',
  },
  'New spend with poor sales': {
    problem: 'New Range B spend has started, but sales are weak relative to spend.',
    whyItMatters: 'A new test may be consuming budget before it proves conversion.',
    whatToCheckFirst: 'Check targeting relevance, live bid, listing health, price, coupon, reviews, and stock.',
    recommendedManualAction: 'Keep it controlled; scale only after conversion improves.',
    expectedOutcome: 'Prevent uncontrolled spend while preserving useful tests.',
    riskCaution: 'Do not judge too aggressively if attribution delay or tiny sample size applies.',
  },
  'New spend with zero orders': {
    problem: 'New Range B spend has generated zero orders.',
    whyItMatters: 'This may become waste spend if it continues without conversion.',
    whatToCheckFirst: 'Check search term relevance, match type, listing health, price, coupon, buy box, and stock.',
    recommendedManualAction: 'Review for tighter targeting, negative, pause, or lower bid after confirming relevance.',
    expectedOutcome: 'Lower wasted spend from new traffic that is not converting.',
    riskCaution: 'Do not cut strategically important discovery terms without checking intent and sample size.',
  },
  'New target/search term needs review': {
    problem: 'A target or search term started spending only in Range B.',
    whyItMatters: 'New traffic should be judged as a new test, not as a collapse from Range A.',
    whatToCheckFirst: 'Check query relevance, match type, campaign objective, bid, and listing fit.',
    recommendedManualAction: 'Classify it as keep, cap, negative, or test longer based on relevance and early conversion.',
    expectedOutcome: 'Better control over new target/search-term spend.',
    riskCaution: 'Avoid blocking a promising new term before enough data exists.',
  },
  'Spend stopped / traffic cut': {
    problem: 'Spend stopped or traffic was cut while sales also fell.',
    whyItMatters: 'This can mean a working traffic source was throttled too far.',
    whatToCheckFirst: 'Check budget, bid, campaign status, inventory, buy box, and whether Range A efficiency was acceptable.',
    recommendedManualAction: 'Consider restoring traffic manually only if listing and stock are healthy.',
    expectedOutcome: 'Recover sales lost from over-throttling.',
    riskCaution: 'Do not restore spend if the item was intentionally paused for poor economics.',
  },
  'Waste spend': {
    problem: 'Spend happened but orders were zero or too low.',
    whyItMatters: 'Budget is being consumed without visible return.',
    whatToCheckFirst: 'Check search term relevance, listing quality, price, reviews, coupon, buy box, and delivery promise.',
    recommendedManualAction: 'Pause/reduce/negative only after confirming relevance and listing health.',
    expectedOutcome: 'Reduced waste spend.',
    riskCaution: 'Do not cut if attribution delay or low-volume testing explains the result.',
  },
  'High spend zero orders': {
    problem: 'Spend happened but orders were zero or too low.',
    whyItMatters: 'Budget is being consumed without visible return.',
    whatToCheckFirst: 'Check search term relevance, listing quality, price, reviews, coupon, buy box, and delivery promise.',
    recommendedManualAction: 'Pause/reduce/negative only after confirming relevance and listing health.',
    expectedOutcome: 'Reduced waste spend.',
    riskCaution: 'Do not cut if attribution delay or low-volume testing explains the result.',
  },
  'Spend cut': {
    problem: 'Ad spend was reduced and sales also fell.',
    whyItMatters: 'This can mean traffic was over-throttled.',
    whatToCheckFirst: 'Check stock, buy box, current bid, budget, ranking, and whether ACOS was acceptable before the cut.',
    recommendedManualAction: 'Review whether bid/budget should be partially restored manually.',
    expectedOutcome: 'Recover lost traffic/sales if the cut was too aggressive.',
    riskCaution: 'Do not restore blindly if listing or conversion has worsened.',
  },
  'Efficiency collapse': {
    problem: 'Spend continued or increased, but sales/ROAS worsened.',
    whyItMatters: 'The campaign is buying traffic that is not converting well.',
    whatToCheckFirst: 'Check listing, price, coupon, reviews, buy box, delivery promise, and search-term relevance.',
    recommendedManualAction: 'Fix conversion/listing issues first; then review bids/targets.',
    expectedOutcome: 'Improved conversion and ACOS if the root issue is fixed.',
    riskCaution: 'Do not increase bids until listing health is checked.',
  },
  'Budget/campaign review': {
    problem: 'Spend continued or increased, but sales/ROAS worsened.',
    whyItMatters: 'The campaign is buying traffic that is not converting well.',
    whatToCheckFirst: 'Check listing, price, coupon, reviews, buy box, delivery promise, and search-term relevance.',
    recommendedManualAction: 'Fix conversion/listing issues first; then review bids/targets.',
    expectedOutcome: 'Improved conversion and ACOS if the root issue is fixed.',
    riskCaution: 'Do not increase bids until listing health is checked.',
  },
  'Conversion/listing issue suspected': {
    problem: 'Clicks/spend continued but sales dropped.',
    whyItMatters: 'The ad may still bring traffic, but the product page may not be converting.',
    whatToCheckFirst: 'Check stock, buy box, price, coupon, reviews, rating, images, title, delivery promise, and listing suppression.',
    recommendedManualAction: 'Fix listing/conversion blocker before changing bids.',
    expectedOutcome: 'Sales conversion should improve if listing issue is resolved.',
    riskCaution: 'Bid changes alone may not fix conversion problems.',
  },
  'Mapping cleanup': {
    problem: 'This SKU/campaign/target is not mapped to a known portfolio.',
    whyItMatters: 'Without category mapping, Brahmastra may group the performance under the wrong bucket.',
    whatToCheckFirst: 'Check SKU/campaign naming and category mapping.',
    recommendedManualAction: 'Fix SKU/campaign/category mapping first; do not make ad changes from this row yet.',
    expectedOutcome: 'Cleaner category reporting and fewer false alerts.',
    riskCaution: 'Do not make ad changes from unmapped rows.',
  },
  'Data incomplete': {
    problem: 'The selected range includes dates beyond available sales/ads data.',
    whyItMatters: 'Missing dates can look like zero spend or zero sales even when the data has not been imported yet.',
    whatToCheckFirst: 'Check latest imported sales, ads, and change-history dates before interpreting this row.',
    recommendedManualAction: 'Import/fetch missing reports or shorten the range to the latest available complete date.',
    expectedOutcome: 'Avoid false positives caused by incomplete data.',
    riskCaution: 'Do not make ad decisions from rows affected by incomplete range coverage.',
  },
  'High ACOS': {
    problem: 'ACOS in the selected period is high relative to a healthy range.',
    whyItMatters: 'High ACOS means ad spend is consuming a large share of sales value for this entity.',
    whatToCheckFirst: 'Check bid, targeting relevance, listing conversion, price, and competitor activity.',
    recommendedManualAction: 'Review bid/targeting manually; do not cut spend blindly without checking listing health first.',
    expectedOutcome: 'Improved ACOS once the root cause (bid, targeting, or listing) is addressed.',
    riskCaution: 'A single period can be noisy for low-volume entities — confirm with more data before acting.',
  },
  'Low ROAS': {
    problem: 'ROAS in the selected period is low relative to a healthy range.',
    whyItMatters: 'Low ROAS means ad spend is generating little sales value back for this entity.',
    whatToCheckFirst: 'Check targeting relevance, bid, listing conversion, price, and stock/buy-box status.',
    recommendedManualAction: 'Review targeting/bid manually; confirm relevance before reducing spend.',
    expectedOutcome: 'Improved ROAS once the root cause is addressed.',
    riskCaution: 'A single period can be noisy for low-volume entities — confirm with more data before acting.',
  },
  'Spend with zero ad sales': {
    problem: 'This entity spent on ads in the selected period but generated zero ad-attributed sales.',
    whyItMatters: 'Spend with no sales return is a direct candidate for wasted budget.',
    whatToCheckFirst: 'Check targeting relevance, match type, listing health, price, coupon, buy box, and stock.',
    recommendedManualAction: 'Review for tighter targeting, negative, pause, or lower bid after confirming relevance.',
    expectedOutcome: 'Lower wasted spend from traffic that is not converting.',
    riskCaution: 'Do not cut strategically important or low-volume test terms without checking intent and sample size.',
  },
}

const CHANGE_HISTORY_CORRELATED: Pick<FindingExplanation, 'whyItMatters' | 'recommendedManualAction' | 'riskCaution'> = {
  whyItMatters: 'These changes may explain part of the performance movement, but are not proof of cause.',
  recommendedManualAction: 'Review whether the old setup should be restored or partially corrected manually.',
  riskCaution: 'This is correlation, not confirmed cause. Do not revert blindly.',
}

/**
 * Plain-business-English explanation for a finding row. Blends in change-history
 * correlation language when relevant change events were found near this range —
 * never a causal claim, always "review manually" / "do not revert blindly."
 */
export function buildFindingExplanation(
  issueType: FindingIssueLabel,
  metrics: { spendA: number | null; spendB: number | null; salesA: number | null; salesB: number | null; acosA: number | null; acosB: number | null },
  changeHistorySignal: string,
): FindingExplanation {
  const base = EXPLANATION_TEMPLATES[issueType]
  const hasCorrelatedChanges = !changeHistorySignal.startsWith('No change-history activity')
  if (!hasCorrelatedChanges) return base

  return {
    problem: base.problem,
    whyItMatters: `${base.whyItMatters} ${CHANGE_HISTORY_CORRELATED.whyItMatters}`,
    whatToCheckFirst: `${base.whatToCheckFirst} Compare old value vs current value for the change(s) found.`,
    recommendedManualAction: `${base.recommendedManualAction} ${CHANGE_HISTORY_CORRELATED.recommendedManualAction}`,
    expectedOutcome: base.expectedOutcome,
    riskCaution: `${base.riskCaution} ${CHANGE_HISTORY_CORRELATED.riskCaution}`,
  }
}

export function buildFindingsTable(actionQueue: ActionItemWithChanges[], options: { adsDataIncomplete?: boolean; freshness?: FindingsFreshness } = {}): FindingRow[] {
  return actionQueue.map(item => {
    const issueType = findingIssueLabelOf(item, options.adsDataIncomplete)
    const metrics = {
      spendA: item.beforeMetrics.spend,
      spendB: item.afterMetrics.spend,
      salesA: item.beforeMetrics.sales,
      salesB: item.afterMetrics.sales,
      acosA: item.beforeMetrics.acos,
      acosB: item.afterMetrics.acos,
    }
    const whatChanged = whatChangedOf(item)
    const explanation = buildFindingExplanation(issueType, metrics, whatChanged)
    const noBaselineActivity = (metrics.spendA ?? 0) === 0 && (metrics.salesA ?? 0) === 0
    const evidence = options.adsDataIncomplete
      ? dataIncompleteEvidenceOf(options.freshness)
      : noBaselineActivity
        ? noBaselineActivityEvidenceOf(metrics)
        : evidenceOf(metrics)
    return {
      actionKey: item.actionKey,
      priority: item.priority,
      portfolio: resolveEasyhomePortfolio(item.portfolio, item.campaignName, item.adGroupName, item.entityName),
      campaignName: item.campaignName ?? item.relatedChanges.find(c => c.campaignName)?.campaignName ?? null,
      adGroupName: item.adGroupName ?? item.relatedChanges.find(c => c.adGroupName)?.adGroupName ?? null,
      entityName: entityDisplayLabel(item.entityName),
      entityType: item.entityType,
      issueType,
      spendA: metrics.spendA,
      spendB: metrics.spendB,
      spendChange: delta(metrics.spendA, metrics.spendB),
      salesA: metrics.salesA,
      salesB: metrics.salesB,
      salesChange: delta(metrics.salesA, metrics.salesB),
      acosA: metrics.acosA,
      acosB: metrics.acosB,
      roasA: roasOf(metrics.spendA, metrics.salesA),
      roasB: roasOf(metrics.spendB, metrics.salesB),
      whatChanged,
      problem: explanation.problem,
      whyItMatters: explanation.whyItMatters,
      evidence,
      whatToCheckFirst: explanation.whatToCheckFirst,
      recommendedManualAction: explanation.recommendedManualAction,
      expectedOutcome: explanation.expectedOutcome,
      riskCaution: explanation.riskCaution,
      reviewStatus: item.status,
    }
  })
}

type WinnerInput = {
  portfolio: string
  campaignName: string | null
  adGroupName?: string | null
  entityName: string
  entityType: GoodWorkingRow['entityType']
  beforeSpend: number
  afterSpend: number
  beforeSales: number
  afterSales: number
  beforeAcos: number | null
  afterAcos: number | null
  beforeRoas: number | null
  afterRoas: number | null
  beforePurchases?: number
  afterPurchases?: number
}

function goodReason(row: WinnerInput, mode: 'single' | 'compare' = 'compare'): string | null {
  // Single mode has no baseline at all (the caller passes the same period as
  // both before/after), so every delta-based check below is mathematically
  // inert (deltas are zero) — only the absolute/after-only checks can fire,
  // which is exactly the "selected-period findings, not comparison" behavior
  // single mode needs. We still special-case the labels so they never imply
  // a baseline that doesn't exist.
  if (mode === 'single') {
    const convertingWell = (row.afterPurchases ?? 0) > 0 && (row.afterAcos === null || row.afterAcos <= 35)
    const goodRoas = row.afterRoas !== null && row.afterRoas >= 3
    if (convertingWell) return 'Good ROAS / converting well in selected period.'
    if (goodRoas) return 'Good ROAS in selected period.'
    return null
  }

  // A true zero baseline (no spend, no sales) is not a "before vs after" comparison —
  // label it as new activity instead of misleadingly framing it as an improvement
  // over a baseline that never existed.
  const noBaselineActivity = row.beforeSpend === 0 && row.beforeSales === 0
  if (noBaselineActivity && row.afterSales > 0) return 'New converting campaign/target in selected range.'

  const salesUp = row.afterSales > row.beforeSales && row.afterSales > 0
  const roasImproved = row.beforeRoas !== null && row.afterRoas !== null && row.afterRoas > row.beforeRoas
  const acosImproved = row.beforeAcos !== null && row.afterAcos !== null && row.afterAcos < row.beforeAcos
  const spendUpProfitably = row.afterSpend > row.beforeSpend && salesUp && (roasImproved || acosImproved || row.afterRoas === null || row.afterRoas >= 3)
  const spendDownSalesHeld = row.afterSpend < row.beforeSpend && row.afterSales >= row.beforeSales * 0.9 && row.afterSales > 0
  const convertingWell = (row.afterPurchases ?? 0) > 0 && (row.afterAcos === null || row.afterAcos <= 35)
  if (spendUpProfitably) return 'Spend increased and sales increased profitably.'
  if (salesUp && roasImproved) return 'Sales increased while ROAS improved.'
  if (salesUp && acosImproved) return 'Sales increased while ACOS improved.'
  if (spendDownSalesHeld) return 'Spend decreased but sales held.'
  if (convertingWell) return 'Converting well in Range B.'
  return null
}

function goodAction(row: WinnerInput, reason: string): string {
  if (reason.includes('New converting')) return 'Review early performance before scaling; no baseline exists yet to compare against.'
  if (row.entityType === 'Search Term') return 'Use this search term as a positive keyword/target reference.'
  if (reason.includes('Spend increased')) return 'Consider controlled scaling if stock/listing are healthy.'
  if (reason.includes('Spend decreased')) return 'Protect this campaign; do not cut blindly.'
  return 'Keep monitoring.'
}

function impactScore(row: WinnerInput): number {
  return Math.max(0, row.afterSales - row.beforeSales) + Math.max(0, row.afterSales) + Math.max(0, row.afterSpend - row.beforeSpend)
}

export function buildGoodWorkingRows(params: {
  campaignRows: CampaignRow[]
  advertisedProductRows: AdvertisedProductRow[]
  targetingRows: TargetingRow[]
  searchTermRows: SearchTermRow[]
  mode?: 'single' | 'compare'
}): GoodWorkingRow[] {
  const candidates: WinnerInput[] = [
    ...params.campaignRows.map(r => ({
      portfolio: r.portfolio,
      campaignName: r.campaignName,
      entityName: entityDisplayLabel(r.campaignName),
      entityType: 'Campaign' as const,
      beforeSpend: r.beforeSpend,
      afterSpend: r.afterSpend,
      beforeSales: r.beforeSales,
      afterSales: r.afterSales,
      beforeAcos: r.beforeAcos,
      afterAcos: r.afterAcos,
      beforeRoas: r.beforeRoas,
      afterRoas: r.afterRoas,
      beforePurchases: r.beforePurchases,
      afterPurchases: r.afterPurchases,
    })),
    ...params.advertisedProductRows.map(r => ({
      portfolio: r.portfolio,
      campaignName: r.campaignName,
      entityName: entityDisplayLabel(r.advertisedSku),
      adGroupName: r.adGroupName,
      entityType: 'SKU' as const,
      beforeSpend: r.beforeSpend,
      afterSpend: r.afterSpend,
      beforeSales: r.beforeSales,
      afterSales: r.afterSales,
      beforeAcos: r.beforeAcos,
      afterAcos: r.afterAcos,
      beforeRoas: r.beforeRoas,
      afterRoas: r.afterRoas,
      beforePurchases: r.beforePurchases,
      afterPurchases: r.afterPurchases,
    })),
    ...params.targetingRows.map(r => ({
      portfolio: r.portfolio,
      campaignName: r.campaignName,
      entityName: entityDisplayLabel(r.matchType ? `${r.targetLabel} (${r.matchType})` : r.targetLabel),
      adGroupName: r.adGroupName,
      entityType: 'Keyword / Target' as const,
      beforeSpend: r.beforeSpend,
      afterSpend: r.afterSpend,
      beforeSales: r.beforeSales,
      afterSales: r.afterSales,
      beforeAcos: r.beforeAcos,
      afterAcos: r.afterAcos,
      beforeRoas: r.beforeRoas,
      afterRoas: r.afterRoas,
      beforePurchases: r.beforePurchases,
      afterPurchases: r.afterPurchases,
    })),
    ...params.searchTermRows.map(r => ({
      portfolio: r.portfolio,
      campaignName: r.campaignName,
      entityName: entityDisplayLabel(r.searchTerm),
      adGroupName: r.adGroupName,
      entityType: 'Search Term' as const,
      beforeSpend: r.beforeSpend,
      afterSpend: r.afterSpend,
      beforeSales: r.beforeSales,
      afterSales: r.afterSales,
      beforeAcos: r.beforeAcos,
      afterAcos: r.afterAcos,
      beforeRoas: r.beforeRoas,
      afterRoas: r.afterRoas,
      beforePurchases: r.beforePurchases,
      afterPurchases: r.afterPurchases,
    })),
  ]

  return candidates
    .map(row => ({ row, reason: goodReason(row, params.mode ?? 'compare') }))
    .filter((entry): entry is { row: WinnerInput; reason: string } => entry.reason !== null && entry.row.afterSales > 0)
    .sort((a, b) => impactScore(b.row) - impactScore(a.row))
    .slice(0, 40)
    .map((entry, index) => ({
      rank: index + 1,
      portfolio: resolveEasyhomePortfolio(entry.row.portfolio, entry.row.campaignName, entry.row.adGroupName, entry.row.entityName),
      campaignName: entry.row.campaignName,
      adGroupName: entry.row.adGroupName ?? null,
      entityName: entry.row.entityName,
      entityType: entry.row.entityType,
      whyGood: entry.reason,
      spendA: round2(entry.row.beforeSpend),
      spendB: round2(entry.row.afterSpend),
      salesA: round2(entry.row.beforeSales),
      salesB: round2(entry.row.afterSales),
      acosA: entry.row.beforeAcos,
      acosB: entry.row.afterAcos,
      roasA: entry.row.beforeRoas,
      roasB: entry.row.afterRoas,
      suggestedAction: goodAction(entry.row, entry.reason),
    }))
}

const HIGH_ACOS_THRESHOLD_PCT = 50
const LOW_ROAS_THRESHOLD = 1

/**
 * Single Range mode has no baseline to compare against, so its problem
 * findings come from absolute thresholds on the selected period alone —
 * never from a before/after delta. Built separately from buildFindingsTable
 * so Compare mode's delta-based catalog is never affected.
 */
export function buildSinglePeriodAbsoluteFindings(params: {
  campaignRows: CampaignRow[]
  advertisedProductRows: AdvertisedProductRow[]
  targetingRows: TargetingRow[]
  searchTermRows: SearchTermRow[]
}): FindingRow[] {
  type Candidate = {
    portfolio: string
    campaignName: string | null
    adGroupName: string | null
    entityName: string
    entityType: ActionEntityType
    spend: number
    sales: number
    acos: number | null
    roas: number | null
  }

  const candidates: Candidate[] = [
    ...params.campaignRows.map(r => ({ portfolio: r.portfolio, campaignName: r.campaignName, adGroupName: null, entityName: entityDisplayLabel(r.campaignName), entityType: 'Campaign' as const, spend: r.afterSpend, sales: r.afterSales, acos: r.afterAcos, roas: r.afterRoas })),
    ...params.advertisedProductRows.map(r => ({ portfolio: r.portfolio, campaignName: r.campaignName, adGroupName: r.adGroupName ?? null, entityName: entityDisplayLabel(r.advertisedSku), entityType: 'SKU' as const, spend: r.afterSpend, sales: r.afterSales, acos: r.afterAcos, roas: r.afterRoas })),
    ...params.targetingRows.map(r => ({ portfolio: r.portfolio, campaignName: r.campaignName, adGroupName: r.adGroupName ?? null, entityName: entityDisplayLabel(r.matchType ? `${r.targetLabel} (${r.matchType})` : r.targetLabel), entityType: 'Target' as const, spend: r.afterSpend, sales: r.afterSales, acos: r.afterAcos, roas: r.afterRoas })),
    ...params.searchTermRows.map(r => ({ portfolio: r.portfolio, campaignName: r.campaignName, adGroupName: r.adGroupName ?? null, entityName: entityDisplayLabel(r.searchTerm), entityType: 'Search Term' as const, spend: r.afterSpend, sales: r.afterSales, acos: r.afterAcos, roas: r.afterRoas })),
  ]

  const rows: FindingRow[] = []
  for (const c of candidates) {
    if (c.spend <= 0) continue
    const isZeroAdSales = c.sales <= 0
    const isHighAcos = !isZeroAdSales && c.acos !== null && c.acos > HIGH_ACOS_THRESHOLD_PCT
    const isLowRoas = !isZeroAdSales && c.roas !== null && c.roas < LOW_ROAS_THRESHOLD
    const issueType: FindingIssueLabel | null = isZeroAdSales ? 'Spend with zero ad sales' : isHighAcos ? 'High ACOS' : isLowRoas ? 'Low ROAS' : null
    if (!issueType) continue

    const metrics = { spendA: c.spend, spendB: c.spend, salesA: c.sales, salesB: c.sales, acosA: c.acos, acosB: c.acos }
    const explanation = EXPLANATION_TEMPLATES[issueType]
    rows.push({
      actionKey: `single-period:${issueType}:${c.campaignName ?? ''}:${c.entityName}`,
      priority: isZeroAdSales ? 'High' : isHighAcos ? 'Medium' : 'Low',
      portfolio: resolveEasyhomePortfolio(c.portfolio, c.campaignName, c.adGroupName, c.entityName),
      campaignName: c.campaignName,
      adGroupName: c.adGroupName,
      entityName: c.entityName,
      entityType: c.entityType,
      issueType,
      spendA: c.spend,
      spendB: c.spend,
      spendChange: 0,
      salesA: c.sales,
      salesB: c.sales,
      salesChange: 0,
      acosA: c.acos,
      acosB: c.acos,
      roasA: c.roas,
      roasB: c.roas,
      whatChanged: 'No change-history activity found near this period.',
      problem: explanation.problem,
      whyItMatters: explanation.whyItMatters,
      evidence: evidenceOf(metrics),
      whatToCheckFirst: explanation.whatToCheckFirst,
      recommendedManualAction: explanation.recommendedManualAction,
      expectedOutcome: explanation.expectedOutcome,
      riskCaution: explanation.riskCaution,
      reviewStatus: 'Open',
    })
  }
  return rows
}

export type { ActionIssueType }
