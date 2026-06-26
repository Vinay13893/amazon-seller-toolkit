// Phase 1G: groups raw Manual Review Candidates (one row per action-item ×
// change pair) into actionable "Manual Review Cases" — one row per underlying
// entity (target / SKU / search term / campaign), merging duplicate facets
// (sales-loss vs ACOS-worsened) and all related change events.
// IMPORTANT: read-only review bookkeeping. Every field is a correlation-based
// suggestion for manual review, never a causal claim or automated action.

import type { ManualReviewCandidate, ReviewChangeType, TimingBucket } from './easyhome-manual-review-candidates'
import type { RelatedChangeMatchStrength } from './easyhome-change-history-diagnostic'
import { entityDisplayLabel, resolveEasyhomePortfolio } from './portfolio-labels'

export type CaseTimingBucket = TimingBucket | 'mixed'

export type CaseReviewStatus =
  | 'Not reviewed' | 'Reviewing' | 'Restore old bid? maybe' | 'Keep current bid'
  | 'Check listing first' | 'Pause/negative review' | 'Done' | 'Ignore'
  | 'Restore old bid manually' | 'Partial bid correction manually'

export type ExpectedMetric = 'sales' | 'ACOS' | 'spend' | 'clicks' | 'orders' | 'conversion rate'

export type CaseRelatedChange = {
  changeType: ReviewChangeType
  fromValue: string | null
  toValue: string | null
  changedAt: string
  timingBucket: TimingBucket
}

export type CaseReviewFields = {
  status: CaseReviewStatus
  owner: string | null
  decision: string | null
  reason: string | null
  nextCheckDate: string | null
  notes: string | null
  decisionDate: string | null
  expectedMetrics: ExpectedMetric[]
  stockChecked: boolean
  buyBoxChecked: boolean
  couponChecked: boolean
  priceChecked: boolean
  reviewsChecked: boolean
  deliveryPromiseChecked: boolean
  listingActiveChecked: boolean
  liveBidChecked: boolean
  liveStatusChecked: boolean
  liveBudgetChecked: boolean
}

export type ManualReviewCase = {
  caseKey: string
  rank: number
  score: number
  priority: string
  portfolio: string
  campaignName: string | null
  adGroupName: string | null
  mainEntity: string
  entityTypes: string[]
  issueSummary: string
  combinedSalesDecline: number | null
  worstAcosBefore: number | null
  worstAcosAfter: number | null
  worstRoasBefore: number | null
  worstRoasAfter: number | null
  relatedChangesCount: number
  relatedChanges: CaseRelatedChange[]
  earliestRelatedChange: string | null
  latestRelatedChange: string | null
  timingBucket: CaseTimingBucket
  changeSummary: ReviewChangeType[]
  fromValues: string[]
  toValues: string[]
  matchStrength: RelatedChangeMatchStrength
  facetCount: number
  evidenceSummary: string
  suggestedReviewAction: string
  doNotRevertWarning: string
  // workflow (from internal_ads_review_case_reviews; defaults when none saved)
  status: CaseReviewStatus
  owner: string | null
  decision: string | null
  reason: string | null
  nextCheckDate: string | null
  notes: string | null
  decisionDate: string | null
  expectedMetrics: ExpectedMetric[]
  stockChecked: boolean
  buyBoxChecked: boolean
  couponChecked: boolean
  priceChecked: boolean
  reviewsChecked: boolean
  deliveryPromiseChecked: boolean
  listingActiveChecked: boolean
  liveBidChecked: boolean
  liveStatusChecked: boolean
  liveBudgetChecked: boolean
}

const MATCH_RANK: Record<RelatedChangeMatchStrength, number> = {
  'exact target match': 3, 'campaign match': 2, 'fallback name match': 1,
}
const MATCH_BY_RANK: Record<number, RelatedChangeMatchStrength> = {
  3: 'exact target match', 2: 'campaign match', 1: 'fallback name match',
}
const PRIORITY_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 }
const PRIORITY_BY_RANK: Record<number, string> = { 3: 'High', 2: 'Medium', 1: 'Low' }

function round2(v: number): number { return Math.round(v * 100) / 100 }
function inr(v: number): string { return `₹${Math.round(v).toLocaleString('en-IN')}` }

/**
 * Normalizes an action-item entity name into a stable grouping token so the
 * same underlying entity merges across facets:
 *  - `asin="B08JZ8SS2H" (TARGETING_EXPRESSION)` -> `b08jz8ss2h`
 *  - `interlocking play mats for kids (EXACT)`  -> `interlocking play mats for kids`
 *  - search term `b08jz8ss2h`                   -> `b08jz8ss2h`  (merges with the asin target)
 */
function normalizeEntityToken(entity: string): string {
  let s = entity.trim().toLowerCase()
  const asin = s.match(/asin\s*=\s*"?([a-z0-9]+)"?/i)
  if (asin) return asin[1].toLowerCase()
  s = s.replace(/\s*\((exact|phrase|broad|targeting_expression|targeting_expression_predefined)\)\s*$/i, '')
  return s.trim()
}

