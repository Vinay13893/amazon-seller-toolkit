import {
  filterCompetitorTrackedAsins,
  marketplaceFromMarketplaceId,
  type OwnCatalogListingIdentity,
  type TrackedAsinIdentity,
} from '@/lib/asins/product-separation'

export type BsrTargetType = 'my_product' | 'competitor_asin'

export type BsrTrackingStatus = 'active' | 'removed'

export type BsrRankEntry = {
  category?: string | null
  category_id?: string | null
  rank?: number | null
  rank_type?: 'display_group' | 'classification' | string | null
}

export type BsrSnapshotRow = {
  amazon_listing_item_id?: string | null
  tracked_asin_id?: string | null
  bsr: number | null
  bsr_category?: string | null
  bsr_ranks?: BsrRankEntry[] | unknown
  scrape_status?: string | null
  checked_at: string
}

export type BsrTrackingTargetRow = {
  id: string
  workspace_id?: string | null
  amazon_listing_item_id: string | null
  tracked_asin_id: string | null
  status: BsrTrackingStatus | string
  created_at?: string | null
  updated_at?: string | null
  removed_at?: string | null
}

export type BsrSourceProduct = {
  targetType: BsrTargetType
  sourceId: string
  asin: string
  marketplace: string
  label: string
  sku?: string | null
  imageUrl?: string | null
}

export type BsrTargetView = BsrSourceProduct & {
  trackingTargetId: string
  currentRank: number | null
  previousRank: number | null
  movement: number | null
  category: string | null
  subcategory: string | null
  subcategoryRank: number | null
  lastCheckedAt: string | null
  rankCapturedAt: string | null
  latestStatus: string | null
}

export type BsrKpiSummary = {
  totalTargets: number
  targetsWithBsr: number
  averageBsr: number | null
  improvingCount: number
  decliningCount: number
}

export type BsrUntrackPatch = {
  status: 'removed'
  removed_at: string
}

export function targetKey(targetType: BsrTargetType, sourceId: string): string {
  return `${targetType}:${sourceId}`
}

export function trackingTargetType(row: BsrTrackingTargetRow): BsrTargetType | null {
  const hasListing = Boolean(row.amazon_listing_item_id)
  const hasTracked = Boolean(row.tracked_asin_id)
  if (hasListing === hasTracked) return null
  return hasListing ? 'my_product' : 'competitor_asin'
}

export function trackingTargetSourceId(row: BsrTrackingTargetRow): string | null {
  const type = trackingTargetType(row)
  if (type === 'my_product') return row.amazon_listing_item_id
  if (type === 'competitor_asin') return row.tracked_asin_id
  return null
}

export function isValidBsrTrackingTarget(row: BsrTrackingTargetRow): boolean {
  return trackingTargetType(row) !== null
}

export function hasDuplicateBsrTarget(
  targets: Array<Pick<BsrTrackingTargetRow, 'amazon_listing_item_id' | 'tracked_asin_id' | 'status'>>,
  targetType: BsrTargetType,
  sourceId: string,
): boolean {
  return targets.some(target => {
    if (target.status !== 'active') return false
    if (targetType === 'my_product') return target.amazon_listing_item_id === sourceId
    return target.tracked_asin_id === sourceId
  })
}

export function untrackBsrTargetPatch(nowIso: string): BsrUntrackPatch {
  return {
    status: 'removed',
    removed_at: nowIso,
  }
}

export function filterBsrCompetitorCandidates<T extends TrackedAsinIdentity>(
  trackedAsins: T[],
  ownListings: OwnCatalogListingIdentity[],
): T[] {
  return filterCompetitorTrackedAsins(trackedAsins, ownListings)
}

export function snapshotMatchesTarget(snapshot: BsrSnapshotRow, targetType: BsrTargetType, sourceId: string): boolean {
  if (targetType === 'my_product') return snapshot.amazon_listing_item_id === sourceId
  return snapshot.tracked_asin_id === sourceId
}

