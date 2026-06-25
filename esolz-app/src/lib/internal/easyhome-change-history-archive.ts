// Phase 1E.4: 30-day Change History archive — day-by-day breakdown, coverage
// gaps, recommended-chunk import status, and a 3-bucket temporal correlation
// summary (before / during / after the decline window). Every label here is
// a time-correlation only, never a causal claim.

import type { ChangeEventInput, ActionItemWithChanges } from './easyhome-change-history-diagnostic'

export const ARCHIVE_RANGE_START = '2026-05-26'
export const ARCHIVE_RANGE_END = '2026-06-25'

export const RECOMMENDED_IMPORT_CHUNKS: Array<{ label: string; from: string; to: string }> = [
  { label: '2026-05-26 to 2026-05-31', from: '2026-05-26', to: '2026-05-31' },
  { label: '2026-06-01 to 2026-06-07', from: '2026-06-01', to: '2026-06-07' },
  { label: '2026-06-08 to 2026-06-14', from: '2026-06-08', to: '2026-06-14' },
  { label: '2026-06-15 to 2026-06-21', from: '2026-06-15', to: '2026-06-21' },
  { label: '2026-06-22 to 2026-06-25', from: '2026-06-22', to: '2026-06-25' },
]

function dateOf(iso: string): string {
  return iso.slice(0, 10)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type DayBreakdown = {
  date: string
  totalChanges: number
  bidChanges: number
  statusChanges: number
  createdCount: number
  campaignsChanged: number
  highPriorityActionItemsLinked: number
  topChangedCampaigns: Array<{ campaignName: string; count: number }>
  biggestBidIncreases: Array<{ campaignName: string | null; entityName: string | null; from: string | null; to: string | null; delta: number }>
  biggestBidReductions: Array<{ campaignName: string | null; entityName: string | null; from: string | null; to: string | null; delta: number }>
}

export function buildDayByDayBreakdown(events: ChangeEventInput[], actionQueueWithChanges: ActionItemWithChanges[]): DayBreakdown[] {
  const byDate = new Map<string, ChangeEventInput[]>()
  for (const event of events) {
    const date = dateOf(event.changedAtIso)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date)!.push(event)
  }

  const highPriorityDatesByItem = new Map<string, Set<string>>()
  for (const item of actionQueueWithChanges) {
    if (item.priority !== 'High') continue
    for (const change of item.relatedChanges) {
      const date = dateOf(change.changedAtIso)
      if (!highPriorityDatesByItem.has(date)) highPriorityDatesByItem.set(date, new Set())
      highPriorityDatesByItem.get(date)!.add(item.actionKey)
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayEvents]) => {
      const campaignCounts = new Map<string, number>()
      let bidChanges = 0
      let statusChanges = 0
      let createdCount = 0
      const bidDeltas: Array<{ campaignName: string | null; entityName: string | null; from: string | null; to: string | null; delta: number }> = []

      for (const event of dayEvents) {
        if (event.campaignName) campaignCounts.set(event.campaignName, (campaignCounts.get(event.campaignName) ?? 0) + 1)
        if (event.changeType === 'BID_AMOUNT') {
          bidChanges += 1
          const oldNum = Number(event.oldValue)
          const newNum = Number(event.newValue)
          if (Number.isFinite(oldNum) && Number.isFinite(newNum)) {
            bidDeltas.push({ campaignName: event.campaignName, entityName: event.entityName, from: event.oldValue, to: event.newValue, delta: round2(newNum - oldNum) })
          }
        } else if (event.changeType === 'STATUS') {
          statusChanges += 1
        } else if (event.changeType === 'CREATED') {
          createdCount += 1
        }
      }

      const topChangedCampaigns = [...campaignCounts.entries()]
        .map(([campaignName, count]) => ({ campaignName, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

      const biggestBidIncreases = [...bidDeltas].filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5)
      const biggestBidReductions = [...bidDeltas].filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5)

      return {
        date,
        totalChanges: dayEvents.length,
        bidChanges,
        statusChanges,
        createdCount,
        campaignsChanged: campaignCounts.size,
        highPriorityActionItemsLinked: highPriorityDatesByItem.get(date)?.size ?? 0,
        topChangedCampaigns,
        biggestBidIncreases,
        biggestBidReductions,
      }
    })
}

