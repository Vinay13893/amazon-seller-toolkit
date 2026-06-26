'use client'

import { Download, History, ShieldAlert } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { Badge } from '@/components/ui/badge'
import type { ChangeHistorySummary } from '@/lib/internal/easyhome-change-history-diagnostic'
import type { ActionItemWithChanges } from '@/lib/internal/easyhome-change-history-diagnostic'
import { entityDisplayLabel, portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'

type ChangeHistoryImportStatus = {
  original_filename: string
  from_date: string | null
  to_date: string | null
  total_records: number
  imported_count: number
  rejected_count: number
  created_at: string
} | null

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

export function ChangeHistorySection({
  importStatus,
  summary,
  actionQueue,
  afterStart,
}: {
  importStatus: ChangeHistoryImportStatus
  summary: ChangeHistorySummary
  actionQueue: ActionItemWithChanges[]
  afterStart: string
}) {
  const changesBeforeOrDuringAll = actionQueue
    .flatMap(item => item.relatedChanges.map(c => ({ ...c, actionEntity: item.entityName, actionPortfolio: item.portfolio, actionPriority: item.priority })))
    .sort((a, b) => (a.changedAtIso < b.changedAtIso ? -1 : 1))
  const changesBeforeOrDuring = changesBeforeOrDuringAll.slice(0, 50)

  const highPriorityWithChanges = actionQueue.filter(item => item.priority === 'High' && item.relatedChanges.length > 0)

  function downloadChangeHistoryCsv() {
    const headers = ['changed_at', 'timing', 'change_description', 'campaign_name', 'action_entity', 'portfolio', 'priority', 'old_value', 'new_value', 'match_strength']
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers.join(',')]
    for (const c of changesBeforeOrDuringAll) {
      lines.push([
        c.changedAtIso, c.timing, c.description, c.campaignName, entityDisplayLabel(c.actionEntity), portfolioDisplayLabel(c.actionPortfolio), c.actionPriority,
        c.oldValue, c.newValue, c.matchStrength,
      ].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `brahmastra_change_history_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <History className="w-4 h-4 text-primary" /> Change History import status
        </h2>
        {importStatus ? (
          <div className="text-sm text-foreground space-y-1">
            <p>
              Latest file: <span className="font-semibold">{importStatus.original_filename}</span>{' '}
              ({importStatus.from_date?.slice(0, 10) ?? '—'} → {importStatus.to_date?.slice(0, 10) ?? '—'})
            </p>
            <p className="text-muted-foreground text-xs">
              {importStatus.imported_count} imported / {importStatus.rejected_count} rejected of {importStatus.total_records} total ·{' '}
              uploaded {new Date(importStatus.created_at).toLocaleString('en-IN')}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No Change History JSON has been imported yet. Save the Console&apos;s event-history response as a .json file into{' '}
            <code className="text-xs bg-muted px-1 rounded">C:\Vinay\Emount Profitability Calculator\Change History</code>{' '}
            and import via POST /api/internal/ads-change-history/import. This is a manual export only — never an automated browser call.
          </p>
        )}
      </div>

      {summary.totalEvents > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Total change events" value={summary.totalEvents.toLocaleString('en-IN')} />
            <KpiCard label="Campaigns with changes" value={summary.mostChangedCampaigns.length.toLocaleString('en-IN')} />
            <KpiCard label="High-priority actions with related changes" value={summary.highPriorityActionsWithChanges.toLocaleString('en-IN')} />
            <KpiCard label="Date range" value={`${summary.dateRangeStart?.slice(0, 10) ?? '—'} → ${summary.dateRangeEnd?.slice(0, 10) ?? '—'}`} />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Most changed campaigns</h2>
            <DataTable
              columns={['Campaign', 'Change events']}
              rows={summary.mostChangedCampaigns.slice(0, 20).map(c => [c.campaignName, c.eventCount])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-foreground">
                Changes correlated with action-queue items (before/during the {afterStart}+ decline window)
              </h2>
              <button type="button" onClick={downloadChangeHistoryCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
                <Download className="w-3 h-3" /> Export CSV ({changesBeforeOrDuringAll.length})
              </button>
            </div>
            {changesBeforeOrDuring.length === 0 ? (
              <p className="text-sm text-muted-foreground">No correlated changes found for current action-queue items.</p>
            ) : (
              <DataTable
                columns={['Date/time', 'Timing', 'Change', 'Campaign', 'Action item', 'Portfolio', 'Priority']}
                rows={changesBeforeOrDuring.map(c => [
                  new Date(c.changedAtIso).toLocaleString('en-IN'),
                  c.timing,
                  c.description,
                  c.campaignName ?? '—',
                  entityDisplayLabel(c.actionEntity),
                  portfolioDisplayLabel(c.actionPortfolio),
                  c.actionPriority,
                ])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400" /> Possible manual rollback review (suggestions only — no automated rollback)
            </h2>
            {highPriorityWithChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">No high-priority action items currently have a correlated change to review.</p>
            ) : (
              <ul className="text-sm text-foreground space-y-2">
                {highPriorityWithChanges.map(item => (
                  <li key={item.actionKey} className="flex gap-2">
                    <Badge variant="destructive">High</Badge>
                    <span>
                      <strong>{entityDisplayLabel(item.entityName)}</strong> ({portfolioDisplayLabel(item.portfolio)}) has {item.relatedChanges.length} correlated change(s) —{' '}
                      {item.relatedChanges[0]?.description.toLowerCase()}. Consider manually reviewing in Ads Console whether to revert; this tool does not change bids/budgets/campaigns.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  )
}
