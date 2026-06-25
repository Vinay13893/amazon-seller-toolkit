// Phase 1F: Brahmastra Manual Review Candidates. Joins High/Medium-priority
// action-queue items to their correlated Change History events, scores each
// (item × change) pair, and emits a ranked, team-facing review list.
// IMPORTANT: every row is a correlation-based SUGGESTION for manual review,
// never a causal claim and never an automated action. Wording stays
// "review whether...", "compare...", "do not revert blindly".

import type { ActionItemWithChanges, RelatedChange, RelatedChangeMatchStrength } from './easyhome-change-history-diagnostic'

export type TimingBucket = 'before decline' | 'during decline' | 'after decline'
export type ReviewChangeType = 'bid increased' | 'bid reduced' | 'bid unchanged' | 'target paused' | 'target enabled' | 'created' | 'other'

export type ManualReviewCandidate = {
  rank: number
  score: number
  priority: string
  portfolio: string
  campaignName: string | null
  adGroupName: string | null
  entityType: string
  entity: string
  issueType: string
  salesDecline: number | null
  beforeAcos: number | null
  afterAcos: number | null
  beforeRoas: number | null
  afterRoas: number | null
  relatedChangeAt: string
  timingBucket: TimingBucket
  changeType: ReviewChangeType
  fromValue: string | null
  toValue: string | null
  changeMagnitude: number | null
  matchStrength: RelatedChangeMatchStrength
  suggestedReviewAction: string
  evidenceSummary: string
}

function round2(v: number): number { return Math.round(v * 100) / 100 }
function inr(v: number): string { return `₹${Math.round(v).toLocaleString('en-IN')}` }

function timingBucketOf(change: RelatedChange): TimingBucket {
  return change.timing === 'Changed before decline' ? 'before decline' : 'during decline'
}

function reviewChangeTypeOf(change: RelatedChange): ReviewChangeType {
  const t = change.changeType.toUpperCase()
  if (t === 'BID_AMOUNT') {
    const from = Number(change.oldValue); const to = Number(change.newValue)
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (to > from) return 'bid increased'
      if (to < from) return 'bid reduced'
      return 'bid unchanged'
    }
    return 'bid unchanged'
  }
  if (t === 'STATUS') {
    const o = (change.oldValue ?? '').toUpperCase(); const n = (change.newValue ?? '').toUpperCase()
    if (o === 'ENABLED' && n === 'PAUSED') return 'target paused'
    if (o === 'PAUSED' && n === 'ENABLED') return 'target enabled'
    return 'other'
  }
  if (t === 'CREATED') return 'created'
  return 'other'
}

function changeMagnitudeOf(change: RelatedChange): number | null {
  if (change.changeType.toUpperCase() !== 'BID_AMOUNT') return null
  const from = Number(change.oldValue); const to = Number(change.newValue)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return round2(Math.abs(to - from))
}

function suggestedReviewActionOf(changeType: ReviewChangeType, timing: TimingBucket): string {
  switch (changeType) {
    case 'bid reduced':
      return 'Review whether bid should be restored to previous level. Compare old bid vs current bid. Do not revert blindly.'
    case 'bid increased':
      return 'Check stock, buy box, coupon, price, reviews, delivery promise before increasing bid further. Review manually.'
    case 'bid unchanged':
      return 'Review manually; bid value did not materially change.'
    case 'target paused':
      return timing === 'before decline'
        ? 'Review whether pausing this target before the drop was intended. Compare old vs current state. Do not revert blindly.'
        : 'Review whether this pause is intended; compare performance before/after. Do not revert blindly.'
    case 'target enabled':
      return 'Review whether enabling this target is performing as expected. Review manually.'
    case 'created':
      return 'Review whether the newly created target/keyword is performing. Review manually.'
    default:
      return 'Review manually.'
  }
}

const PRIORITY_SCORE: Record<string, number> = { High: 100, Medium: 40, Low: 10 }
const MATCH_SCORE: Record<RelatedChangeMatchStrength, number> = {
  'exact target match': 30,
  'campaign match': 15,
  'fallback name match': 5,
}

