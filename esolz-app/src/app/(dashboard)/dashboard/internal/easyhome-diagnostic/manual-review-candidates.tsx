'use client'

import { useMemo, useState } from 'react'
import { ClipboardList, Download } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { ManualReviewCandidate, ReviewChangeType, TimingBucket } from '@/lib/internal/easyhome-manual-review-candidates'
import type { RelatedChangeMatchStrength } from '@/lib/internal/easyhome-change-history-diagnostic'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'

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

function toCsv(rows: ManualReviewCandidate[]): string {
  const headers = [
    'rank', 'priority', 'portfolio', 'campaign_name', 'ad_group_name', 'entity_type', 'entity', 'issue_type',
    'sales_decline', 'before_acos', 'after_acos', 'before_roas', 'after_roas',
    'related_change_at', 'timing_bucket', 'change_type', 'from_value', 'to_value', 'change_magnitude',
    'match_strength', 'suggested_review_action', 'evidence_summary',
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.rank, r.priority, portfolioDisplayLabel(r.portfolio), r.campaignName, r.adGroupName, r.entityType, r.entity, r.issueType,
      r.salesDecline, r.beforeAcos, r.afterAcos, r.beforeRoas, r.afterRoas,
      r.relatedChangeAt, r.timingBucket, r.changeType, r.fromValue, r.toValue, r.changeMagnitude,
      r.matchStrength, r.suggestedReviewAction, r.evidenceSummary,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

export function ManualReviewCandidates({ candidates }: { candidates: ManualReviewCandidate[] }) {
  const [portfolio, setPortfolio] = useState<string | 'All'>('All')
  const [campaign, setCampaign] = useState<string | 'All'>('All')
  const [timing, setTiming] = useState<TimingBucket | 'All'>('All')
  const [changeType, setChangeType] = useState<ReviewChangeType | 'All'>('All')
  const [matchStrength, setMatchStrength] = useState<RelatedChangeMatchStrength | 'All'>('All')
  const [highOnly, setHighOnly] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const portfolios = useMemo(() => [...new Set(candidates.map(c => c.portfolio))].sort(), [candidates])
  const campaigns = useMemo(() => [...new Set(candidates.map(c => c.campaignName).filter((x): x is string => !!x))].sort(), [candidates])
  const changeTypes = useMemo(() => [...new Set(candidates.map(c => c.changeType))].sort(), [candidates])
  const matchStrengths = useMemo(() => [...new Set(candidates.map(c => c.matchStrength))].sort(), [candidates])

  const filtered = useMemo(() => candidates.filter(c =>
    (portfolio === 'All' || c.portfolio === portfolio)
    && (campaign === 'All' || c.campaignName === campaign)
    && (timing === 'All' || c.timingBucket === timing)
    && (changeType === 'All' || c.changeType === changeType)
    && (matchStrength === 'All' || c.matchStrength === matchStrength)
    && (!highOnly || c.priority === 'High'),
  ), [candidates, portfolio, campaign, timing, changeType, matchStrength, highOnly])

  const visible = showAll ? filtered : filtered.slice(0, 30)

  function downloadCsv() {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `easyhome_manual_review_candidates_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-primary" /> Manual Review Candidates
        </h2>
        <button type="button" onClick={downloadCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
          <Download className="w-3 h-3" /> Export CSV ({filtered.length})
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-3">
        <FilterSelect label="Portfolio" value={portfolio} options={portfolios} onChange={setPortfolio} formatLabel={portfolioDisplayLabel} />
        <FilterSelect label="Campaign" value={campaign} options={campaigns} onChange={setCampaign} />
        <FilterSelect label="Timing" value={timing} options={['before decline', 'during decline', 'after decline']} onChange={setTiming} />
        <FilterSelect label="Change type" value={changeType} options={changeTypes} onChange={setChangeType} />
        <FilterSelect label="Match strength" value={matchStrength} options={matchStrengths} onChange={setMatchStrength} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={highOnly} onChange={e => setHighOnly(e.target.checked)} /> High priority only
        </label>
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        Showing {visible.length} of {filtered.length} filtered candidates ({candidates.length} total).
        {!showAll && filtered.length > 30 && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(true)}>Show all</button>}
        {showAll && <button type="button" className="ml-2 text-primary underline" onClick={() => setShowAll(false)}>Show top 30</button>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {['#', 'Pri', 'Portfolio', 'Campaign', 'Entity', 'Issue', 'Δ Sales', 'ACOS b→a', 'Change', 'From→To', 'Mag', 'Timing', 'Match', 'Suggested review'].map(c => (
                <th key={c} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(c => (
              <tr key={`${c.rank}`} className="border-b border-border/50 hover:bg-muted/30 align-top">
                <td className="py-2 px-2 text-muted-foreground">{c.rank}</td>
                <td className="py-2 px-2"><Badge variant={PRIORITY_BADGE[c.priority] ?? 'outline'}>{c.priority}</Badge></td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{portfolioDisplayLabel(c.portfolio)}</td>
                <td className="py-2 px-2 max-w-[160px] truncate text-foreground" title={c.campaignName ?? ''}>{c.campaignName ?? '—'}</td>
                <td className="py-2 px-2 max-w-[150px] truncate text-foreground" title={c.entity}>{c.entity}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{c.issueType}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(c.salesDecline)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{pct(c.beforeAcos)}→{pct(c.afterAcos)}</td>
                <td className="py-2 px-2 whitespace-nowrap text-foreground">{c.changeType}</td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{c.fromValue ?? '—'}→{c.toValue ?? '—'}</td>
                <td className="py-2 px-2 text-muted-foreground">{c.changeMagnitude ?? '—'}</td>
                <td className="py-2 px-2 whitespace-nowrap">
                  <Badge variant={c.timingBucket === 'before decline' ? 'destructive' : 'outline'}>{c.timingBucket}</Badge>
                </td>
                <td className="py-2 px-2 whitespace-nowrap text-muted-foreground">{c.matchStrength}</td>
                <td className="py-2 px-2 max-w-[260px] text-muted-foreground">{c.suggestedReviewAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Suggestions for manual review only — correlation with the post-15-June window, not a confirmed cause. Do not revert blindly; no automated changes are made by this tool.
      </p>
    </div>
  )
}
