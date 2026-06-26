'use client'

import { useMemo, useState } from 'react'
import { Download, Table2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { FindingIssueLabel, FindingRow } from '@/lib/internal/easyhome-findings-table'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'

function inr(v: number | null): string {
  return v === null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`
}
function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}
function roas(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(2)}x`
}

const PRIORITY_BADGE: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  High: 'destructive', Medium: 'secondary', Low: 'outline',
}

export function toFindingsCsv(rows: FindingRow[]): string {
  const headers = [
    'priority', 'portfolio', 'campaign', 'ad_group', 'entity', 'issue_type',
    'spend_a', 'spend_b', 'spend_change', 'sales_a', 'sales_b', 'sales_change',
    'acos_a', 'acos_b', 'roas_a', 'roas_b', 'what_changed', 'comment',
    'recommended_manual_action', 'review_status',
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.priority, portfolioDisplayLabel(r.portfolio), r.campaignName, r.adGroupName, r.entityName, r.issueType,
      r.spendA, r.spendB, r.spendChange, r.salesA, r.salesB, r.salesChange,
      r.acosA, r.acosB, r.roasA, r.roasB, r.whatChanged, r.comment, r.recommendedManualAction, r.reviewStatus,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

function FilterSelect<T extends string>({ label, value, options, onChange, formatLabel }: { label: string; value: T | 'All'; options: T[]; onChange: (v: T | 'All') => void; formatLabel?: (opt: T) => string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={value} onChange={e => onChange(e.target.value as T | 'All')}>
        <option value="All">All</option>
        {options.map(o => <option key={o} value={o}>{formatLabel ? formatLabel(o) : o}</option>)}
      </select>
    </label>
  )
}

export function FindingsActionsTable({ rows }: { rows: FindingRow[] }) {
  const [portfolio, setPortfolio] = useState<string | 'All'>('All')
  const [issueType, setIssueType] = useState<FindingIssueLabel | 'All'>('All')
  const [priority, setPriority] = useState<string | 'All'>('All')
  const [showAll, setShowAll] = useState(false)

  const portfolios = useMemo(() => [...new Set(rows.map(r => r.portfolio))].sort(), [rows])
  const issueTypes = useMemo(() => [...new Set(rows.map(r => r.issueType))].sort(), [rows])

  const filtered = useMemo(() => rows.filter(r =>
    (portfolio === 'All' || r.portfolio === portfolio)
    && (issueType === 'All' || r.issueType === issueType)
    && (priority === 'All' || r.priority === priority),
  ), [rows, portfolio, issueType, priority])

  const visible = showAll ? filtered : filtered.slice(0, 30)

  function downloadCsv() {
    const blob = new Blob([toFindingsCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `brahmastra_findings_actions_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <Table2 className="w-4 h-4 text-primary" /> Findings &amp; Actions Table
        </h2>
        <button type="button" onClick={downloadCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
          <Download className="w-3 h-3" /> Export CSV ({filtered.length})
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-3">
        <FilterSelect label="Portfolio" value={portfolio} options={portfolios} onChange={setPortfolio} formatLabel={portfolioDisplayLabel} />
        <FilterSelect label="Issue type" value={issueType} options={issueTypes} onChange={setIssueType} />
        <FilterSelect label="Priority" value={priority} options={['High', 'Medium', 'Low']} onChange={setPriority} />
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        Showing {visible.length} of {filtered.length} filtered findings ({rows.length} total).
        {!showAll && filtered.length > 30 && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(true)}>Show all</button>}
        {showAll && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(false)}>Show top 30</button>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {['Priority', 'Portfolio', 'Campaign', 'Ad Group', 'Keyword/Target/SKU/Term', 'Issue Type', 'Spend A', 'Spend B', 'Spend Δ', 'Sales A', 'Sales B', 'Sales Δ', 'ACOS A', 'ACOS B', 'ROAS A', 'ROAS B', 'What Changed', 'Comment / Reason', 'Recommended Manual Action', 'Review Status'].map(h => (
                <th key={h} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={`${r.actionKey}-${i}`} className="border-b border-border/50 hover:bg-muted/30 align-top">
                <td className="py-2 px-2"><Badge variant={PRIORITY_BADGE[r.priority] ?? 'outline'}>{r.priority}</Badge></td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{portfolioDisplayLabel(r.portfolio)}</td>
                <td className="py-2 px-2 max-w-[140px] truncate text-foreground" title={r.campaignName ?? ''}>{r.campaignName ?? '—'}</td>
                <td className="py-2 px-2 max-w-[110px] truncate text-muted-foreground" title={r.adGroupName ?? ''}>{r.adGroupName ?? '—'}</td>
                <td className="py-2 px-2 max-w-[160px] truncate text-foreground" title={r.entityName}>{r.entityName}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{r.issueType}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(r.spendA)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(r.spendB)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{inr(r.spendChange)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(r.salesA)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(r.salesB)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{inr(r.salesChange)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{pct(r.acosA)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{pct(r.acosB)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{roas(r.roasA)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{roas(r.roasB)}</td>
                <td className="py-2 px-2 max-w-[200px] text-muted-foreground">{r.whatChanged}</td>
                <td className="py-2 px-2 max-w-[200px] text-foreground">{r.comment}</td>
                <td className="py-2 px-2 max-w-[240px] text-muted-foreground">{r.recommendedManualAction}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{r.reviewStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Range A vs Range B, correlated with change-history events where available. Review manually; compare old vs current. Do not revert blindly.
      </p>
    </div>
  )
}
