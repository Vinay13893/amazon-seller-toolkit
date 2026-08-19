import type { Marketplace } from '@/types'

export const MARKETPLACE_ID_BY_MARKETPLACE: Record<string, string> = {
  IN: 'A21TJRUUN4KGV',
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
}

const MARKETPLACE_BY_MARKETPLACE_ID: Record<string, Marketplace> = {
  A21TJRUUN4KGV: 'IN',
  ATVPDKIKX0DER: 'US',
  A1F83G8C2ARO7P: 'UK',
  A1PA6795UKMFR9: 'DE',
}

export type OwnCatalogListingIdentity = {
  id?: string | null
  asin: string | null
  marketplace_id: string | null
}

export type TrackedAsinIdentity = {
  id?: string | null
  asin: string | null
  marketplace: string | null
  status?: string | null
}

export type CheckerJobIdentity = {
  target_type: 'my_product' | 'competitor_asin'
  target_id: string
  status: string
  completed_at: string | null
  last_error_safe: string | null
}

export type NewAsinCheckerJob = {
  workspace_id: string
  job_type: string
  target_type: 'my_product' | 'competitor_asin'
  target_id: string
  marketplace_id: string
  payload_json: { asin: string }
}

type BuildAsinCheckerCandidatesInput = {
  workspaceId: string
  jobType: string
  listings: OwnCatalogListingIdentity[]
  trackedAsins: TrackedAsinIdentity[]
  activeJobs: CheckerJobIdentity[]
  remainingMyProducts: number
  remainingCompetitors: number
  forceRefresh: boolean
  nowMs: number
  cadenceHours: number
  pricingCooldownRetryMinutes: number
  rateLimitReasons: Set<string>
  defaultMarketplaceId: string
}

export type AsinCheckerCandidates = {
  candidates: NewAsinCheckerJob[]
  totalActiveMyProducts: number
  totalActiveCompetitors: number
}

export function marketplaceIdForMarketplace(marketplace: string | null | undefined): string | null {
  if (!marketplace) return null
  return MARKETPLACE_ID_BY_MARKETPLACE[marketplace.trim().toUpperCase()] ?? null
}

export function marketplaceFromMarketplaceId(marketplaceId: string): Marketplace {
  return MARKETPLACE_BY_MARKETPLACE_ID[marketplaceId] ?? 'IN'
}

function normalizedAsin(asin: string | null | undefined): string | null {
  const value = asin?.trim().toUpperCase()
  return value ? value : null
}

function ownCatalogKey(asin: string | null | undefined, marketplaceId: string | null | undefined): string | null {
  const normalized = normalizedAsin(asin)
  const marketplace = marketplaceId?.trim()
  if (!normalized || !marketplace) return null
  return `${normalized}:${marketplace}`
}

export function trackedAsinCatalogKey(row: TrackedAsinIdentity): string | null {
  return ownCatalogKey(row.asin, marketplaceIdForMarketplace(row.marketplace))
}

export function buildOwnCatalogKeySet(listings: OwnCatalogListingIdentity[]): Set<string> {
  const keys = new Set<string>()
  for (const listing of listings) {
    const key = ownCatalogKey(listing.asin, listing.marketplace_id)
    if (key) keys.add(key)
  }
  return keys
}

export function isTrackedAsinOwnCatalog(row: TrackedAsinIdentity, ownCatalogKeys: Set<string>): boolean {
  const key = trackedAsinCatalogKey(row)
  return key !== null && ownCatalogKeys.has(key)
}

export function isTrackedAsinCompetitor(row: TrackedAsinIdentity, ownCatalogKeys: Set<string>): boolean {
  if (row.status === 'archived') return false
  if (!normalizedAsin(row.asin)) return false
  if (!marketplaceIdForMarketplace(row.marketplace)) return false
  return !isTrackedAsinOwnCatalog(row, ownCatalogKeys)
}

export function filterCompetitorTrackedAsins<T extends TrackedAsinIdentity>(
  rows: T[],
  listings: OwnCatalogListingIdentity[],
): T[] {
  const ownCatalogKeys = buildOwnCatalogKeySet(listings)
  return rows.filter(row => isTrackedAsinCompetitor(row, ownCatalogKeys))
}

export function buildAsinCheckerJobCandidates({
  workspaceId,
  jobType,
  listings,
  trackedAsins,
  activeJobs,
  remainingMyProducts,
  remainingCompetitors,
  forceRefresh,
  nowMs,
  cadenceHours,
  pricingCooldownRetryMinutes,
  rateLimitReasons,
  defaultMarketplaceId,
}: BuildAsinCheckerCandidatesInput): AsinCheckerCandidates {
  const cadenceCutoff = nowMs - cadenceHours * 60 * 60 * 1000
  const rateLimitCutoff = nowMs - pricingCooldownRetryMinutes * 60 * 1000
  const skipKeys = new Set<string>()

  for (const job of activeJobs) {
    const key = `${job.target_type}:${job.target_id}`
    if (job.status === 'queued' || job.status === 'running') {
      skipKeys.add(key)
      continue
    }
    if (forceRefresh) continue
    if ((job.status === 'completed' || job.status === 'failed') && job.completed_at) {
      const completedAt = new Date(job.completed_at).getTime()
      const cutoff = rateLimitReasons.has(String(job.last_error_safe ?? '')) ? rateLimitCutoff : cadenceCutoff
      if (completedAt > cutoff) skipKeys.add(key)
    }
  }

  const candidates: NewAsinCheckerJob[] = []
  let selectedMyProducts = 0
  let totalActiveMyProducts = 0
  for (const listing of listings) {
    const asin = normalizedAsin(listing.asin)
    if (!asin || !listing.id) continue
    totalActiveMyProducts += 1
    if (selectedMyProducts >= remainingMyProducts) continue
    const key = `my_product:${listing.id}`
    if (skipKeys.has(key)) continue
    candidates.push({
      workspace_id: workspaceId,
      job_type: jobType,
      target_type: 'my_product',
      target_id: listing.id,
      marketplace_id: listing.marketplace_id ?? defaultMarketplaceId,
      payload_json: { asin },
    })
    selectedMyProducts += 1
  }

  const competitors = filterCompetitorTrackedAsins(trackedAsins, listings)
  let selectedCompetitors = 0
  for (const tracked of competitors) {
    const asin = normalizedAsin(tracked.asin)
    if (!asin || !tracked.id) continue
    if (selectedCompetitors >= remainingCompetitors) continue
    const key = `competitor_asin:${tracked.id}`
    if (skipKeys.has(key)) continue
    candidates.push({
      workspace_id: workspaceId,
      job_type: jobType,
      target_type: 'competitor_asin',
      target_id: tracked.id,
      marketplace_id: marketplaceIdForMarketplace(tracked.marketplace) ?? defaultMarketplaceId,
      payload_json: { asin },
    })
    selectedCompetitors += 1
  }

  return {
    candidates,
    totalActiveMyProducts,
    totalActiveCompetitors: competitors.length,
  }
}
