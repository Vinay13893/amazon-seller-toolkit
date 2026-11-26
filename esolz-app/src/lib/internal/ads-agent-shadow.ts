import { createHash } from 'node:crypto'
import type { DecisionSignals } from './ads-agent-signals'

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
  signals?: DecisionSignals
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
    signals?: DecisionSignals
    executionAllowed: false
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
    .update([row.workspaceId, row.profileId, row.campaignId, row.adGroupId, row.entityId, actionType, row.dataThrough].join('|'))
    .digest('hex')
}

export function evaluateAdsTarget(
  row: AdsTargetEvidence,
  settings: AdsAgentSettings,
  now = new Date(),
): AdsAgentRecommendation | null {
  // The stop remains engaged for execution; this evaluator is shadow-only.
  if (settings.mode !== 'shadow') return null
  if (![settings.targetAcosPercent, settings.maxBidChangePercent, settings.minimumClicks,
    settings.minimumSpend, settings.lookbackDays, settings.cooldownHours, settings.maxDataAgeDays]
    .every(Number.isFinite)) return null
  if (settings.targetAcosPercent <= 0 || settings.maxBidChangePercent <= 0
    || settings.minimumClicks < 1 || settings.minimumSpend < 0
    || settings.lookbackDays < 7 || settings.lookbackDays > 30
    || settings.cooldownHours < 1 || settings.maxDataAgeDays < 1) return null
  if (!row.workspaceId || !row.profileId || !row.campaignId || !row.adGroupId || !row.entityId) return null
  if (!Number.isFinite(row.currentBid) || row.currentBid <= 0) return null
  if (!Number.isFinite(row.spend) || row.spend < 0 || !Number.isFinite(row.sales) || row.sales < 0) return null
  if (![row.impressions, row.clicks, row.purchases].every(v => Number.isFinite(v) && v >= 0)) return null

  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000)
  const ageDays = today - isoDayNumber(row.dataThrough)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dataThrough) || !Number.isFinite(ageDays)
    || ageDays <= 0 || ageDays > settings.maxDataAgeDays) return null

  const evidence = {
    impressions: row.impressions,
    clicks: row.clicks,
    spend: roundCurrency(row.spend),
    purchases: row.purchases,
    sales: roundCurrency(row.sales),
    acosPercent: row.sales > 0 ? roundCurrency((row.spend / row.sales) * 100) : null,
    lookbackDays: settings.lookbackDays,
    signals: row.signals,
    executionAllowed: false as const,
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
  const wastedSpend = row.purchases === 0 && row.sales === 0
  const highAcos = row.purchases > 0
    && acosPercent !== null
    && acosPercent > settings.targetAcosPercent * 1.25
  if (!wastedSpend && !highAcos) return null

  // Improving organic position tempers a high-ACOS decrease, without claiming causality.
  const cap = highAcos && row.signals?.organicTrend === 'improving' ? Math.min(5, settings.maxBidChangePercent / 2) : 10
  const changePercent = -Math.min(settings.maxBidChangePercent, cap)
  const proposedValue = Math.max(0.02, Math.ceil(row.currentBid * (1 + changePercent / 100) * 100 - 1e-9) / 100)
  if (proposedValue >= row.currentBid) return null

  return {
    actionKey: actionKey(row, 'decrease_bid'),
    actionType: 'decrease_bid',
    reasonCode: wastedSpend ? 'wasted_spend' : 'acos_above_guardrail',
    currentValue: roundCurrency(row.currentBid),
    proposedValue,
    changePercent: roundCurrency((proposedValue / row.currentBid - 1) * 100),
    entityId: row.entityId,
    campaignId: row.campaignId,
    adGroupId: row.adGroupId,
    dataThrough: row.dataThrough,
    evidence,
  }
}

