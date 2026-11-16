import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { getWorkspaceTrackerEntitlements } from './workspace-entitlements'

type KeywordTarget = { ownAsin: string | null; trackedAsinId: string | null }

export async function checkKeywordCapacity(workspaceId: string, target: KeywordTarget) {
  const limits = await getWorkspaceTrackerEntitlements(workspaceId)
  if (!limits.keywordsEnabled) return { ok: false as const, status: 403, error: 'Keyword tracking is not included in your plan.' }

  const admin = createAdminClient()
  const { data, error, count } = await admin
    .from('tracked_keywords')
    .select('own_asin,tracked_asin_id', { count: 'exact' })
    .eq('workspace_id', workspaceId)
  if (error) throw error
  if ((count ?? 0) >= limits.keywordLimit) {
    return { ok: false as const, status: 403, error: `Your plan allows ${limits.keywordLimit} tracked keywords.` }
  }

  if (target.ownAsin || target.trackedAsinId) {
    const key = target.ownAsin ? `own:${target.ownAsin}` : `competitor:${target.trackedAsinId}`
    const targetKeys = new Set((data ?? []).flatMap(row => {
      if (row.own_asin) return [`own:${row.own_asin}`]
      if (row.tracked_asin_id) return [`competitor:${row.tracked_asin_id}`]
      return []
    }))
    const targetCount = (data ?? []).filter(row =>
      target.ownAsin ? row.own_asin === target.ownAsin : row.tracked_asin_id === target.trackedAsinId,
    ).length
    if (targetCount >= limits.keywordsPerAsin) {
      return { ok: false as const, status: 403, error: `Your plan allows ${limits.keywordsPerAsin} keywords per ASIN.` }
    }
    if (!targetKeys.has(key) && targetKeys.size >= limits.keywordAsinLimit) {
      return { ok: false as const, status: 403, error: `Your plan allows keyword tracking for ${limits.keywordAsinLimit} ASINs, including your own and competitors.` }
    }
  }

  return { ok: true as const, limits }
}
