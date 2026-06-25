// Phase 1E.2: parser for manually-saved Amazon Ads Console "Change History"
// JSON (saved by hand from DevTools — never fetched automatically, never
// using browser cookies/session auth). Read-only analytics input only.

import { toNumberOrNull } from './csv-report-parsing'
import { mapCampaignNameToPortfolio } from './ads-campaign-daily-parser'

export type ChangeHistoryRecord = {
  sourceIndex: number
  changedAtIso: string
  changedAtMs: number
  changeType: string
  oldValue: string | null
  newValue: string | null
  isSystemEvent: boolean
  eventSourceType: string | null
  eventSourceId: string | null
  entityName: string | null
  targetingType: string | null
  matchType: string | null
  targetingSecondary: string | null
  campaignId: string | null
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  programType: string | null
  easyhomePortfolio: string
  description: string
  dedupeKey: string
  rawEvent: Record<string, unknown>
}

export type ChangeHistoryRejection = {
  sourceIndex: number
  reason: 'missing_time' | 'missing_type' | 'missing_event_source_id'
}

export type ChangeHistoryStats = {
  totalRowCount: number
  acceptedCount: number
  rejectedCount: number
  dateRangeStart: string | null
  dateRangeEnd: string | null
  campaignCount: number
  changeTypeCounts: Record<string, number>
  // Amazon's own pagination metadata, only present when the input is the
  // full console response object (not a bare array). Used to detect an
  // incomplete import: totalRecordsReported > events actually in this page.
  pageSize: number | null
  pageOffset: number | null
  maxPageNumber: number | null
  totalRecordsReported: number | null
  isIncomplete: boolean
}

export type ChangeHistoryParseResult =
  | { ok: true; accepted: ChangeHistoryRecord[]; rejected: ChangeHistoryRejection[]; stats: ChangeHistoryStats }
  | { ok: false; error: string }

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Human-readable, correlation-only description of a change. Never claims
 * causation — this is purely "what changed," used alongside "needs review"
 * wording in the diagnostic layer.
 */
export function describeChange(changeType: string, oldValue: string | null, newValue: string | null): string {
  const type = changeType.toUpperCase()
  if (type === 'BID_AMOUNT') {
    const oldNum = toNumberOrNull(oldValue ?? undefined)
    const newNum = toNumberOrNull(newValue ?? undefined)
    if (oldNum !== null && newNum !== null) {
      if (newNum > oldNum) return `Bid increased from ${oldValue} to ${newValue}`
      if (newNum < oldNum) return `Bid reduced from ${oldValue} to ${newValue}`
      return `Bid unchanged at ${newValue}`
    }
    return `Bid changed from ${oldValue ?? '—'} to ${newValue ?? '—'}`
  }
  if (type === 'STATUS') {
    const old = (oldValue ?? '').toUpperCase()
    const next = (newValue ?? '').toUpperCase()
    if (old === 'ENABLED' && next === 'PAUSED') return 'Target paused'
    if (old === 'PAUSED' && next === 'ENABLED') return 'Target enabled'
    return `Status changed from ${oldValue ?? '—'} to ${newValue ?? '—'}`
  }
  if (type === 'CREATED') return 'Target/keyword created'
  if (oldValue !== null || newValue !== null) return `${changeType} changed from ${oldValue ?? '—'} to ${newValue ?? '—'}`
  return changeType
}

function buildDedupeKey(parts: {
  changedAtMs: number
  eventSourceType: string | null
  eventSourceId: string | null
  changeType: string
  oldValue: string | null
  newValue: string | null
  campaignId: string | null
  adGroupId: string | null
}): string {
  const norm = (value: string | null) => (value ?? '').trim().toUpperCase()
  return [
    String(parts.changedAtMs),
    norm(parts.eventSourceType),
    norm(parts.eventSourceId),
    norm(parts.changeType),
    norm(parts.oldValue),
    norm(parts.newValue),
    norm(parts.campaignId),
    norm(parts.adGroupId),
  ].join('|')
}

/**
 * Accepts either the full console response object ({ events: [...] , ... })
 * or a bare array of event objects.
 */
