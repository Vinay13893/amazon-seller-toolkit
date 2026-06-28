'use client'

import type { ApiResponse } from './brahmastra-shared'
import { GoodWorkingTable } from './findings-actions-table'

export function BrahmastraGoodWorkingSection({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  return (
    <GoodWorkingTable rows={data.goodWorkingRows} mode={data.controlPanel.mode} loadedRangeSuffix={loadedRangeSuffix} />
  )
}
