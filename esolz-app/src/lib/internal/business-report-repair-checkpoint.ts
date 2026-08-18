/**
 * Business Report sales-grain fix — resumability for
 * scripts/repair-business-report-sku-daily.ts (spec Phase 6: "resumable,
 * one date at a time, stops on reconciliation failure"). Pure decision
 * logic only; the script itself does the actual file read/write.
 */
import { addCalendarDays } from './business-report-marketplace-time'

export type RepairCheckpoint = {
  runId: string
  lastCompletedDate: string
  completedDates: string[]
}

/** Identifies a specific repair invocation's parameters — a checkpoint file only ever resumes a run with the EXACT same scope, never a superficially-similar one. */
export function computeRunId(workspaceId: string, marketplaceId: string, dateStart: string, dateEnd: string, mode: string): string {
  return [workspaceId, marketplaceId, dateStart, dateEnd, mode].join('|')
}

/**
 * The date to resume processing from. Returns `requestedDateStart`
 * unchanged (start from the beginning) unless there is a checkpoint for
 * this EXACT runId, in which case it returns the day after the last
 * completed date — never re-processes an already-completed date, never
 * skips ahead past an incomplete one, never resumes a checkpoint that
 * belongs to a different date range/workspace/marketplace/mode.
 */
export function resumeStartDate(checkpoint: RepairCheckpoint | null, runId: string, requestedDateStart: string): string {
  if (!checkpoint || checkpoint.runId !== runId) return requestedDateStart
  return addCalendarDays(checkpoint.lastCompletedDate, 1)
}

/** Pure state-transition: append this date to the checkpoint (idempotent — re-adding an already-present date is a no-op). */
export function recordDateCompleted(checkpoint: RepairCheckpoint | null, runId: string, day: string): RepairCheckpoint {
  const completedDates = checkpoint && checkpoint.runId === runId ? checkpoint.completedDates : []
  const nextCompleted = completedDates.includes(day) ? completedDates : [...completedDates, day]
  return { runId, lastCompletedDate: day, completedDates: nextCompleted }
}
