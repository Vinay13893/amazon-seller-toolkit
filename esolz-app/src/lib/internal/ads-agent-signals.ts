// Evidence only: no Amazon write capability. Unknown observations never mean unavailable.
export type DecisionSignals = {
  mapping: 'single_product' | 'unknown'
  organicRank: number | null
  sponsoredRank: number | null
  organicTrend: 'improving' | 'declining' | 'stable' | 'unknown'
  rankStatus: 'fresh' | 'unknown'
  availability: 'available' | 'unavailable' | 'unknown'
  configuredPincodes: number
  confirmedPincodes: number
  unavailablePincodes: number
  bidIncreaseBlocked: boolean
}

export type RankObservation = {
  checked_at: string
  scrape_status: string | null
  organic_rank: number | null
  sponsored_rank: number | null
}
export type AvailabilityObservation = {
  tracking_target_id: string | null
  checked_at: string
  check_status: string | null
  availability_status: string
  error_code: string | null
}

export function freshObservation(at: string, now: Date, hours = 48): boolean {
  const age = now.getTime() - Date.parse(at)
  return Number.isFinite(age) && age >= 0 && age <= hours * 3_600_000
}

export function buildDecisionSignals(
  mapped: boolean,
  ranks: RankObservation[],
  targetIds: string[],
  observations: AvailabilityObservation[],
  now = new Date(),
): DecisionSignals {
  const result: DecisionSignals = {
    mapping: mapped ? 'single_product' : 'unknown', organicRank: null, sponsoredRank: null,
    organicTrend: 'unknown', rankStatus: 'unknown', availability: 'unknown',
    configuredPincodes: targetIds.length, confirmedPincodes: 0, unavailablePincodes: 0,
    bidIncreaseBlocked: true,
  }
  if (!mapped) return result
  const ordered = [...ranks].sort((a, b) => b.checked_at.localeCompare(a.checked_at))
  const latest = ordered[0]
  const validRank = (value: number | null) => value !== null && Number.isInteger(value) && value > 0
  if (latest && freshObservation(latest.checked_at, now)
    && ['success', 'not_found'].includes(latest.scrape_status ?? '')) {
    result.rankStatus = 'fresh'
    result.organicRank = validRank(latest.organic_rank) ? latest.organic_rank : null
    result.sponsoredRank = validRank(latest.sponsored_rank) ? latest.sponsored_rank : null
    const previous = ordered.find(r => r.checked_at < latest.checked_at
      && freshObservation(r.checked_at, now, 7 * 24) && r.scrape_status === 'success'
      && validRank(r.organic_rank))
    if (result.organicRank !== null && previous?.organic_rank) {
      result.organicTrend = result.organicRank < previous.organic_rank ? 'improving'
        : result.organicRank > previous.organic_rank ? 'declining' : 'stable'
    }
  }
  for (const target of new Set(targetIds)) {
    const latest = observations.filter(r => r.tracking_target_id === target)
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0]
    if (!latest || !freshObservation(latest.checked_at, now) || latest.check_status !== 'success'
      || latest.error_code || !['available', 'unavailable'].includes(latest.availability_status)) continue
    result.confirmedPincodes++
    if (latest.availability_status === 'unavailable') result.unavailablePincodes++
  }
  if (result.unavailablePincodes > 0) result.availability = 'unavailable'
  else if (targetIds.length > 0 && result.confirmedPincodes === targetIds.length) result.availability = 'available'
  // This release never recommends increases, even when coverage is complete.
  return result
}
