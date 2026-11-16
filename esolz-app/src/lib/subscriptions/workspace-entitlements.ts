import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

type PlanFeatures = Record<string, unknown>

export type WorkspaceTrackerEntitlements = {
  planName: string
  asinLimit: number
  keywordLimit: number
  keywordAsinLimit: number
  keywordsPerAsin: number
  pincodeCheckLimit: number
  buyBoxAsinLimit: number
  competitorLimit: number
  bsrEnabled: boolean
  keywordsEnabled: boolean
  pincodeEnabled: boolean
  buyBoxEnabled: boolean
  refreshIntervalHours: number
}

const numberFeature = (features: PlanFeatures, key: string, fallback: number) => {
  const value = features[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export async function getWorkspaceTrackerEntitlements(workspaceId: string): Promise<WorkspaceTrackerEntitlements> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('workspace_subscriptions')
    .select('status,subscription_plans(name,asin_limit,keyword_limit,pincode_check_limit,competitor_limit,features)')
    .eq('workspace_id', workspaceId)
    .in('status', ['active', 'trialing'])
    .maybeSingle()

  if (error) throw error
  const embedded = data?.subscription_plans
  const plan = (Array.isArray(embedded) ? embedded[0] : embedded) as {
    name?: string
    asin_limit?: number
    keyword_limit?: number
    pincode_check_limit?: number
    competitor_limit?: number
    features?: PlanFeatures
  } | null | undefined
  const features = plan?.features ?? {}
  const planName = plan?.name ?? 'Free'
  const internal = planName === 'Internal Tester'
  const asinLimit = plan?.asin_limit ?? 5
  const keywordLimit = plan?.keyword_limit ?? 20

  return {
    planName,
    asinLimit,
    keywordLimit,
    keywordAsinLimit: numberFeature(features, 'keyword_asin_limit', internal ? 999999 : asinLimit),
    keywordsPerAsin: numberFeature(features, 'keywords_per_asin', internal ? 999999 : keywordLimit),
    pincodeCheckLimit: plan?.pincode_check_limit ?? 100,
    buyBoxAsinLimit: numberFeature(features, 'buybox_asin_limit', internal ? 999999 : asinLimit),
    competitorLimit: plan?.competitor_limit ?? 3,
    bsrEnabled: internal || features.bsr_tracker === true,
    keywordsEnabled: internal || features.keywords === true,
    pincodeEnabled: internal || features.pincode_checker === true,
    buyBoxEnabled: internal || features.buy_box === true,
    refreshIntervalHours: numberFeature(features, 'refresh_interval_hours', 24),
  }
}

export async function getTrackerEnabledWorkspaceIds() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('workspace_subscriptions')
    .select('workspace_id,status,subscription_plans(name,features)')
    .in('status', ['active', 'trialing'])
  if (error) throw error

  return (data ?? []).flatMap(row => {
    const embedded = row.subscription_plans
    const plan = (Array.isArray(embedded) ? embedded[0] : embedded) as { name?: string; features?: PlanFeatures } | null
    const features = plan?.features ?? {}
    return plan?.name === 'Internal Tester' || features.keywords === true || features.buy_box === true
      ? [row.workspace_id]
      : []
  })
}

export async function getPincodeEnabledWorkspaceIds() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('workspace_subscriptions')
    .select('workspace_id,status,subscription_plans(name,features)')
    .in('status', ['active', 'trialing'])
  if (error) throw error

  return (data ?? []).flatMap(row => {
    const embedded = row.subscription_plans
    const plan = (Array.isArray(embedded) ? embedded[0] : embedded) as { name?: string; features?: PlanFeatures } | null
    return plan?.name === 'Internal Tester' || plan?.features?.pincode_checker === true ? [row.workspace_id] : []
  })
}