function caseKeyOf(c: ManualReviewCandidate): string {
  const camp = (c.campaignName ?? '').trim().toUpperCase()
  return `${camp}||${normalizeEntityToken(c.entity)}`
}

function suggestedActionForCase(changeTypes: Set<ReviewChangeType>, timing: CaseTimingBucket): string {
  if (changeTypes.has('bid reduced') && (changeTypes.has('bid increased'))) {
    return 'Bids moved both up and down around the drop window. Compare old vs current bid and review whether the net change should be restored. Do not revert blindly.'
  }
  if (changeTypes.has('bid reduced')) {
    return 'Review whether bid should be restored to previous level. Compare old vs current bid. Do not revert blindly.'
  }
  if (changeTypes.has('bid increased')) {
    return 'Check stock, buy box, coupon, price, reviews, delivery promise before increasing bid further. Review manually.'
  }
  if (changeTypes.has('target paused')) {
    return 'Review whether pausing this target is intended; compare performance before/after. Do not revert blindly.'
  }
  if (changeTypes.has('target enabled')) {
    return 'Review whether enabling this target is performing as expected. Review manually.'
  }
  if (changeTypes.has('created')) {
    return 'Review whether the newly created target/keyword is performing. Review manually.'
  }
  return 'Review manually.'
}

