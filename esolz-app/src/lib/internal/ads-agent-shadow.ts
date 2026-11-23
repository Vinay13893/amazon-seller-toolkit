import { createHash } from 'node:crypto'

export type AdsAgentMode = 'shadow' | 'approval' | 'autopilot'

export type AdsAgentSettings = {
  mode: AdsAgentMode
  emergencyStop: boolean
  targetAcosPercent: number
  maxBidChangePercent: number
  minimumClicks: number
  minimumSpend: number
  lookbackDays: number
  cooldownHours: number
  maxDataAgeDays: number
}
export type AdsTargetEvidence = {
  workspaceId: string
  profileId: string
  campaignId: string
  adGroupId: string
  entityId: string
  currentBid: number
  impressions: number
  clicks: number
  spend: number
  purchases: number
  sales: number
  dataThrough: string
  eligibleForAds: boolean | null
}

export type AdsAgentRecommendation = {
  actionKey: string
  actionType: 'decrease_bid' | 'pause_target'
  reasonCode: 'wasted_spend' | 'acos_above_guardrail' | 'product_not_eligible'
  currentValue: number
  proposedValue: number | null
  changePercent: number | null
  entityId: string
  campaignId: string
  adGroupId: string
  dataThrough: string
  evidence: {
    impressions: number
    clicks: number
    spend: number
    purchases: number
    sales: number
    acosPercent: number | null
    lookbackDays: number
  }
}
function isoDayNumber(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / 86_400_000)
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function actionKey(row: AdsTargetEvidence, actionType: AdsAgentRecommendation['actionType']): string {
  return createHash('sha256')
    .update([row.workspaceId, row.profileId, row.entityId, actionType, row.dataThrough].join('|'))
    .digest('hex')
}

export function evaluateAdsTarget(
  row: AdsTargetEvidence,
  settings: AdsAgentSettings,
  now = new Date(),
): AdsAgentRecommendation | null {
  if (settings.emergencyStop) return null
  if (!row.workspaceId || !row.profileId || !row.campaignId || !row.adGroupId || !row.entityId) return null
  if (!Number.isFinite(row.currentBid) || row.currentBid <= 0) return null
  if (!Number.isFinite(row.spend) || row.spend < 0 || !Number.isFinite(row.sales) || row.sales < 0) return null

  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000)
  const ageDays = today - isoDayNumber(row.dataThrough)
  if (ageDays < 0 || ageDays > settings.maxDataAgeDays) return null

  const evidence = {
    impressions: row.impressions,
    clicks: row.clicks,
    spend: roundCurrency(row.spend),
    purchases: row.purchases,
    sales: roundCurrency(row.sales),
    acosPercent: row.sales > 0 ? roundCurrency((row.spend / row.sales) * 100) : null,
    lookbackDays: settings.lookbackDays,
  }

  if (row.eligibleForAds === false) {
    return {
      actionKey: actionKey(row, 'pause_target'),
      actionType: 'pause_target',
      reasonCode: 'product_not_eligible',
      currentValue: roundCurrency(row.currentBid),
      proposedValue: null,
      changePercent: null,
      entityId: row.entityId,
      campaignId: row.campaignId,
      adGroupId: row.adGroupId,
      dataThrough: row.dataThrough,
      evidence,
    }
  }

  if (row.clicks < settings.minimumClicks || row.spend < settings.minimumSpend) return null

  const acosPercent = evidence.acosPercent
  const wastedSpend = row.purchases === 0
  const highAcos = row.purchases > 0
    && acosPercent !== null
    && acosPercent > settings.targetAcosPercent * 1.25
  if (!wastedSpend && !highAcos) return null

  const changePercent = -Math.min(Math.max(settings.maxBidChangePercent, 0), 10)
  const proposedValue = Math.max(0.02, roundCurrency(row.currentBid * (1 + changePercent / 100)))

  return {
    actionKey: actionKey(row, 'decrease_bid'),
    actionType: 'decrease_bid',
    reasonCode: wastedSpend ? 'wasted_spend' : 'acos_above_guardrail',
    currentValue: roundCurrency(row.currentBid),
    proposedValue,
    changePercent,
    entityId: row.entityId,
    campaignId: row.campaignId,
    adGroupId: row.adGroupId,
    dataThrough: row.dataThrough,
    evidence,
  }
}

