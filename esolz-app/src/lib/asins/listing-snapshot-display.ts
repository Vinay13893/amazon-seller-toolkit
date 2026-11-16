import { timeAgo } from '@/lib/format'

const STALLED_QUEUE_HOURS = 6

export type ListingSnapshotRow = {
  amazon_listing_item_id: string | null
  price: number | null
  bsr: number | null
  buy_box_owner: string | null
  buy_box_status: string | null
  availability_score: number | null
  scrape_status: string | null
  checked_at: string
}

export interface CheckerSummaryForAction {
  processing: number
  queueDueNow: number
  queueWaiting: number
  queued: number
  succeeded: number
  rateLimited: number
  lastAttemptedAt: string | null
}

export function findPriceSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot => snapshot.price !== null) ?? null
}

export function findBsrSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot => snapshot.bsr !== null) ?? null
}

export function findPricingSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(snapshot =>
    snapshot.price !== null ||
    snapshot.buy_box_owner !== null ||
    snapshot.buy_box_status !== null ||
    snapshot.availability_score !== null
  ) ?? null
}

export function findConfirmedBuyBoxSnapshot(snapshots: ListingSnapshotRow[]): ListingSnapshotRow | null {
  return snapshots.find(
    snapshot => snapshot.buy_box_status === 'won' || snapshot.buy_box_status === 'lost'
  ) ?? null
}

export function resolveSuggestedAction(summary: CheckerSummaryForAction, nowIso: string): string | null {
  if (summary.processing > 0) return 'Processing active'

  if (summary.queueDueNow > 0) {
    const hoursSinceLastAttempt = summary.lastAttemptedAt
      ? (new Date(nowIso).getTime() - new Date(summary.lastAttemptedAt).getTime()) / (60 * 60 * 1000)
      : null
    if (hoursSinceLastAttempt === null || hoursSinceLastAttempt > STALLED_QUEUE_HOURS) {
      return `No checks have run in over ${STALLED_QUEUE_HOURS}h — automation may be stalled`
    }
    return 'Checks queued — processing runs every ten minutes'
  }

  if (summary.rateLimited > 0 && summary.queueWaiting > 0) return 'Pricing API cooldown active'
  if (summary.queued === 0 && summary.succeeded > 0) return 'Queue healthy'
  return null
}

export function buyBoxStatusLabel(latest: ListingSnapshotRow | null, confirmedSnapshot: ListingSnapshotRow | null): string {
  if (!latest) return 'Not checked yet'
  if (!confirmedSnapshot) return 'Not confirmed'
  const label = confirmedSnapshot.buy_box_status === 'won' ? 'Won' : 'Lost'
  const isFresh = confirmedSnapshot.checked_at === latest.checked_at
  return isFresh ? label : `${label} — last confirmed ${timeAgo(confirmedSnapshot.checked_at)}`
}
