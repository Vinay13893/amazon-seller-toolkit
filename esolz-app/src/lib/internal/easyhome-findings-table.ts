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
  changeHistorySignal: string
  recommendedManualAction: string
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

function changeHistorySignalOf(item: ActionItemWithChanges): string {
  if (item.relatedChanges.length === 0) return 'No correlated change-history events found.'
  const before = item.relatedChanges.filter(c => c.timing === 'Changed before decline').length
  const during = item.relatedChanges.filter(c => c.timing === 'Changed during decline window').length
  const parts: string[] = []
  if (before > 0) parts.push(`${before} changed before`)
  if (during > 0) parts.push(`${during} changed during`)
  return `${item.relatedChanges.length} correlated with this range (${parts.join(', ')}) — review manually, compare old vs current.`
}

export function buildFindingsTable(actionQueue: ActionItemWithChanges[]): FindingRow[] {
  return actionQueue.map(item => ({
    actionKey: item.actionKey,
    priority: item.priority,
    portfolio: item.portfolio,
    campaignName: item.campaignName,
    adGroupName: item.relatedChanges.find(c => c.adGroupName)?.adGroupName ?? null,
    entityName: item.entityName,
    issueType: findingIssueLabelOf(item),
    spendA: item.beforeMetrics.spend,
    spendB: item.afterMetrics.spend,
    spendChange: delta(item.beforeMetrics.spend, item.afterMetrics.spend),
    salesA: item.beforeMetrics.sales,
    salesB: item.afterMetrics.sales,
    salesChange: delta(item.beforeMetrics.sales, item.afterMetrics.sales),
    acosA: item.beforeMetrics.acos,
    acosB: item.afterMetrics.acos,
    roasA: roasOf(item.beforeMetrics.spend, item.beforeMetrics.sales),
    roasB: roasOf(item.afterMetrics.spend, item.afterMetrics.sales),
    changeHistorySignal: changeHistorySignalOf(item),
    recommendedManualAction: item.suggestedReview,
    reviewStatus: item.status,
  }))
}

export type { ActionIssueType }
