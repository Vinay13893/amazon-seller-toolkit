// Phase 1D: Brahmastra Action Queue. Turns existing read-only diagnostics
// into a reviewable list of suggested checks for the EasyHOME team.
// IMPORTANT: every item here is a correlation-based suggestion, never a
// causal claim — wording must stay "likely issue," "needs review," or
// "correlated with." This module never changes bids/budgets/campaigns.

import type { CampaignRow } from './easyhome-ads-campaign-diagnostic'
import type { AdvertisedProductRow, SearchTermRow, TargetingRow } from './easyhome-ads-deep-diagnostic'

export type ActionPriority = 'High' | 'Medium' | 'Low'
export type ActionEntityType = 'SKU' | 'Campaign' | 'Target' | 'Search Term' | 'Mapping'
export type ActionIssueType =
  | 'Spend cut'
  | 'Efficiency collapse'
  | 'Clicks continued but sales collapsed'
  | 'High spend zero orders'
  | 'Mapping cleanup'
  | 'Conversion/listing issue suspected'
export type ActionDataSource = 'campaign' | 'advertised_product' | 'targeting' | 'search_term' | 'transaction'
export type ActionStatus = 'Open' | 'Reviewing' | 'Done' | 'Ignored'

export type ActionMetrics = {
  spend: number | null
  sales: number | null
  acos: number | null
  clicks: number | null
  purchases: number | null
}

