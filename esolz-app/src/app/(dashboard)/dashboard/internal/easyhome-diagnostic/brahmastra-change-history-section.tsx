'use client'

import type { ApiResponse } from './brahmastra-shared'
import { ChangeHistorySection } from './change-history'
import { ChangeHistoryArchiveSection } from './change-history-archive'

export function BrahmastraChangeHistorySection({ data }: { data: ApiResponse }) {
  const {
    changeHistoryImportStatus, changeHistorySummary, actionQueue, diagnostic,
    changeHistoryDayByDay, changeHistoryArchiveCoverage, changeHistoryChunkCoverage,
    changeHistoryCorrelationSummary, changeHistoryBatches, changeHistoryEvents,
  } = data

  return (
    <div className="space-y-6">
      <ChangeHistorySection
        importStatus={changeHistoryImportStatus}
        summary={changeHistorySummary}
        actionQueue={actionQueue}
        afterStart={diagnostic.windows.afterStart}
      />
      <ChangeHistoryArchiveSection
        dayByDay={changeHistoryDayByDay}
        coverage={changeHistoryArchiveCoverage}
        chunkCoverage={changeHistoryChunkCoverage}
        correlationSummary={changeHistoryCorrelationSummary}
        batches={changeHistoryBatches}
        events={changeHistoryEvents}
      />
    </div>
  )
}
