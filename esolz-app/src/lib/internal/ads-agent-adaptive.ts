export type AdaptiveState = 'explore' | 'scale' | 'defend' | 'harvest' | 'repair' | 'waste' | 'hold'

export type WindowMetrics = {
  days: number
  sampleDays: number
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
}

export type RankSignal = {
  organicRank: number | null
  sponsoredRank: number | null
  organicRankChange7d: number | null
}

export type RetailSignal = {
  buyBoxEligible: boolean | null
  inStock: boolean | null
  daysOfCover: number | null
  contributionMarginPercent: number | null
  returnsRatePercent: number | null
}

export type AdaptiveInput = {
  currentBid: number
  baseline90: WindowMetrics
  recent7: WindowMetrics
  recent14: WindowMetrics
  recent30: WindowMetrics
  rank: RankSignal
  retail: RetailSignal
  targetAcosPercent: number
  maxBidChangePercent: number
  dataAgeDays: number
  attributionMature: boolean
  hasConflictingChange: boolean
  cooldownComplete: boolean
}

export type AdaptiveDecision = {
  state: AdaptiveState
  action: 'increase_bid' | 'decrease_bid' | 'pause_target' | 'hold'
  proposedBid: number | null
  changePercent: number
  confidence: number
  reason: string
  blockers: string[]
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function bounded(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function hold(reason: string, blockers: string[], state: AdaptiveState = 'hold'): AdaptiveDecision {
  return { state, action: 'hold', proposedBid: null, changePercent: 0, confidence: 0, reason, blockers }
}

/**
 * Pure decision policy for the control plane. It deliberately returns a
 * recommendation only; a separate, disabled-by-default executor is required
 * for any Amazon write.
 */
export function evaluateAdaptiveBid(input: AdaptiveInput): AdaptiveDecision {
  const blockers: string[] = []
  if (!Number.isFinite(input.currentBid) || input.currentBid <= 0) blockers.push('invalid_current_bid')
  if (input.dataAgeDays < 0 || input.dataAgeDays > 2) blockers.push('stale_data')
  if (!input.attributionMature) blockers.push('attribution_incomplete')
  if (!input.cooldownComplete) blockers.push('cooldown_active')
  if (input.hasConflictingChange) blockers.push('conflicting_change')
  if (input.baseline90.sampleDays < 45) blockers.push('baseline_too_short')
  if (input.recent14.sampleDays < 7) blockers.push('recent_window_incomplete')
  if (blockers.length > 0) return hold('Safety gate blocked this change.', blockers)

  if (input.retail.inStock === false || input.retail.buyBoxEligible === false) {
    return {
      state: 'repair', action: 'pause_target', proposedBid: null, changePercent: 0,
      confidence: 0.98,
      reason: input.retail.inStock === false ? 'Product is out of stock.' : 'Product is not Buy Box eligible.',
      blockers: [],
    }
  }

  if (input.retail.daysOfCover !== null && input.retail.daysOfCover < 14) {
    return hold('Inventory cover is below the growth safety threshold.', ['inventory_risk'], 'harvest')
  }

  const recentAcos = safeRatio(input.recent14.spend * 100, input.recent14.sales)
  const baselineAcos = safeRatio(input.baseline90.spend * 100, input.baseline90.sales)
  const recentCvr = safeRatio(input.recent14.purchases, input.recent14.clicks)
  const baselineCvr = safeRatio(input.baseline90.purchases, input.baseline90.clicks)
  const minimumEvidence = input.recent14.clicks >= 8 && input.recent14.spend > 0
  const confidence = bounded(
    0.35 + Math.min(input.recent14.clicks, 40) / 100 + Math.min(input.recent14.purchases, 10) / 40,
    0,
    0.95,
  )

  if (!minimumEvidence) {
    return hold('Not enough clicks and spend to distinguish signal from noise.', ['low_confidence'], 'explore')
  }

  if (input.recent14.purchases === 0 && input.recent14.spend >= input.targetAcosPercent * 10) {
    const change = -bounded(input.maxBidChangePercent, 1, 10)
    return {
      state: 'waste', action: 'decrease_bid',
      proposedBid: Math.max(0.02, roundMoney(input.currentBid * (1 + change / 100))),
      changePercent: change, confidence,
      reason: 'Sufficient spend produced no attributed orders.', blockers: [],
    }
  }

  if (recentAcos !== null && recentAcos > input.targetAcosPercent * 1.2) {
    const change = -bounded(input.maxBidChangePercent, 1, 10)
    return {
      state: 'repair', action: 'decrease_bid',
      proposedBid: Math.max(0.02, roundMoney(input.currentBid * (1 + change / 100))),
      changePercent: change, confidence,
      reason: 'Recent ACOS is materially above the configured guardrail.', blockers: [],
    }
  }

  const marginKnown = input.retail.contributionMarginPercent !== null
  const profitSafe = marginKnown
    && recentAcos !== null
    && recentAcos < Math.min(input.targetAcosPercent * 0.85, input.retail.contributionMarginPercent as number)
  const conversionStable = baselineCvr !== null && recentCvr !== null && recentCvr >= baselineCvr * 0.9
  const rankNeedsDefense = input.rank.organicRank !== null
    && input.rank.organicRankChange7d !== null
    && input.rank.organicRankChange7d > 3

  if ((profitSafe && conversionStable) || (profitSafe && rankNeedsDefense)) {
    const change = bounded(Math.min(input.maxBidChangePercent, confidence >= 0.75 ? 10 : 5), 1, 10)
    return {
      state: rankNeedsDefense ? 'defend' : 'scale', action: 'increase_bid',
      proposedBid: roundMoney(input.currentBid * (1 + change / 100)),
      changePercent: change, confidence,
      reason: rankNeedsDefense
        ? 'Profit is protected while organic rank is weakening.'
        : 'Recent efficiency and conversion support controlled growth.',
      blockers: [],
    }
  }

  if (!marginKnown) {
    return hold('Contribution margin is unavailable, so growth cannot be proven profitable.', ['profit_incomplete'], 'hold')
  }

  if (baselineAcos !== null && recentAcos !== null && recentAcos <= baselineAcos * 1.05) {
    return hold('Performance is within the learned 90-day range.', [], 'harvest')
  }

  return hold('No statistically useful advantage was found.', ['no_clear_advantage'])
}
