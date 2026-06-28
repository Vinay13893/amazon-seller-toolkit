'use client'

import type { ApiResponse } from './brahmastra-shared'
import { FindingsActionsTable } from './findings-actions-table'

export function BrahmastraFindingsSection({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  return (
    <FindingsActionsTable rows={data.findingsTable} mode={data.controlPanel.mode} loadedRangeSuffix={loadedRangeSuffix} />
  )
}
