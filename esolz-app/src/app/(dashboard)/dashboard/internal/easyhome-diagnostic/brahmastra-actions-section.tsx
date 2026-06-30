'use client'

import type { ActionStatus } from '@/lib/internal/easyhome-action-queue'
import type { CaseReviewStatus } from '@/lib/internal/easyhome-manual-review-cases'
import type { ApiResponse } from './brahmastra-shared'
import { ActionQueue } from './action-queue'
import { FindingsActionsTable } from './findings-actions-table'
import { ManualReviewCandidates } from './manual-review-candidates'
import { ManualReviewCases } from './manual-review-cases'
import { ManualReviewExecutionSheet, type ExecutionSheetUpdate } from './manual-review-execution-sheet'

export function BrahmastraActionsSection({
  data,
  onActionStatusChange,
  onCaseUpdate,
  onExecutionSheetUpdate,
}: {
  data: ApiResponse
  onActionStatusChange: (actionKey: string, status: ActionStatus, notes: string | null) => Promise<void>
  onCaseUpdate: (caseKey: string, fields: { status: CaseReviewStatus; owner: string | null; decision: string | null; reason: string | null; nextCheckDate: string | null; notes: string | null }) => Promise<void>
  onExecutionSheetUpdate: (caseKey: string, fields: ExecutionSheetUpdate) => Promise<void>
}) {
  const { actionQueue, actionQueueSummary, manualReviewCases, manualReviewCandidates, findingsTable, controlPanel } = data
  const isSingle = controlPanel.mode === 'single'
  const loadedRangeSuffix = `${controlPanel.rangeA.startDate}_to_${controlPanel.rangeB.endDate}`

  if (isSingle) {
    return (
      <div className="space-y-6">
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-sm font-semibold text-foreground mb-1">Actions & Review — Single mode</p>
          <p className="text-xs text-muted-foreground">
            Compare-mode delta analysis (Action Queue, Manual Review Candidates) requires Range A vs Range B. In Single mode, the Daily Action Engine findings for the selected period are shown below. Switch to Compare mode to see delta-based action items vs a prior period.
          </p>
        </div>
        <FindingsActionsTable rows={findingsTable} mode="single" loadedRangeSuffix={loadedRangeSuffix} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ActionQueue actionQueue={actionQueue} summary={actionQueueSummary} onStatusChange={onActionStatusChange} />
      <ManualReviewExecutionSheet cases={manualReviewCases} onUpdate={onExecutionSheetUpdate} />
      <ManualReviewCases cases={manualReviewCases} onUpdate={onCaseUpdate} />
      <ManualReviewCandidates candidates={manualReviewCandidates} />
    </div>
  )
}
