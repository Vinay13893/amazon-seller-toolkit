// Phase 1E.2: links manually-imported Amazon Ads Change History events to
// the EasyHOME diagnostic and the Brahmastra Action Queue. Every relationship
// here is presented as a correlation, never a cause — wording stays
// "changed before decline," "changed during decline window," or
// "correlated change," with an explicit "review manually" suggestion.

import { DEFAULT_RANGE_B, type DateRange } from './date-range'
import type { ActionItem } from './easyhome-action-queue'

export type ChangeEventInput = {
  changedAtIso: string
  changeType: string
  oldValue: string | null
  newValue: string | null
  description: string
  isSystemEvent: boolean
  eventSourceType: string | null
  eventSourceId: string | null
  entityName: string | null
  matchType: string | null
  campaignId: string | null
  campaignName: string | null
  adGroupId: string | null
  adGroupName: string | null
  portfolio: string
}

export type RelatedChangeTiming = 'Changed before decline' | 'Changed during decline window'

// How confidently this change event was matched to the action item. All
// matching is name-based (campaign/entity names) since IDs are not threaded
// through the aggregation pipeline — never an ID-confirmed match.
export type RelatedChangeMatchStrength = 'exact target match' | 'campaign match' | 'fallback name match'

export type RelatedChange = {
  changedAtIso: string
  changeType: string
  description: string
  campaignName: string | null
  adGroupName: string | null
  entityName: string | null
  oldValue: string | null
  newValue: string | null
  timing: RelatedChangeTiming
  daysBeforeAfterStart: number | null
  matchStrength: RelatedChangeMatchStrength
}

export type ActionItemWithChanges = ActionItem & { relatedChanges: RelatedChange[] }

export type ChangeHistorySummary = {
  totalEvents: number
  dateRangeStart: string | null
  dateRangeEnd: string | null
  mostChangedCampaigns: Array<{ campaignName: string; eventCount: number }>
  eventsByType: Record<string, number>
  highPriorityActionsWithChanges: number
}

const PRE_WINDOW_DAYS = 7

function daysBetween(aIso: string, bIso: string): number {
  return (new Date(aIso).getTime() - new Date(bIso).getTime()) / (1000 * 60 * 60 * 24)
}

function classifyTiming(changedAtIso: string, afterStart: string): { timing: RelatedChangeTiming; daysBeforeAfterStart: number | null } {
  if (changedAtIso >= afterStart) {
    return { timing: 'Changed during decline window', daysBeforeAfterStart: null }
  }
  const daysBefore = daysBetween(afterStart, changedAtIso)
  return { timing: 'Changed before decline', daysBeforeAfterStart: Math.round(daysBefore * 10) / 10 }
}

/**
 * Finds change events plausibly related to an action item — matched by
 * campaign name first (the only identifier reliably available across the
 * existing campaign/targeting/search-term aggregations), narrowed by
 * entity/target name when the action item is target-level. This is a
 * name-based fallback match, not an ID-based exact match (campaign/ad-group/
 * keyword IDs are not yet threaded through the existing aggregation
 * pipeline) — every match here is "correlated," not confirmed by ID.
 */
function findRelatedChanges(item: ActionItem, eventsByCampaign: Map<string, ChangeEventInput[]>, rangeB: DateRange): RelatedChange[] {
  if (!item.campaignName) return []
  const candidates = eventsByCampaign.get(item.campaignName.trim().toUpperCase()) ?? []
  if (candidates.length === 0) return []

  const targetNameHint = item.entityType === 'Target' ? item.entityName.split(' (')[0].trim().toUpperCase() : null

  const matched = candidates.filter(event => {
    if (targetNameHint && event.entityName) {
      return event.entityName.trim().toUpperCase() === targetNameHint
    }
    return true
  })

  const relevant = matched.filter(event => {
    if (event.changedAtIso >= rangeB.startDate && event.changedAtIso <= rangeB.endDate) return true
    const daysBefore = daysBetween(rangeB.startDate, event.changedAtIso)
    return daysBefore >= 0 && daysBefore <= PRE_WINDOW_DAYS
  })

  return relevant
    .map(event => {
      const { timing, daysBeforeAfterStart } = classifyTiming(event.changedAtIso, rangeB.startDate)
      // exact target match: a Target item whose entity name equals the event's
      // entity name. campaign match: a Campaign-level item. fallback name match:
      // a SKU/Search-Term item linked only via shared campaign name.
      let matchStrength: RelatedChangeMatchStrength
      if (targetNameHint && event.entityName && event.entityName.trim().toUpperCase() === targetNameHint) {
        matchStrength = 'exact target match'
      } else if (item.entityType === 'Campaign') {
        matchStrength = 'campaign match'
      } else {
        matchStrength = 'fallback name match'
      }
      return {
        changedAtIso: event.changedAtIso,
        changeType: event.changeType,
        description: event.description,
        campaignName: event.campaignName,
        adGroupName: event.adGroupName,
        entityName: event.entityName,
        oldValue: event.oldValue,
        newValue: event.newValue,
        timing,
        daysBeforeAfterStart,
        matchStrength,
      }
    })
    .sort((a, b) => (a.changedAtIso < b.changedAtIso ? -1 : 1))
}

export function attachRelatedChanges(actionQueue: ActionItem[], events: ChangeEventInput[], rangeB: DateRange = DEFAULT_RANGE_B): ActionItemWithChanges[] {
  const eventsByCampaign = new Map<string, ChangeEventInput[]>()
  for (const event of events) {
    if (!event.campaignName) continue
    const key = event.campaignName.trim().toUpperCase()
    if (!eventsByCampaign.has(key)) eventsByCampaign.set(key, [])
    eventsByCampaign.get(key)!.push(event)
  }

  return actionQueue.map(item => ({
    ...item,
    relatedChanges: findRelatedChanges(item, eventsByCampaign, rangeB),
  }))
}

export function buildChangeHistorySummary(events: ChangeEventInput[], actionQueueWithChanges: ActionItemWithChanges[]): ChangeHistorySummary {
  const campaignCounts = new Map<string, number>()
  const eventsByType: Record<string, number> = {}
  let dateRangeStart: string | null = null
  let dateRangeEnd: string | null = null

  for (const event of events) {
    if (event.campaignName) {
      campaignCounts.set(event.campaignName, (campaignCounts.get(event.campaignName) ?? 0) + 1)
    }
    eventsByType[event.changeType] = (eventsByType[event.changeType] ?? 0) + 1
    if (!dateRangeStart || event.changedAtIso < dateRangeStart) dateRangeStart = event.changedAtIso
    if (!dateRangeEnd || event.changedAtIso > dateRangeEnd) dateRangeEnd = event.changedAtIso
  }

  const mostChangedCampaigns = [...campaignCounts.entries()]
    .map(([campaignName, eventCount]) => ({ campaignName, eventCount }))
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, 20)

  const highPriorityActionsWithChanges = actionQueueWithChanges.filter(
    item => item.priority === 'High' && item.relatedChanges.length > 0,
  ).length

  return {
    totalEvents: events.length,
    dateRangeStart,
    dateRangeEnd,
    mostChangedCampaigns,
    eventsByType,
    highPriorityActionsWithChanges,
  }
}
