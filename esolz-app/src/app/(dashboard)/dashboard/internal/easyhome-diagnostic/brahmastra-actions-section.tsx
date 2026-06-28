'use client'

import type { ActionStatus } from '@/lib/internal/easyhome-action-queue'
import type { CaseReviewStatus } from '@/lib/internal/easyhome-manual-review-cases'
import type { ApiResponse } from './brahmastra-shared'
import { ActionQueue } from './action-queue'
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
  const { actionQueue, actionQueueSummary, manualReviewCases, manualReviewCandidates } = data

  return (
    <div className="space-y-6">
      {/* Brahmastra Action Queue — already supports portfolio/campaign/issue-type
          filtering internally, covering "high priority / waste spend / negative
          review / listing check" as filtered views of the same queue. */}
      <ActionQueue actionQueue={actionQueue} summary={actionQueueSummary} onStatusChange={onActionStatusChange} />

      {/* Team-safe Review Execution Sheet (checklist + decision workflow + guardrails) */}
      <ManualReviewExecutionSheet cases={manualReviewCases} onUpdate={onExecutionSheetUpdate} />

      {/* Grouped Manual Review Cases */}
      <ManualReviewCases cases={manualReviewCases} onUpdate={onCaseUpdate} />

      {/* Ranked Manual Review Candidates (change history × performance) */}
      <ManualReviewCandidates candidates={manualReviewCandidates} />
    </div>
  )
}