function scoreCandidate(item: ActionItemWithChanges, change: RelatedChange): number {
  let score = PRIORITY_SCORE[item.priority] ?? 0
  // Pre-15-June changes rank highest (most actionable for "what changed before the drop").
  if (change.timing === 'Changed before decline') {
    score += 50
    if (change.daysBeforeAfterStart !== null) {
      if (change.daysBeforeAfterStart <= 3) score += 20
      else if (change.daysBeforeAfterStart <= 7) score += 10
    }
  } else {
    score += 20
  }
  score += MATCH_SCORE[change.matchStrength]
  const decline = item.beforeMetrics.sales !== null && item.afterMetrics.sales !== null
    ? item.afterMetrics.sales - item.beforeMetrics.sales : null
  if (decline !== null && decline < 0) score += Math.min(Math.abs(decline) / 1000, 100)
  if (item.beforeMetrics.acos !== null && item.afterMetrics.acos !== null && item.afterMetrics.acos > item.beforeMetrics.acos) score += 25
  // Bid reductions before the drop are an especially common review trigger.
  const ct = reviewChangeTypeOf(change)
  if (ct === 'bid reduced' && change.timing === 'Changed before decline') score += 15
  return round2(score)
}

export function buildManualReviewCandidates(actionQueue: ActionItemWithChanges[]): ManualReviewCandidate[] {
  // Count repeated pre-drop changes per campaign for the evidence note.
  const preDropChangesByCampaign = new Map<string, number>()
  for (const item of actionQueue) {
    for (const c of item.relatedChanges) {
      if (c.timing === 'Changed before decline' && c.campaignName) {
        const k = c.campaignName.trim().toUpperCase()
        preDropChangesByCampaign.set(k, (preDropChangesByCampaign.get(k) ?? 0) + 1)
      }
    }
  }

  const rows: Omit<ManualReviewCandidate, 'rank'>[] = []
  for (const item of actionQueue) {
    if (item.relatedChanges.length === 0) continue
    const decline = item.beforeMetrics.sales !== null && item.afterMetrics.sales !== null
      ? round2(item.afterMetrics.sales - item.beforeMetrics.sales) : null
    const beforeRoas = item.beforeMetrics.spend && item.beforeMetrics.spend > 0 && item.beforeMetrics.sales !== null
      ? round2(item.beforeMetrics.sales / item.beforeMetrics.spend) : null
    const afterRoas = item.afterMetrics.spend && item.afterMetrics.spend > 0 && item.afterMetrics.sales !== null
      ? round2(item.afterMetrics.sales / item.afterMetrics.spend) : null
    for (const change of item.relatedChanges) {
      const timingBucket = timingBucketOf(change)
      const changeType = reviewChangeTypeOf(change)
      const magnitude = changeMagnitudeOf(change)
      const campKey = change.campaignName?.trim().toUpperCase() ?? ''
      const repeatedPreDrop = preDropChangesByCampaign.get(campKey) ?? 0

      const evidenceParts: string[] = []
      evidenceParts.push(`${item.priority}-priority ${item.entityType} "${item.entityName}"`)
      if (decline !== null && decline < 0) evidenceParts.push(`ad sales ${inr(item.beforeMetrics.sales ?? 0)}→${inr(item.afterMetrics.sales ?? 0)} (${inr(decline)})`)
      if (item.beforeMetrics.acos !== null && item.afterMetrics.acos !== null) evidenceParts.push(`ACOS ${item.beforeMetrics.acos.toFixed(1)}%→${item.afterMetrics.acos.toFixed(1)}%`)
      evidenceParts.push(`${change.description.toLowerCase()} on ${change.changedAtIso.slice(0, 10)} (${timingBucket}${change.daysBeforeAfterStart !== null ? `, ${change.daysBeforeAfterStart}d before` : ''})`)
      evidenceParts.push(`match: ${change.matchStrength}`)
      if (change.timing === 'Changed before decline' && repeatedPreDrop >= 3) evidenceParts.push(`${repeatedPreDrop} pre-drop changes on this campaign`)

      rows.push({
        score: scoreCandidate(item, change),
        priority: item.priority,
        portfolio: item.portfolio,
        campaignName: change.campaignName,
        adGroupName: change.adGroupName,
        entityType: item.entityType,
        entity: item.entityName,
        issueType: item.issueType,
        salesDecline: decline,
        beforeAcos: item.beforeMetrics.acos,
        afterAcos: item.afterMetrics.acos,
        beforeRoas,
        afterRoas,
        relatedChangeAt: change.changedAtIso,
        timingBucket,
        changeType,
        fromValue: change.oldValue,
        toValue: change.newValue,
        changeMagnitude: magnitude,
        matchStrength: change.matchStrength,
        suggestedReviewAction: suggestedReviewActionOf(changeType, timingBucket),
        evidenceSummary: evidenceParts.join('; ') + '.',
      })
    }
  }

  rows.sort((a, b) => b.score - a.score)
  return rows.map((row, i) => ({ rank: i + 1, ...row }))
}
