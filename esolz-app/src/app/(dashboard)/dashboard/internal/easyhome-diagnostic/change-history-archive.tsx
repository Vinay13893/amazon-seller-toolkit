'use client'

import { useMemo, useState } from 'react'
import { CalendarDays, AlertTriangle, Download } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import type { DayBreakdown, ArchiveCoverage, ChunkCoverage, CorrelationSummary, ChunkCoverageStatus } from '@/lib/internal/easyhome-change-history-archive'
import type { ChangeEventInput } from '@/lib/internal/easyhome-change-history-diagnostic'
import { entityDisplayLabel, portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'

type ChangeHistoryBatch = {
  original_filename: string
  from_date: string | null
  to_date: string | null
  total_records: number
  imported_count: number
  rejected_count: number
  page_size: number | null
  page_offset: number | null
  max_page_number: number | null
  total_records_reported: number | null
  inserted_count: number
  updated_count: number
  is_incomplete: boolean
  created_at: string
}

function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {columns.map(col => (
              <th key={col} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
              {row.map((cell, j) => (
                <td key={j} className="py-1.5 px-2 whitespace-nowrap text-foreground">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CHUNK_STATUS_LABEL: Record<ChunkCoverageStatus, string> = {
  Covered: '✅ Covered',
  Partial: '⚠️ Partial',
  Missing: '❌ Missing',
}

export function ChangeHistoryArchiveSection({
  dayByDay,
  coverage,
  chunkCoverage,
  correlationSummary,
  batches,
  events,
}: {
  dayByDay: DayBreakdown[]
  coverage: ArchiveCoverage
  chunkCoverage: ChunkCoverage[]
  correlationSummary: CorrelationSummary[]
  batches: ChangeHistoryBatch[]
  events: ChangeEventInput[]
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const dayDetail = useMemo(() => {
    if (!selectedDate) return []
    return events.filter(e => e.changedAtIso.slice(0, 10) === selectedDate)
  }, [selectedDate, events])

  function downloadArchiveCsv() {
    const headers = ['changed_at', 'change_type', 'old_value', 'new_value', 'campaign_name', 'ad_group_name', 'entity_name', 'match_type', 'portfolio', 'is_system_event']
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers.join(',')]
    for (const e of events) {
      lines.push([
        e.changedAtIso, e.changeType, e.oldValue, e.newValue, e.campaignName, e.adGroupName, entityDisplayLabel(e.entityName), entityDisplayLabel(e.matchType), portfolioDisplayLabel(e.portfolio), e.isSystemEvent,
      ].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `brahmastra_change_history_archive_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* Archive coverage summary */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-primary" /> 30-day Change History archive coverage
          </h2>
          <button type="button" onClick={downloadArchiveCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
            <Download className="w-3 h-3" /> Export CSV ({events.length})
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KpiCard label="Total stored events" value={coverage.totalStoredEvents.toLocaleString('en-IN')} />
          <KpiCard label="Earliest event" value={coverage.earliestChangedAt ? new Date(coverage.earliestChangedAt).toLocaleDateString('en-IN') : '—'} />
          <KpiCard label="Latest event" value={coverage.latestChangedAt ? new Date(coverage.latestChangedAt).toLocaleDateString('en-IN') : '—'} />
          <KpiCard label="Days with zero events" value={coverage.missingDateWarnings.length.toLocaleString('en-IN')} />
        </div>

        {coverage.incompleteImportWarnings.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-3">
            <p className="text-xs font-semibold text-amber-300 mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Incomplete imports detected</p>
            <ul className="text-xs text-amber-200 space-y-1">
              {coverage.incompleteImportWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {coverage.missingDateWarnings.length > 0 && (
          <p className="text-xs text-muted-foreground">
            No events found for: {coverage.missingDateWarnings.join(', ')}. This may mean no changes happened that day, or that day hasn&apos;t been imported yet.
          </p>
        )}
      </div>

      {/* 30-day import helper */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">30-day import helper (recommended chunks)</h2>
        <p className="text-xs text-muted-foreground mb-3">
          For each chunk below, set the Console History page&apos;s date filter to that range, save the response JSON from DevTools, and import it.
          If Amazon paginates (totalRecords &gt; events returned), repeat with the next page offset for that same date range.
        </p>
        <DataTable
          columns={['Date range', 'Status', 'Days with events', 'Days in chunk']}
          rows={chunkCoverage.map(c => [
            c.label,
            CHUNK_STATUS_LABEL[c.status],
            c.daysWithEvents,
            c.totalDaysInChunk,
          ])}
        />
      </div>

      {/* Import batch history */}
      {batches.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-4">Import batch history</h2>
          <DataTable
            columns={['File', 'Date range', 'Reported total', 'Imported', 'Inserted/Updated', 'Page', 'Incomplete?']}
            rows={batches.map(b => [
              b.original_filename,
              `${b.from_date?.slice(0, 10) ?? '—'} → ${b.to_date?.slice(0, 10) ?? '—'}`,
              b.total_records_reported ?? '—',
              b.imported_count,
              `${b.inserted_count}/${b.updated_count}`,
              `offset ${b.page_offset ?? '—'}, size ${b.page_size ?? '—'}, max page ${b.max_page_number ?? '—'}`,
              b.is_incomplete ? 'Yes — needs more pages' : 'No',
            ])}
          />
        </div>
      )}

      {/* Correlation summary */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Change timing vs. the decline window (correlation only, not causal)</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {correlationSummary.map(c => (
            <KpiCard key={c.bucket} label={c.bucket} value={c.eventCount.toLocaleString('en-IN')} />
          ))}
        </div>
      </div>

      {/* Day-by-day table */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Day-by-day change history</h2>
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                {['Date', 'Total', 'Bid changes', 'Status changes', 'Created', 'Campaigns changed', 'High-priority items linked', 'Top campaign'].map(col => (
                  <th key={col} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dayByDay.map(day => (
                <tr
                  key={day.date}
                  className={`border-b border-border/50 hover:bg-muted/30 cursor-pointer ${selectedDate === day.date ? 'bg-muted/40' : ''}`}
                  onClick={() => setSelectedDate(selectedDate === day.date ? null : day.date)}
                >
                  <td className="py-1.5 px-2 whitespace-nowrap text-foreground font-medium">{day.date}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.totalChanges}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.bidChanges}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.statusChanges}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.createdCount}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.campaignsChanged}</td>
                  <td className="py-1.5 px-2 text-foreground">{day.highPriorityActionItemsLinked}</td>
                  <td className="py-1.5 px-2 text-muted-foreground max-w-[200px] truncate">{day.topChangedCampaigns[0]?.campaignName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedDate && (
          <div className="border border-border rounded-lg p-4 mt-2">
            <h3 className="text-xs font-bold text-foreground mb-3">Detail for {selectedDate} ({dayDetail.length} changes)</h3>
            <DataTable
              columns={['Time', 'Campaign', 'Entity', 'Change', 'From', 'To', 'Portfolio']}
              rows={dayDetail.map(e => [
                new Date(e.changedAtIso).toLocaleTimeString('en-IN'),
                e.campaignName ?? '—',
                entityDisplayLabel(e.entityName) || '—',
                e.changeType,
                e.oldValue ?? '—',
                e.newValue ?? '—',
                portfolioDisplayLabel(e.portfolio),
              ])}
            />
          </div>
        )}
      </div>
    </>
  )
}