export function snapshotsForTarget(
  snapshots: BsrSnapshotRow[],
  targetType: BsrTargetType,
  sourceId: string,
): BsrSnapshotRow[] {
  return snapshots
    .filter(snapshot => snapshotMatchesTarget(snapshot, targetType, sourceId))
    .sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime())
}

function rankSnapshotsForTarget(snapshots: BsrSnapshotRow[], targetType: BsrTargetType, sourceId: string): BsrSnapshotRow[] {
  return snapshotsForTarget(snapshots, targetType, sourceId).filter(snapshot => snapshot.bsr !== null)
}

function rankEntries(snapshot: BsrSnapshotRow | null): BsrRankEntry[] {
  if (!snapshot || !Array.isArray(snapshot.bsr_ranks)) return []
  return snapshot.bsr_ranks.filter((entry): entry is BsrRankEntry => Boolean(entry) && typeof entry === 'object')
}

export function mainBsrCategory(snapshot: BsrSnapshotRow | null): string | null {
  if (!snapshot) return null
  if (snapshot.bsr_category?.trim()) return snapshot.bsr_category.trim()
  const displayGroup = rankEntries(snapshot).find(entry => entry.rank_type === 'display_group' && entry.category?.trim())
  return displayGroup?.category?.trim() ?? null
}

export function firstClassificationRank(snapshot: BsrSnapshotRow | null): { category: string; rank: number } | null {
  const mainCategory = mainBsrCategory(snapshot)
  for (const entry of rankEntries(snapshot)) {
    if (entry.rank_type !== 'classification') continue
    if (!entry.category?.trim() || entry.rank == null) continue
    if (entry.category.trim() === mainCategory && entry.rank === snapshot?.bsr) continue
    return { category: entry.category.trim(), rank: entry.rank }
  }
  return null
}

export function rankMetricsForTarget(
  snapshots: BsrSnapshotRow[],
  targetType: BsrTargetType,
  sourceId: string,
): Pick<BsrTargetView, 'currentRank' | 'previousRank' | 'movement' | 'category' | 'subcategory' | 'subcategoryRank' | 'lastCheckedAt' | 'rankCapturedAt' | 'latestStatus'> {
  const allSnapshots = snapshotsForTarget(snapshots, targetType, sourceId)
  const rankSnapshots = rankSnapshotsForTarget(snapshots, targetType, sourceId)
  const current = rankSnapshots[0] ?? null
  const previous = rankSnapshots[1] ?? null
  const classification = firstClassificationRank(current)
  const currentRank = current?.bsr ?? null
  const previousRank = previous?.bsr ?? null

  return {
    currentRank,
    previousRank,
    movement: currentRank !== null && previousRank !== null ? previousRank - currentRank : null,
    category: mainBsrCategory(current),
    subcategory: classification?.category ?? null,
    subcategoryRank: classification?.rank ?? null,
    lastCheckedAt: allSnapshots[0]?.checked_at ?? null,
    rankCapturedAt: current?.checked_at ?? null,
    latestStatus: allSnapshots[0]?.scrape_status ?? null,
  }
}

export function buildBsrTargetView(
  source: BsrSourceProduct,
  trackingTargetId: string,
  snapshots: BsrSnapshotRow[],
): BsrTargetView {
  return {
    ...source,
    trackingTargetId,
    ...rankMetricsForTarget(snapshots, source.targetType, source.sourceId),
  }
}

export function summarizeBsrTargets(targets: BsrTargetView[]): BsrKpiSummary {
  const targetsWithBsr = targets.filter(target => target.currentRank !== null)
  const averageBsr = targetsWithBsr.length
    ? Math.round(targetsWithBsr.reduce((sum, target) => sum + target.currentRank!, 0) / targetsWithBsr.length)
    : null

  return {
    totalTargets: targets.length,
    targetsWithBsr: targetsWithBsr.length,
    averageBsr,
    improvingCount: targets.filter(target => target.movement !== null && target.movement > 0).length,
    decliningCount: targets.filter(target => target.movement !== null && target.movement < 0).length,
  }
}

export function marketplaceLabelForListing(marketplaceId: string | null | undefined): string {
  if (!marketplaceId) return 'IN'
  return marketplaceFromMarketplaceId(marketplaceId)
}