export type ArchiveCoverage = {
  earliestChangedAt: string | null
  latestChangedAt: string | null
  totalStoredEvents: number
  eventsByDay: Array<{ date: string; count: number }>
  missingDateWarnings: string[]
  incompleteImportWarnings: string[]
}

export function buildArchiveCoverage(
  events: ChangeEventInput[],
  batches: Array<{ original_filename: string; from_date: string | null; to_date: string | null; is_incomplete: boolean; total_records_reported: number | null; imported_count: number }>,
): ArchiveCoverage {
  const eventsByDayMap = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  for (const event of events) {
    const date = dateOf(event.changedAtIso)
    eventsByDayMap.set(date, (eventsByDayMap.get(date) ?? 0) + 1)
    if (!earliest || event.changedAtIso < earliest) earliest = event.changedAtIso
    if (!latest || event.changedAtIso > latest) latest = event.changedAtIso
  }

  const missingDateWarnings: string[] = []
  const cursor = new Date(`${ARCHIVE_RANGE_START}T00:00:00Z`)
  const end = new Date(`${ARCHIVE_RANGE_END}T00:00:00Z`)
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    if (!eventsByDayMap.has(iso)) missingDateWarnings.push(iso)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const incompleteImportWarnings = batches
    .filter(b => b.is_incomplete)
    .map(b => `${b.original_filename}: captured ${b.imported_count} of ${b.total_records_reported ?? '?'} records reported by Amazon — more pages needed.`)

  return {
    earliestChangedAt: earliest,
    latestChangedAt: latest,
    totalStoredEvents: events.length,
    eventsByDay: [...eventsByDayMap.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    missingDateWarnings,
    incompleteImportWarnings,
  }
}

export type ChunkCoverageStatus = 'Covered' | 'Partial' | 'Missing'

export type ChunkCoverage = {
  label: string
  from: string
  to: string
  status: ChunkCoverageStatus
  daysWithEvents: number
  totalDaysInChunk: number
}

function daysInRange(from: string, to: string): string[] {
  const days: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

export function buildChunkCoverage(eventsByDay: Array<{ date: string; count: number }>): ChunkCoverage[] {
  const eventDays = new Set(eventsByDay.filter(d => d.count > 0).map(d => d.date))
  return RECOMMENDED_IMPORT_CHUNKS.map(chunk => {
    const days = daysInRange(chunk.from, chunk.to)
    const daysWithEvents = days.filter(d => eventDays.has(d)).length
    const status: ChunkCoverageStatus = daysWithEvents === 0 ? 'Missing' : daysWithEvents === days.length ? 'Covered' : 'Partial'
    return { label: chunk.label, from: chunk.from, to: chunk.to, status, daysWithEvents, totalDaysInChunk: days.length }
  })
}

export type CorrelationBucket = 'Changes before decline' | 'Changes during decline' | 'Changes after decline'

export type CorrelationSummary = {
  bucket: CorrelationBucket
  eventCount: number
}

const DURING_WINDOW_DAYS = 3

export function classifyCorrelationBucket(changedAtIso: string, afterStart: string): CorrelationBucket {
  if (changedAtIso < afterStart) return 'Changes before decline'
  const duringEnd = new Date(afterStart)
  duringEnd.setUTCDate(duringEnd.getUTCDate() + DURING_WINDOW_DAYS)
  if (new Date(changedAtIso).getTime() < duringEnd.getTime()) return 'Changes during decline'
  return 'Changes after decline'
}

export function buildCorrelationSummary(events: ChangeEventInput[], afterStart: string): CorrelationSummary[] {
  const counts = new Map<CorrelationBucket, number>([
    ['Changes before decline', 0],
    ['Changes during decline', 0],
    ['Changes after decline', 0],
  ])
  for (const event of events) {
    const bucket = classifyCorrelationBucket(event.changedAtIso, afterStart)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  return [...counts.entries()].map(([bucket, eventCount]) => ({ bucket, eventCount }))
}