export function buildManualReviewCases(
  candidates: ManualReviewCandidate[],
  reviewStatuses: Map<string, CaseReviewFields>,
): ManualReviewCase[] {
  const groups = new Map<string, ManualReviewCandidate[]>()
  for (const c of candidates) {
    const key = caseKeyOf(c)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c)
  }

  const cases: Omit<ManualReviewCase, 'rank'>[] = []
  for (const [caseKey, facets] of groups.entries()) {
    // Distinct change events across all facets of this case.
    const changeSeen = new Set<string>()
    const changeTypes = new Set<ReviewChangeType>()
    const fromValues = new Set<string>()
    const toValues = new Set<string>()
    const timings = new Set<TimingBucket>()
    const relatedChanges: CaseRelatedChange[] = []
    let earliest: string | null = null
    let latest: string | null = null
    let relatedChangesCount = 0
    let maxMagnitude = 0
    for (const f of facets) {
      const cid = `${f.relatedChangeAt}|${f.changeType}|${f.fromValue ?? ''}|${f.toValue ?? ''}`
      if (changeSeen.has(cid)) continue
      changeSeen.add(cid)
      relatedChangesCount += 1
      changeTypes.add(f.changeType)
      if (f.fromValue) fromValues.add(f.fromValue)
      if (f.toValue) toValues.add(f.toValue)
      timings.add(f.timingBucket)
      relatedChanges.push({ changeType: f.changeType, fromValue: f.fromValue, toValue: f.toValue, changedAt: f.relatedChangeAt, timingBucket: f.timingBucket })
      if (f.changeMagnitude !== null) maxMagnitude = Math.max(maxMagnitude, f.changeMagnitude)
      if (!earliest || f.relatedChangeAt < earliest) earliest = f.relatedChangeAt
      if (!latest || f.relatedChangeAt > latest) latest = f.relatedChangeAt
    }
    relatedChanges.sort((a, b) => a.changedAt.localeCompare(b.changedAt))

    // Representative metrics: worst (most negative) decline + worst ACOS/ROAS worsening among facets.
    let combinedSalesDecline: number | null = null
    let worstAcosBefore: number | null = null
    let worstAcosAfter: number | null = null
    let worstRoasBefore: number | null = null
    let worstRoasAfter: number | null = null
    let worstAcosGap = -Infinity
    let priorityRank = 0
    let matchRank = 0
    const entityTypes = new Set<string>()
    const issueTypes = new Set<string>()
    let mainEntity = facets[0].entity
    let mainEntityPriorityRank = 0
    let portfolio = resolveEasyhomePortfolio(facets[0].portfolio, facets[0].campaignName, facets[0].adGroupName, facets[0].entity)
    let campaignName = facets.find(f => f.campaignName)?.campaignName ?? facets[0].campaignName
    let adGroupName: string | null = null

    for (const f of facets) {
      entityTypes.add(f.entityType)
      issueTypes.add(f.issueType)
      if (f.salesDecline !== null && f.salesDecline < 0) {
        combinedSalesDecline = combinedSalesDecline === null ? f.salesDecline : Math.min(combinedSalesDecline, f.salesDecline)
      }
      if (f.beforeAcos !== null && f.afterAcos !== null) {
        const gap = f.afterAcos - f.beforeAcos
        if (gap > worstAcosGap) {
          worstAcosGap = gap; worstAcosBefore = f.beforeAcos; worstAcosAfter = f.afterAcos
          worstRoasBefore = f.beforeRoas; worstRoasAfter = f.afterRoas
        }
      }
      priorityRank = Math.max(priorityRank, PRIORITY_RANK[f.priority] ?? 0)
      matchRank = Math.max(matchRank, MATCH_RANK[f.matchStrength])
      if (f.adGroupName) adGroupName = f.adGroupName
      // Prefer the entity label from the highest-priority facet for display.
      const pr = PRIORITY_RANK[f.priority] ?? 0
      if (pr > mainEntityPriorityRank) {
        mainEntityPriorityRank = pr
        mainEntity = f.entity
        portfolio = resolveEasyhomePortfolio(f.portfolio, f.campaignName, f.adGroupName, f.entity)
        campaignName = f.campaignName ?? campaignName
      }
    }

    const timingBucket: CaseTimingBucket = timings.size === 0 ? 'after decline' : timings.size > 1 ? 'mixed' : [...timings][0]

    // Case score: priority + best match + sales decline + ACOS worsening
    // + pre-drop timing + repeated changes + multi-facet corroboration.
    let score = (PRIORITY_RANK[PRIORITY_BY_RANK[priorityRank]] ?? 0) * 33
    score += MATCH_RANK[MATCH_BY_RANK[matchRank]] * 10
    if (combinedSalesDecline !== null) score += Math.min(Math.abs(combinedSalesDecline) / 1000, 100)
    if (worstAcosGap > 0 && Number.isFinite(worstAcosGap)) score += Math.min(worstAcosGap, 50)
    if (timings.has('before decline')) score += 40
    if (relatedChangesCount >= 3) score += 20
    else if (relatedChangesCount === 2) score += 8
    if (facets.length >= 3) score += 15
    else if (facets.length === 2) score += 6
    score += Math.min(maxMagnitude, 30)
    score = round2(score)

    const priority = PRIORITY_BY_RANK[priorityRank] ?? 'Low'
    const matchStrength = MATCH_BY_RANK[matchRank]
    const review = reviewStatuses.get(caseKey)

    const evParts: string[] = []
    evParts.push(`${priority}-priority ${[...entityTypes].join('/')} "${entityDisplayLabel(mainEntity)}" on campaign "${campaignName ?? '—'}"`)
    if (combinedSalesDecline !== null) evParts.push(`ad sales decline ${inr(combinedSalesDecline)}`)
    if (worstAcosBefore !== null && worstAcosAfter !== null) evParts.push(`ACOS ${worstAcosBefore.toFixed(1)}%→${worstAcosAfter.toFixed(1)}%`)
    evParts.push(`${relatedChangesCount} related change(s) [${[...changeTypes].join(', ')}] ${timingBucket}`)
    if (earliest) evParts.push(`between ${earliest.slice(0, 10)} and ${(latest ?? earliest).slice(0, 10)}`)
    if (facets.length > 1) evParts.push(`${facets.length} evidence facets merged`)
    evParts.push(`match: ${matchStrength}`)

    cases.push({
      caseKey,
      score,
      priority,
      portfolio,
      campaignName,
      adGroupName,
      mainEntity,
      entityTypes: [...entityTypes],
      issueSummary: [...issueTypes].join('; '),
      combinedSalesDecline: combinedSalesDecline === null ? null : round2(combinedSalesDecline),
      worstAcosBefore,
      worstAcosAfter,
      worstRoasBefore,
      worstRoasAfter,
      relatedChangesCount,
      relatedChanges,
      earliestRelatedChange: earliest,
      latestRelatedChange: latest,
      timingBucket,
      changeSummary: [...changeTypes],
      fromValues: [...fromValues],
      toValues: [...toValues],
      matchStrength,
      facetCount: facets.length,
      evidenceSummary: evParts.join('; ') + '.',
      suggestedReviewAction: suggestedActionForCase(changeTypes, timingBucket),
      doNotRevertWarning: 'Correlated with the post-15-June window, not a confirmed cause. Compare old vs current before any change. Do not revert blindly.',
      status: review?.status ?? 'Not reviewed',
      owner: review?.owner ?? null,
      decision: review?.decision ?? null,
      reason: review?.reason ?? null,
      nextCheckDate: review?.nextCheckDate ?? null,
      notes: review?.notes ?? null,
      decisionDate: review?.decisionDate ?? null,
      expectedMetrics: review?.expectedMetrics ?? [],
      stockChecked: review?.stockChecked ?? false,
      buyBoxChecked: review?.buyBoxChecked ?? false,
      couponChecked: review?.couponChecked ?? false,
      priceChecked: review?.priceChecked ?? false,
      reviewsChecked: review?.reviewsChecked ?? false,
      deliveryPromiseChecked: review?.deliveryPromiseChecked ?? false,
      listingActiveChecked: review?.listingActiveChecked ?? false,
      liveBidChecked: review?.liveBidChecked ?? false,
      liveStatusChecked: review?.liveStatusChecked ?? false,
      liveBudgetChecked: review?.liveBudgetChecked ?? false,
    })
  }

  cases.sort((a, b) => b.score - a.score)
  return cases.map((c, i) => ({ rank: i + 1, ...c }))
}
