'use client'

import { SourceTable } from './source-table'

export function RunHealthView({ rows }: { rows: Array<Array<string | null>> }) {
  const separator = rows.findIndex((row, index) => index > 0 && row.every(value => value === null || value === ''))
  const stepRows = rows.slice(0, separator < 0 ? rows.length : separator)
  const freshnessRows = separator < 0 ? [] : rows.slice(separator + 1)
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Source update steps</h2>
          <p className="text-xs text-muted-foreground">Statuses are shown exactly as supplied by the workbook.</p>
        </div>
        {stepRows.length > 1 && <SourceTable headers={stepRows[0]} rows={stepRows.slice(1)} frozenColumns={1} />}
      </section>
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Worksheet freshness</h2>
          <p className="text-xs text-muted-foreground">Times retain the source worksheet’s IST labels.</p>
        </div>
        {freshnessRows.length > 1 ? (
          <SourceTable headers={freshnessRows[0]} rows={freshnessRows.slice(1)} frozenColumns={1} />
        ) : (
          <p className="border-y border-border py-8 text-center text-sm text-muted-foreground">Freshness details are unavailable.</p>
        )}
      </section>
    </div>
  )
}