export function parseChangeHistoryJson(jsonText: string): ChangeHistoryParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: 'File is not valid JSON.' }
  }

  let rawEvents: unknown[]
  let pageSize: number | null = null
  let pageOffset: number | null = null
  let maxPageNumber: number | null = null
  let totalRecordsReported: number | null = null

  if (Array.isArray(parsed)) {
    rawEvents = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).events)) {
    const envelope = parsed as Record<string, unknown>
    rawEvents = envelope.events as unknown[]
    pageSize = typeof envelope.pageSize === 'number' ? envelope.pageSize : null
    pageOffset = typeof envelope.pageOffset === 'number' ? envelope.pageOffset : null
    maxPageNumber = typeof envelope.maxPageNumber === 'number' ? envelope.maxPageNumber : null
    totalRecordsReported = typeof envelope.totalRecords === 'number' ? envelope.totalRecords : null
  } else {
    return { ok: false, error: 'Expected either an array of events or an object with an "events" array.' }
  }

  const accepted: ChangeHistoryRecord[] = []
  const rejected: ChangeHistoryRejection[] = []
  const campaignNames = new Set<string>()
  const changeTypeCounts: Record<string, number> = {}
  let dateRangeStart: string | null = null
  let dateRangeEnd: string | null = null

  rawEvents.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      rejected.push({ sourceIndex: index, reason: 'missing_time' })
      return
    }
    const event = raw as Record<string, unknown>
    const metadata = (event.metadata && typeof event.metadata === 'object') ? event.metadata as Record<string, unknown> : {}

    const timeRaw = event.time
    const changedAtMs = typeof timeRaw === 'number' ? timeRaw : (typeof timeRaw === 'string' ? Number(timeRaw) : NaN)
    if (!Number.isFinite(changedAtMs)) {
      rejected.push({ sourceIndex: index, reason: 'missing_time' })
      return
    }

    const changeType = toTextOrNull(event.type)
    if (!changeType) {
      rejected.push({ sourceIndex: index, reason: 'missing_type' })
      return
    }

    const eventSourceId = toTextOrNull(event.eventSourceId)
    if (!eventSourceId) {
      rejected.push({ sourceIndex: index, reason: 'missing_event_source_id' })
      return
    }

    const changedAtIso = new Date(changedAtMs).toISOString()
    const oldValue = toTextOrNull(event.from)
    const newValue = toTextOrNull(event.to)
    const eventSourceType = toTextOrNull(event.eventSourceType)
    const entityName = toTextOrNull(event.name)
    const targetingType = toTextOrNull(event.targetingType)
    const matchType = toTextOrNull(event.matchType)
    const targetingSecondary = toTextOrNull(event.targetingSecondary)
    const adGroupId = toTextOrNull(event.adGroupId)
    const campaignId = toTextOrNull(event.campaignId ?? metadata.amsCampaignID)
    const campaignName = toTextOrNull(metadata.campaignName)
    const adGroupName = toTextOrNull(metadata.adGroupName)
    const programType = toTextOrNull(metadata.programType)
    const isSystemEvent = event.isSystemEvent === true

    const easyhomePortfolio = campaignName ? mapCampaignNameToPortfolio(campaignName) : 'Unmapped / Needs Review'

    if (campaignName) campaignNames.add(campaignName)
    changeTypeCounts[changeType] = (changeTypeCounts[changeType] ?? 0) + 1
    if (!dateRangeStart || changedAtIso < dateRangeStart) dateRangeStart = changedAtIso
    if (!dateRangeEnd || changedAtIso > dateRangeEnd) dateRangeEnd = changedAtIso

    accepted.push({
      sourceIndex: index,
      changedAtIso,
      changedAtMs,
      changeType,
      oldValue,
      newValue,
      isSystemEvent,
      eventSourceType,
      eventSourceId,
      entityName,
      targetingType,
      matchType,
      targetingSecondary,
      campaignId,
      campaignName,
      adGroupId,
      adGroupName,
      programType,
      easyhomePortfolio,
      description: describeChange(changeType, oldValue, newValue),
      dedupeKey: buildDedupeKey({ changedAtMs, eventSourceType, eventSourceId, changeType, oldValue, newValue, campaignId, adGroupId }),
      rawEvent: event,
    })
  })

  return {
    ok: true,
    accepted,
    rejected,
    stats: {
      totalRowCount: rawEvents.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      dateRangeStart,
      dateRangeEnd,
      campaignCount: campaignNames.size,
      changeTypeCounts,
      pageSize,
      pageOffset,
      maxPageNumber,
      totalRecordsReported,
      isIncomplete: totalRecordsReported !== null && totalRecordsReported > rawEvents.length,
    },
  }
}
