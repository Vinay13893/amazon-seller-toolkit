'use client'

import { useMemo, useState } from 'react'
import { FolderKanban, Download } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { CaseReviewStatus, ManualReviewCase } from '@/lib/internal/easyhome-manual-review-cases'

function inr(v: number | null): string {
  if (v === null) return '—'
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}

const PRIORITY_BADGE: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  High: 'destructive', Medium: 'secondary', Low: 'outline',
}
const STATUS_OPTIONS: CaseReviewStatus[] = [
  'Not reviewed', 'Reviewing', 'Restore old bid? maybe', 'Keep current bid',
  'Check listing first', 'Pause/negative review', 'Done', 'Ignore',
]

function FilterSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T | 'All'; options: T[]; onChange: (v: T | 'All') => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={value} onChange={e => onChange(e.target.value as T | 'All')}>
        <option value="All">All</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

function toCsv(rows: ManualReviewCase[]): string {
  const headers = [
    'rank', 'priority', 'portfolio', 'campaign_name', 'ad_group_name', 'main_entity', 'issue_summary',
    'combined_sales_decline', 'worst_acos_before', 'worst_acos_after', 'related_changes_count',
    'earliest_related_change', 'latest_related_change', 'timing_bucket', 'change_summary',
    'from_values', 'to_values', 'match_strength', 'facet_count', 'suggested_review_action',
    'do_not_revert_warning', 'status', 'owner', 'decision', 'reason', 'next_check_date', 'notes', 'evidence_summary',
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.rank, r.priority, r.portfolio, r.campaignName, r.adGroupName, r.mainEntity, r.issueSummary,
      r.combinedSalesDecline, r.worstAcosBefore, r.worstAcosAfter, r.relatedChangesCount,
      r.earliestRelatedChange, r.latestRelatedChange, r.timingBucket, r.changeSummary.join('|'),
      r.fromValues.join('|'), r.toValues.join('|'), r.matchStrength, r.facetCount, r.suggestedReviewAction,
      r.doNotRevertWarning, r.status, r.owner, r.decision, r.reason, r.nextCheckDate, r.notes, r.evidenceSummary,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

function CaseRow({
  c,
  onUpdate,
}: {
  c: ManualReviewCase
  onUpdate: (caseKey: string, fields: { status: CaseReviewStatus; owner: string | null; decision: string | null; reason: string | null; nextCheckDate: string | null; notes: string | null }) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [owner, setOwner] = useState(c.owner ?? '')
  const [decision, setDecision] = useState(c.decision ?? '')
  const [reason, setReason] = useState(c.reason ?? '')
  const [nextCheckDate, setNextCheckDate] = useState(c.nextCheckDate ?? '')
  const [notes, setNotes] = useState(c.notes ?? '')
  const [saving, setSaving] = useState(false)

  async function save(status: CaseReviewStatus) {
    setSaving(true)
    try {
      await onUpdate(c.caseKey, {
        status,
        owner: owner.trim() || null,
        decision: decision.trim() || null,
        reason: reason.trim() || null,
        nextCheckDate: nextCheckDate.trim() || null,
        notes: notes.trim() || null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <tr className="border-b border-border/50 hover:bg-muted/30 align-top cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <td className="py-2 px-2 text-muted-foreground">{c.rank}</td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{c.portfolio}</td>
        <td className="py-2 px-2 max-w-[160px] truncate text-foreground" title={c.campaignName ?? ''}>{c.campaignName ?? '—'}</td>
        <td className="py-2 px-2 max-w-[160px] truncate text-foreground" title={c.mainEntity}>{c.mainEntity}</td>
        <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{c.issueSummary}</td>
        <td className="py-2 px-2 text-center text-foreground">{c.relatedChangesCount}</td>
        <td className="py-2 px-2 whitespace-nowrap">
          <Badge variant={c.timingBucket === 'before decline' ? 'destructive' : c.timingBucket === 'mixed' ? 'secondary' : 'outline'}>{c.timingBucket}</Badge>
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(c.combinedSalesDecline)} / {pct(c.worstAcosBefore)}→{pct(c.worstAcosAfter)}</td>
        <td className="py-2 px-2 max-w-[240px] text-muted-foreground">{c.suggestedReviewAction}</td>
        <td className="py-2 px-2" onClick={e => e.stopPropagation()}>
          <select
            className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
            value={c.status}
            disabled={saving}
            onChange={e => save(e.target.value as CaseReviewStatus)}
          >
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={10} className="py-3 px-4">
            <p className="text-xs text-foreground mb-2">{c.evidenceSummary}</p>
            <p className="text-xs text-amber-300 mb-3">{c.doNotRevertWarning}</p>
            <p className="text-xs text-muted-foreground mb-2">
              Change(s): {c.changeSummary.join(', ')} — from [{c.fromValues.join(', ') || '—'}] to [{c.toValues.join(', ') || '—'}] · match: {c.matchStrength} · {c.facetCount} evidence facet(s) merged
            </p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2" onClick={e => e.stopPropagation()}>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Owner
                <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={owner} onChange={e => setOwner(e.target.value)} onBlur={() => save(c.status)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Decision
                <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={decision} onChange={e => setDecision(e.target.value)} onBlur={() => save(c.status)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Reason
                <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={reason} onChange={e => setReason(e.target.value)} onBlur={() => save(c.status)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Next check date
                <input type="date" className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={nextCheckDate} onChange={e => setNextCheckDate(e.target.value)} onBlur={() => save(c.status)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Notes
                <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => save(c.status)} />
              </label>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function ManualReviewCases({
  cases,
  onUpdate,
}: {
  cases: ManualReviewCase[]
  onUpdate: (caseKey: string, fields: { status: CaseReviewStatus; owner: string | null; decision: string | null; reason: string | null; nextCheckDate: string | null; notes: string | null }) => void
}) {
  const [portfolio, setPortfolio] = useState<string | 'All'>('All')
  const [campaign, setCampaign] = useState<string | 'All'>('All')
  const [issueType, setIssueType] = useState<string | 'All'>('All')
  const [status, setStatus] = useState<CaseReviewStatus | 'All'>('All')
  const [highOnly, setHighOnly] = useState(false)
  const [beforeOnly, setBeforeOnly] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const portfolios = useMemo(() => [...new Set(cases.map(c => c.portfolio))].sort(), [cases])
  const campaigns = useMemo(() => [...new Set(cases.map(c => c.campaignName).filter((x): x is string => !!x))].sort(), [cases])
  const issueTypes = useMemo(() => [...new Set(cases.flatMap(c => c.issueSummary.split('; ')))].sort(), [cases])

  const filtered = useMemo(() => cases.filter(c =>
    (portfolio === 'All' || c.portfolio === portfolio)
    && (campaign === 'All' || c.campaignName === campaign)
    && (issueType === 'All' || c.issueSummary.includes(issueType))
    && (status === 'All' || c.status === status)
    && (!highOnly || c.priority === 'High')
    && (!beforeOnly || c.timingBucket === 'before decline'),
  ), [cases, portfolio, campaign, issueType, status, highOnly, beforeOnly])

  const visible = showAll ? filtered : filtered.slice(0, 20)

  function downloadCsv() {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `easyhome_manual_review_cases_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <FolderKanban className="w-4 h-4 text-primary" /> Grouped Manual Review Cases
        </h2>
        <button type="button" onClick={downloadCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
          <Download className="w-3 h-3" /> Export CSV ({filtered.length})
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-3">
        <FilterSelect label="Portfolio" value={portfolio} options={portfolios} onChange={setPortfolio} />
        <FilterSelect label="Campaign" value={campaign} options={campaigns} onChange={setCampaign} />
        <FilterSelect label="Issue type" value={issueType} options={issueTypes} onChange={setIssueType} />
        <FilterSelect label="Review status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={highOnly} onChange={e => setHighOnly(e.target.checked)} /> High priority only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={beforeOnly} onChange={e => setBeforeOnly(e.target.checked)} /> Before decline only
        </label>
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        Showing {visible.length} of {filtered.length} filtered cases ({cases.length} total grouped cases).
        {!showAll && filtered.length > 20 && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(true)}>Show all</button>}
        {showAll && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(false)}>Show top 20</button>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {['Rank', 'Portfolio', 'Campaign', 'Target/SKU/Term', 'Main issue', 'Changes', 'Timing', 'Sales/ACOS impact', 'Suggested review', 'Status'].map(c => (
                <th key={c} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(c => <CaseRow key={c.caseKey} c={c} onUpdate={onUpdate} />)}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Each row merges every action-queue facet (sales-loss, ACOS-worsened, search-term, SKU) and change-history event for the same underlying target/campaign.
        Correlated with the post-15-June window — review manually; do not revert blindly. Click a row for evidence + workflow fields.
      </p>
    </div>
  )
}