export type ActionItem = {
  actionKey: string
  priority: ActionPriority
  portfolio: string
  entityType: ActionEntityType
  entityName: string
  // Used to link this item to Change History events (Phase 1E.2) — null
  // for items with no single owning campaign (e.g. SKU-level mapping gaps).
  campaignName: string | null
  problemSummary: string
  beforeMetrics: ActionMetrics
  afterMetrics: ActionMetrics
  issueType: ActionIssueType
  suggestedReview: string
  dataSource: ActionDataSource
  status: ActionStatus
  notes: string | null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function inr(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}

function makeActionKey(dataSource: ActionDataSource, entityType: ActionEntityType, entityName: string, portfolio: string): string {
  return [dataSource, entityType, entityName, portfolio].map(p => p.trim().toUpperCase()).join('|')
}

const SUGGESTED_REVIEW_BY_ISSUE: Record<ActionIssueType, string> = {
  'Spend cut': 'Check if budget/bid was reduced; consider restoring only if stock/listing is healthy.',
  'Efficiency collapse': 'Efficiency collapse; check targeting/search term/listing before increasing spend.',
  'Clicks continued but sales collapsed': 'Conversion issue suspected; check price, coupon, stock, buy box, reviews, delivery promise, listing suppression.',
  'High spend zero orders': 'Waste candidate; review for negative/pause.',
  'Mapping cleanup': 'Mapping review.',
  'Conversion/listing issue suspected': 'Conversion issue suspected; check price, coupon, stock, buy box, reviews, delivery promise, listing suppression.',
}

function priorityFromAbsDeltaSales(absDeltaSales: number): ActionPriority {
  if (absDeltaSales >= 20000) return 'High'
  if (absDeltaSales >= 5000) return 'Medium'
  return 'Low'
}

function priorityFromSpend(spend: number): ActionPriority {
  if (spend >= 500) return 'High'
  if (spend >= 150) return 'Medium'
  return 'Low'
}

function priorityFromMappingImpact(combined: number): ActionPriority {
  if (combined >= 20000) return 'High'
  if (combined >= 2000) return 'Medium'
  return 'Low'
}

function metricsOf(spend: number, sales: number, acos: number | null, clicks: number, purchases: number): ActionMetrics {
  return { spend: round2(spend), sales: round2(sales), acos, clicks, purchases }
}

/** "Spend cut" vs "Efficiency collapse" split shared by SKU/target/campaign losers. */
function classifyLoser(deltaSpend: number, beforeAcos: number | null, afterAcos: number | null): { issueType: ActionIssueType } {
  const acosWorsened = beforeAcos !== null && afterAcos !== null && afterAcos > beforeAcos + 10
  if (deltaSpend >= 0 || acosWorsened) return { issueType: 'Efficiency collapse' }
  return { issueType: 'Spend cut' }
}

export function buildActionQueue(params: {
  advertisedProduct: { topLosers: AdvertisedProductRow[]; trafficContinuedSalesCollapsed: AdvertisedProductRow[]; mappingHealth: { topUnmapped: Array<{ name: string; totalSpend: number; totalSales: number }> } } | null
  targeting: { topLosers: TargetingRow[]; acosWorsenedSharply: TargetingRow[]; mappingHealth: { topUnmapped: Array<{ name: string; totalSpend: number; totalSales: number }> } } | null
  searchTerm: { highSpendZeroOrdersAfter: SearchTermRow[]; spendUpSalesDown: SearchTermRow[]; goodBeforeBadAfter: SearchTermRow[]; mappingHealth: { topUnmapped: Array<{ name: string; totalSpend: number; totalSales: number }> } } | null
  campaignTable: CampaignRow[]
  campaignsWithSpendUpAndSalesDown: CampaignRow[]
  campaignTopUnmapped: Array<{ campaignName: string; totalSpend: number; totalSales: number }>
  skuTopUnmapped: Array<{ sku: string; totalSales: number; beforeSales: number; afterSales: number }>
  existingStatuses: Map<string, { status: ActionStatus; notes: string | null }>
}): ActionItem[] {
  const items: ActionItem[] = []

  function push(item: Omit<ActionItem, 'status' | 'notes' | 'campaignName'> & { campaignName?: string | null }) {
    const existing = params.existingStatuses.get(item.actionKey)
    items.push({ campaignName: null, ...item, status: existing?.status ?? 'Open', notes: existing?.notes ?? null })
  }

  // --- SKU level (advertised product) ---
  if (params.advertisedProduct) {
    for (const r of params.advertisedProduct.topLosers) {
      const { issueType } = classifyLoser(r.deltaSpend, r.beforeAcos, r.afterAcos)
      push({
        actionKey: makeActionKey('advertised_product', 'SKU', r.advertisedSku, r.portfolio),
        priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
        portfolio: r.portfolio,
        entityType: 'SKU',
        entityName: r.advertisedSku,
        campaignName: r.campaignName,
        problemSummary: `Ad sales for "${r.advertisedSku}" fell from ${inr(r.beforeSales)} to ${inr(r.afterSales)} (Δ${inr(r.deltaSales)}), correlated with the post-15-June window.`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType,
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE[issueType],
        dataSource: 'advertised_product',
      })
    }
    for (const r of params.advertisedProduct.trafficContinuedSalesCollapsed) {
      push({
        actionKey: makeActionKey('advertised_product', 'SKU', `${r.advertisedSku}-traffic`, r.portfolio),
        priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
        portfolio: r.portfolio,
        entityType: 'SKU',
        entityName: r.advertisedSku,
        campaignName: r.campaignName,
        problemSummary: `"${r.advertisedSku}" kept ${r.afterClicks} clicks (vs ${r.beforeClicks} before) but sales collapsed to ${inr(r.afterSales)} (was ${inr(r.beforeSales)}) — likely issue is conversion, not traffic.`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType: 'Clicks continued but sales collapsed',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Clicks continued but sales collapsed'],
        dataSource: 'advertised_product',
      })
    }
  }

  // --- Target/keyword level ---
  if (params.targeting) {
    for (const r of params.targeting.topLosers) {
      const { issueType } = classifyLoser(r.deltaSpend, r.beforeAcos, r.afterAcos)
      push({
        actionKey: makeActionKey('targeting', 'Target', `${r.targetLabel}-${r.matchType ?? ''}`, r.portfolio),
        priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
        portfolio: r.portfolio,
        entityType: 'Target',
        entityName: r.matchType ? `${r.targetLabel} (${r.matchType})` : r.targetLabel,
        campaignName: r.campaignName,
        problemSummary: `Target "${r.targetLabel}" sales fell from ${inr(r.beforeSales)} to ${inr(r.afterSales)} (Δ${inr(r.deltaSales)}) on campaign "${r.campaignName}".`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType,
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE[issueType],
        dataSource: 'targeting',
      })
    }
    for (const r of params.targeting.acosWorsenedSharply) {
      push({
        actionKey: makeActionKey('targeting', 'Target', `${r.targetLabel}-acos-${r.matchType ?? ''}`, r.portfolio),
        priority: r.afterAcos !== null && r.beforeAcos !== null && r.afterAcos - r.beforeAcos >= 30 ? 'High' : 'Medium',
        portfolio: r.portfolio,
        entityType: 'Target',
        entityName: r.matchType ? `${r.targetLabel} (${r.matchType})` : r.targetLabel,
        campaignName: r.campaignName,
        problemSummary: `ACOS on "${r.targetLabel}" worsened from ${r.beforeAcos?.toFixed(1)}% to ${r.afterAcos?.toFixed(1)}% — efficiency collapse correlated with the drop window.`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType: 'Efficiency collapse',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Efficiency collapse'],
        dataSource: 'targeting',
      })
    }
  }

  // --- Search term level ---
  if (params.searchTerm) {
    for (const r of params.searchTerm.highSpendZeroOrdersAfter) {
      push({
        actionKey: makeActionKey('search_term', 'Search Term', r.searchTerm, r.portfolio),
        priority: priorityFromSpend(r.afterSpend),
        portfolio: r.portfolio,
        entityType: 'Search Term',
        entityName: r.searchTerm,
        campaignName: r.campaignName,
        problemSummary: `Search term "${r.searchTerm}" spent ${inr(r.afterSpend)} after 15 June with zero orders (campaign "${r.campaignName}").`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType: 'High spend zero orders',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['High spend zero orders'],
        dataSource: 'search_term',
      })
    }
    for (const r of params.searchTerm.spendUpSalesDown) {
      push({
        actionKey: makeActionKey('search_term', 'Search Term', `${r.searchTerm}-spendup`, r.portfolio),
        priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
        portfolio: r.portfolio,
        entityType: 'Search Term',
        entityName: r.searchTerm,
        campaignName: r.campaignName,
        problemSummary: `Search term "${r.searchTerm}" spend rose by ${inr(r.deltaSpend)} while sales fell by ${inr(Math.abs(r.deltaSales))} — needs review before continuing to invest.`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType: 'Efficiency collapse',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Efficiency collapse'],
        dataSource: 'search_term',
      })
    }
    for (const r of params.searchTerm.goodBeforeBadAfter) {
      const issueType: ActionIssueType = r.afterPurchases === 0 ? 'Conversion/listing issue suspected' : 'Efficiency collapse'
      push({
        actionKey: makeActionKey('search_term', 'Search Term', `${r.searchTerm}-goodbad`, r.portfolio),
        priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
        portfolio: r.portfolio,
        entityType: 'Search Term',
        entityName: r.searchTerm,
        campaignName: r.campaignName,
        problemSummary: `Search term "${r.searchTerm}" was healthy before 15 June (ACOS ${r.beforeAcos?.toFixed(1)}%, ${r.beforePurchases} purchases) but is now ${r.afterPurchases === 0 ? 'converting zero orders' : `ACOS ${r.afterAcos?.toFixed(1)}%`} — needs review.`,
        beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
        afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
        issueType,
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE[issueType],
        dataSource: 'search_term',
      })
    }
  }

  // --- Campaign level ---
  const spendDroppedSharply = [...params.campaignTable]
    .filter(c => c.deltaSpend < 0)
    .sort((a, b) => a.deltaSpend - b.deltaSpend)
    .slice(0, 15)
  for (const r of spendDroppedSharply) {
    const { issueType } = classifyLoser(r.deltaSpend, r.beforeAcos, r.afterAcos)
    push({
      actionKey: makeActionKey('campaign', 'Campaign', r.campaignName, r.portfolio),
      priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
      portfolio: r.portfolio,
      entityType: 'Campaign',
      entityName: r.campaignName,
      campaignName: r.campaignName,
      problemSummary: `Campaign "${r.campaignName}" spend dropped by ${inr(Math.abs(r.deltaSpend))}, sales moved by ${inr(r.deltaSales)}.`,
      beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
      afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
      issueType,
      suggestedReview: SUGGESTED_REVIEW_BY_ISSUE[issueType],
      dataSource: 'campaign',
    })
  }
  for (const r of params.campaignsWithSpendUpAndSalesDown) {
    push({
      actionKey: makeActionKey('campaign', 'Campaign', `${r.campaignName}-spendup`, r.portfolio),
      priority: priorityFromAbsDeltaSales(Math.abs(r.deltaSales)),
      portfolio: r.portfolio,
      entityType: 'Campaign',
      entityName: r.campaignName,
      campaignName: r.campaignName,
      problemSummary: `Campaign "${r.campaignName}" spend increased by ${inr(r.deltaSpend)} while sales fell by ${inr(Math.abs(r.deltaSales))}.`,
      beforeMetrics: metricsOf(r.beforeSpend, r.beforeSales, r.beforeAcos, r.beforeClicks, r.beforePurchases),
      afterMetrics: metricsOf(r.afterSpend, r.afterSales, r.afterAcos, r.afterClicks, r.afterPurchases),
      issueType: 'Efficiency collapse',
      suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Efficiency collapse'],
      dataSource: 'campaign',
    })
  }

  // --- Mapping cleanup ---
  const MAPPING_MEANINGFUL_THRESHOLD = 500
  for (const r of params.campaignTopUnmapped) {
    const combined = r.totalSpend + r.totalSales
    if (combined < MAPPING_MEANINGFUL_THRESHOLD) continue
    push({
      actionKey: makeActionKey('campaign', 'Mapping', r.campaignName, 'Unmapped / Needs Review'),
      priority: priorityFromMappingImpact(combined),
      portfolio: 'Unmapped / Needs Review',
      entityType: 'Mapping',
      entityName: r.campaignName,
      campaignName: r.campaignName,
      problemSummary: `Campaign "${r.campaignName}" has no portfolio mapping (spend ${inr(r.totalSpend)}, sales ${inr(r.totalSales)}) and is currently excluded from category-level totals.`,
      beforeMetrics: { spend: null, sales: null, acos: null, clicks: null, purchases: null },
      afterMetrics: { spend: round2(r.totalSpend), sales: round2(r.totalSales), acos: null, clicks: null, purchases: null },
      issueType: 'Mapping cleanup',
      suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Mapping cleanup'],
      dataSource: 'campaign',
    })
  }
  for (const r of params.skuTopUnmapped) {
    const combined = r.beforeSales + r.afterSales
    if (Math.abs(combined) < MAPPING_MEANINGFUL_THRESHOLD) continue
    push({
      actionKey: makeActionKey('transaction', 'Mapping', r.sku, 'Unmapped / Needs Review'),
      priority: priorityFromMappingImpact(Math.abs(combined)),
      portfolio: 'Unmapped / Needs Review',
      entityType: 'Mapping',
      entityName: r.sku,
      problemSummary: `SKU "${r.sku}" has no cost-master category (sales ${inr(r.beforeSales)} before / ${inr(r.afterSales)} after) and is excluded from category-level totals.`,
      beforeMetrics: { spend: null, sales: round2(r.beforeSales), acos: null, clicks: null, purchases: null },
      afterMetrics: { spend: null, sales: round2(r.afterSales), acos: null, clicks: null, purchases: null },
      issueType: 'Mapping cleanup',
      suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Mapping cleanup'],
      dataSource: 'transaction',
    })
  }
  if (params.advertisedProduct) {
    for (const r of params.advertisedProduct.mappingHealth.topUnmapped) {
      const combined = r.totalSpend + r.totalSales
      if (combined < MAPPING_MEANINGFUL_THRESHOLD) continue
      push({
        actionKey: makeActionKey('advertised_product', 'Mapping', r.name, 'Unmapped / Needs Review'),
        priority: priorityFromMappingImpact(combined),
        portfolio: 'Unmapped / Needs Review',
        entityType: 'Mapping',
        entityName: r.name,
        problemSummary: `Advertised SKU "${r.name}" has no portfolio mapping (spend ${inr(r.totalSpend)}, sales ${inr(r.totalSales)}).`,
        beforeMetrics: { spend: null, sales: null, acos: null, clicks: null, purchases: null },
        afterMetrics: { spend: round2(r.totalSpend), sales: round2(r.totalSales), acos: null, clicks: null, purchases: null },
        issueType: 'Mapping cleanup',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Mapping cleanup'],
        dataSource: 'advertised_product',
      })
    }
  }
  if (params.targeting) {
    for (const r of params.targeting.mappingHealth.topUnmapped) {
      const combined = r.totalSpend + r.totalSales
      if (combined < MAPPING_MEANINGFUL_THRESHOLD) continue
      push({
        actionKey: makeActionKey('targeting', 'Mapping', r.name, 'Unmapped / Needs Review'),
        priority: priorityFromMappingImpact(combined),
        portfolio: 'Unmapped / Needs Review',
        entityType: 'Mapping',
        entityName: r.name,
        problemSummary: `Target "${r.name}" sits under a campaign with no portfolio mapping (spend ${inr(r.totalSpend)}, sales ${inr(r.totalSales)}).`,
        beforeMetrics: { spend: null, sales: null, acos: null, clicks: null, purchases: null },
        afterMetrics: { spend: round2(r.totalSpend), sales: round2(r.totalSales), acos: null, clicks: null, purchases: null },
        issueType: 'Mapping cleanup',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Mapping cleanup'],
        dataSource: 'targeting',
      })
    }
  }
  if (params.searchTerm) {
    for (const r of params.searchTerm.mappingHealth.topUnmapped) {
      const combined = r.totalSpend + r.totalSales
      if (combined < MAPPING_MEANINGFUL_THRESHOLD) continue
      push({
        actionKey: makeActionKey('search_term', 'Mapping', r.name, 'Unmapped / Needs Review'),
        priority: priorityFromMappingImpact(combined),
        portfolio: 'Unmapped / Needs Review',
        entityType: 'Mapping',
        entityName: r.name,
        problemSummary: `Search term "${r.name}" sits under a campaign with no portfolio mapping (spend ${inr(r.totalSpend)}, sales ${inr(r.totalSales)}).`,
        beforeMetrics: { spend: null, sales: null, acos: null, clicks: null, purchases: null },
        afterMetrics: { spend: round2(r.totalSpend), sales: round2(r.totalSales), acos: null, clicks: null, purchases: null },
        issueType: 'Mapping cleanup',
        suggestedReview: SUGGESTED_REVIEW_BY_ISSUE['Mapping cleanup'],
        dataSource: 'search_term',
      })
    }
  }

  const priorityRank: Record<ActionPriority, number> = { High: 0, Medium: 1, Low: 2 }
  return items
    .sort((a, b) => {
      if (priorityRank[a.priority] !== priorityRank[b.priority]) return priorityRank[a.priority] - priorityRank[b.priority]
      const aImpact = Math.abs(a.afterMetrics.sales ?? 0) + Math.abs(a.beforeMetrics.sales ?? 0)
      const bImpact = Math.abs(b.afterMetrics.sales ?? 0) + Math.abs(b.beforeMetrics.sales ?? 0)
      return bImpact - aImpact
    })
}

export type ActionQueueSummary = {
  highPriorityCount: number
  wasteSpendFound: number
  skusNeedingListingCheck: number
  searchTermsNeedingNegativeReview: number
  mappingCleanupCount: number
}

export function summarizeActionQueue(items: ActionItem[]): ActionQueueSummary {
  return {
    highPriorityCount: items.filter(i => i.priority === 'High').length,
    wasteSpendFound: round2(items.filter(i => i.issueType === 'High spend zero orders').reduce((sum, i) => sum + (i.afterMetrics.spend ?? 0), 0)),
    skusNeedingListingCheck: items.filter(i => i.entityType === 'SKU' && (i.issueType === 'Clicks continued but sales collapsed' || i.issueType === 'Conversion/listing issue suspected')).length,
    searchTermsNeedingNegativeReview: items.filter(i => i.entityType === 'Search Term' && i.issueType === 'High spend zero orders').length,
    mappingCleanupCount: items.filter(i => i.issueType === 'Mapping cleanup').length,
  }
}
