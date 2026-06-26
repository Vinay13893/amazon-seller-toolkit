// Phase 2A: "Findings & Actions Table" — a flattened, easier-to-scan view of
// the Brahmastra Action Queue for the selected Range A / Range B comparison.
// Pure function: takes the already-computed action queue (with correlated
// change-history events attached) and reshapes it into one row per finding.
// Every row is a correlation-based suggestion for manual review, never a
// causal claim or an automated action.

import type { ActionItemWithChanges } from './easyhome-change-history-diagnostic'
import type { ActionIssueType, ActionStatus } from './easyhome-action-queue'

export type FindingIssueLabel =
  | 'Spend cut'
  | 'Efficiency collapse'
  | 'Waste spend'
  | 'High spend zero orders'
  | 'Conversion/listing issue suspected'
  | 'Search term negative review'
  | 'Budget/campaign review'
  | 'Mapping cleanup'

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

/** Maps the existing Action Queue taxonomy onto the Findings vocabulary the team asked for. */
function findingIssueLabelOf(item: ActionItemWithChanges): FindingIssueLabel {
  if (item.issueType === 'Mapping cleanup') return 'Mapping cleanup'
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
    problem: 'This row is not mapped to a clear EasyHOME portfolio/category.',
    whyItMatters: 'Wrong mapping can create wrong ads decisions.',
    whatToCheckFirst: 'Check SKU/campaign naming and category mapping.',
    recommendedManualAction: 'Fix mapping before taking performance action.',
    expectedOutcome: 'Cleaner category reporting and fewer false alerts.',
    riskCaution: 'Do not make ad changes from unmapped rows.',
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

export function buildFindingsTable(actionQueue: ActionItemWithChanges[]): FindingRow[] {
  return actionQueue.map(item => {
    const issueType = findingIssueLabelOf(item)
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
    return {
      actionKey: item.actionKey,
      priority: item.priority,
      portfolio: item.portfolio,
      campaignName: item.campaignName,
      adGroupName: item.relatedChanges.find(c => c.adGroupName)?.adGroupName ?? null,
      entityName: item.entityName,
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
      evidence: evidenceOf(metrics),
      whatToCheckFirst: explanation.whatToCheckFirst,
      recommendedManualAction: explanation.recommendedManualAction,
      expectedOutcome: explanation.expectedOutcome,
      riskCaution: explanation.riskCaution,
      reviewStatus: item.status,
    }
  })
}

export type { ActionIssueType }
