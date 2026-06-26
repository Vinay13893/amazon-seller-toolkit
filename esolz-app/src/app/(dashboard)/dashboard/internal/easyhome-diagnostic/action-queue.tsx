'use client'

import { useMemo, useState } from 'react'
import { ListChecks, History, Download } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { Badge } from '@/components/ui/badge'
import type {
  ActionEntityType,
  ActionIssueType,
  ActionPriority,
  ActionQueueSummary,
  ActionStatus,
} from '@/lib/internal/easyhome-action-queue'
import type { ActionItemWithChanges } from '@/lib/internal/easyhome-change-history-diagnostic'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'

function formatInr(value: number | null): string {
  if (value === null) return '—'
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}

const PRIORITY_BADGE: Record<ActionPriority, 'destructive' | 'secondary' | 'outline'> = {
  High: 'destructive',
  Medium: 'secondary',
  Low: 'outline',
}

const STATUS_OPTIONS: ActionStatus[] = ['Open', 'Reviewing', 'Done', 'Ignored']

function toActionQueueCsv(rows: ActionItemWithChanges[]): string {
  const headers = [
    'priority', 'portfolio', 'entity_type', 'entity_name', 'campaign_name', 'issue_type', 'problem_summary',
    'spend_a', 'sales_a', 'acos_a', 'spend_b', 'sales_b', 'acos_b', 'suggested_review', 'data_source',
    'related_changes_count', 'status', 'notes',
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.priority, portfolioDisplayLabel(r.portfolio), r.entityType, r.entityName, r.campaignName, r.issueType, r.problemSummary,
      r.beforeMetrics.spend, r.beforeMetrics.sales, r.beforeMetrics.acos, r.afterMetrics.spend, r.afterMetrics.sales, r.afterMetrics.acos,
      r.suggestedReview, r.dataSource, r.relatedChanges.length, r.status, r.notes,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

function FilterSelect<T extends string>({ label, value, options, onChange, formatLabel }: { label: string; value: T | 'All'; options: T[]; onChange: (v: T | 'All') => void; formatLabel?: (opt: T) => string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
        value={value}
        onChange={e => onChange(e.target.value as T | 'All')}
      >
        <option value="All">All</option>
        {options.map(opt => (
          <option key={opt} value={opt}>{formatLabel ? formatLabel(opt) : opt}</option>
        ))}
      </select>
    </label>
  )
}

function ActionRow({ item, onStatusChange }: { item: ActionItemWithChanges; onStatusChange: (actionKey: string, status: ActionStatus, notes: string | null) => void }) {
  const [notes, setNotes] = useState(item.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)

  async function save(status: ActionStatus, nextNotes: string) {
    setSaving(true)
    try {
      await onStatusChange(item.actionKey, status, nextNotes)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <tr className="border-b border-border/50 hover:bg-muted/30 align-top">
        <td className="py-2 px-2"><Badge variant={PRIORITY_BADGE[item.priority]}>{item.priority}</Badge></td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{portfolioDisplayLabel(item.portfolio)}</td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{item.entityType}</td>
        <td className="py-2 px-2 text-foreground max-w-[160px] truncate" title={item.entityName}>{item.entityName}</td>
        <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{item.issueType}</td>
        <td className="py-2 px-2 text-foreground max-w-[280px]">{item.problemSummary}</td>
        <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
          {formatInr(item.beforeMetrics.spend)} / {formatInr(item.beforeMetrics.sales)}
        </td>
        <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
          {formatInr(item.afterMetrics.spend)} / {formatInr(item.afterMetrics.sales)}
        </td>
        <td className="py-2 px-2 text-muted-foreground max-w-[220px]">{item.suggestedReview}</td>
        <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">{item.dataSource}</td>
        <td className="py-2 px-2">
          {item.relatedChanges.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="inline-flex items-center gap-1"
              title="Correlated change history events found"
            >
              <Badge variant="secondary"><History className="w-3 h-3 mr-1" />{item.relatedChanges.length}</Badge>
            </button>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-2 px-2">
          <select
            className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
            value={item.status}
            disabled={saving}
            onChange={e => save(e.target.value as ActionStatus, notes)}
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </td>
        <td className="py-2 px-2">
          <input
            className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground w-32"
            value={notes}
            placeholder="Notes…"
            onChange={e => setNotes(e.target.value)}
            onBlur={() => save(item.status, notes)}
          />
        </td>
      </tr>
      {expanded && item.relatedChanges.length > 0 && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={12} className="py-2 px-4">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Correlated changes (not a causal claim — review manually):</p>
            <ul className="text-xs text-foreground space-y-1">
              {item.relatedChanges.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <Badge variant={c.timing === 'Changed during decline window' ? 'destructive' : 'outline'}>{c.timing}</Badge>
                  <span>{new Date(c.changedAtIso).toLocaleString('en-IN')} — {c.description}{c.entityName ? ` (${c.entityName})` : ''}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}

export function ActionQueue({
  actionQueue,
  summary,
  onStatusChange,
}: {
  actionQueue: ActionItemWithChanges[]
  summary: ActionQueueSummary
  onStatusChange: (actionKey: string, status: ActionStatus, notes: string | null) => void
}) {
  const [portfolio, setPortfolio] = useState<string | 'All'>('All')
  const [priority, setPriority] = useState<ActionPriority | 'All'>('All')
  const [entityType, setEntityType] = useState<ActionEntityType | 'All'>('All')
  const [issueType, setIssueType] = useState<ActionIssueType | 'All'>('All')
  const [status, setStatus] = useState<ActionStatus | 'All'>('All')
  const [showAll, setShowAll] = useState(false)

  const portfolios = useMemo(() => [...new Set(actionQueue.map(i => i.portfolio))].sort(), [actionQueue])
  const entityTypes = useMemo(() => [...new Set(actionQueue.map(i => i.entityType))].sort(), [actionQueue])
  const issueTypes = useMemo(() => [...new Set(actionQueue.map(i => i.issueType))].sort(), [actionQueue])

  const filtered = useMemo(() => actionQueue.filter(item =>
    (portfolio === 'All' || item.portfolio === portfolio)
    && (priority === 'All' || item.priority === priority)
    && (entityType === 'All' || item.entityType === entityType)
    && (issueType === 'All' || item.issueType === issueType)
    && (status === 'All' || item.status === status),
  ), [actionQueue, portfolio, priority, entityType, issueType, status])

  const visible = showAll ? filtered : filtered.slice(0, 30)

  function downloadCsv() {
    const blob = new Blob([toActionQueueCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `brahmastra_action_queue_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-primary" /> Brahmastra Action Queue
        </h2>
        <button type="button" onClick={downloadCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
          <Download className="w-3 h-3" /> Export CSV ({filtered.length})
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <KpiCard label="High priority actions" value={summary.highPriorityCount.toLocaleString('en-IN')} />
        <KpiCard label="Waste spend found" value={formatInr(summary.wasteSpendFound)} />
        <KpiCard label="SKUs needing listing check" value={summary.skusNeedingListingCheck.toLocaleString('en-IN')} />
        <KpiCard label="Search terms needing negative review" value={summary.searchTermsNeedingNegativeReview.toLocaleString('en-IN')} />
        <KpiCard label="Mapping cleanup count" value={summary.mappingCleanupCount.toLocaleString('en-IN')} />
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <FilterSelect label="Portfolio" value={portfolio} options={portfolios} onChange={setPortfolio} formatLabel={portfolioDisplayLabel} />
        <FilterSelect label="Priority" value={priority} options={['High', 'Medium', 'Low']} onChange={setPriority} />
        <FilterSelect label="Entity type" value={entityType} options={entityTypes} onChange={setEntityType} />
        <FilterSelect label="Issue type" value={issueType} options={issueTypes} onChange={setIssueType} />
        <FilterSelect label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        Showing {visible.length} of {filtered.length} filtered actions ({actionQueue.length} total).
        {!showAll && filtered.length > 30 && (
          <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(true)}>Show all</button>
        )}
        {showAll && (
          <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(false)}>Show top 30</button>
        )}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {['Priority', 'Portfolio', 'Type', 'Entity', 'Issue', 'Problem', 'Before (spend/sales)', 'After (spend/sales)', 'Suggested review', 'Source', 'Changes', 'Status', 'Notes'].map(col => (
                <th key={col} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(item => (
              <ActionRow key={item.actionKey} item={item} onStatusChange={onStatusChange} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        All items are suggestions for manual review, not automated changes. &quot;Correlated with&quot; the post-15-June window — not a causal claim.
      </p>
    </div>
  )
}
