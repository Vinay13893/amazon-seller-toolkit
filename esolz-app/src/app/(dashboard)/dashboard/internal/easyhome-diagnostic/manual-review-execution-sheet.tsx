'use client'

import { useMemo, useState } from 'react'
import { ClipboardCheck, Download, ShieldAlert, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { CaseReviewStatus, ExpectedMetric, ManualReviewCase } from '@/lib/internal/easyhome-manual-review-cases'

export type ExecutionSheetUpdate = {
  status: CaseReviewStatus
  owner: string | null
  decision: string | null
  reason: string | null
  nextCheckDate: string | null
  notes: string | null
  decisionDate: string | null
  expectedMetrics: ExpectedMetric[]
  stockChecked: boolean
  buyBoxChecked: boolean
  couponChecked: boolean
  priceChecked: boolean
  reviewsChecked: boolean
  deliveryPromiseChecked: boolean
  listingActiveChecked: boolean
  liveBidChecked: boolean
  liveStatusChecked: boolean
  liveBudgetChecked: boolean
}

function inr(v: number | null): string {
  if (v === null) return '—'
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}
function roas(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(2)}x`
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const PRIORITY_BADGE: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  High: 'destructive', Medium: 'secondary', Low: 'outline',
}
const STATUS_OPTIONS: CaseReviewStatus[] = [
  'Not reviewed', 'Reviewing', 'Check listing first', 'Keep current bid',
  'Restore old bid manually', 'Partial bid correction manually',
  'Pause/negative review', 'Ignore', 'Done',
]
const EXPECTED_METRIC_OPTIONS: ExpectedMetric[] = ['sales', 'ACOS', 'spend', 'clicks', 'orders', 'conversion rate']

const CHECKLIST_ITEMS: { key: keyof ExecutionSheetUpdate; label: string }[] = [
  { key: 'stockChecked', label: 'Stock checked' },
  { key: 'buyBoxChecked', label: 'Buy box checked' },
  { key: 'couponChecked', label: 'Coupon checked' },
  { key: 'priceChecked', label: 'Price checked' },
  { key: 'reviewsChecked', label: 'Reviews/ratings checked' },
  { key: 'deliveryPromiseChecked', label: 'Delivery promise checked' },
  { key: 'listingActiveChecked', label: 'Listing active/suppression checked' },
  { key: 'liveBidChecked', label: 'Current live bid checked' },
  { key: 'liveStatusChecked', label: 'Current live status checked' },
  { key: 'liveBudgetChecked', label: 'Current live campaign budget checked' },
]

// Phase 1H "first 30-minute" focus list — matched by entity/campaign substring, case-insensitive.
const THIRTY_MIN_FOCUS = [
  'B08JZ8SS2H', 'SPA-EVA Kids Mat', 'interlocking play mats for kids',
  'LT_Baby_Play_Mat_S', 'Gym Mats for Floor', 'B0D95TB7KV', 'SP-KT-BPM-LT-(Multi)',
]

function matchesFocusList(c: ManualReviewCase): boolean {
  const haystack = `${c.mainEntity} ${c.campaignName ?? ''}`.toLowerCase()
  return THIRTY_MIN_FOCUS.some(needle => haystack.includes(needle.toLowerCase()))
}

function whyItMattersFor(c: ManualReviewCase): string {
  const parts: string[] = []
  if (c.combinedSalesDecline !== null) parts.push(`${inr(c.combinedSalesDecline)} correlated sales decline`)
  if (c.facetCount > 1) parts.push(`${c.facetCount} evidence facets merged`)
  if (c.timingBucket === 'before decline') parts.push('changed before decline')
  return parts.length > 0 ? parts.join('; ') : 'High-priority correlated case.'
}

function whatToCheckFirstFor(c: ManualReviewCase): string {
  const types = new Set(c.changeSummary)
  if (types.has('bid increased') && types.has('bid reduced')) return 'Current live bid vs old/new values; net bid direction.'
  if (types.has('bid increased')) return 'Stock, buy box, price, listing status, current live bid.'
  if (types.has('bid reduced')) return 'Current live bid vs old bid; whether reduction is still in effect.'
  if (types.has('target paused') || types.has('target enabled')) return 'Current live status vs old/new status.'
  return 'Current live bid/status/budget vs old values.'
}

function GuardrailBanner() {
  return (
    <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg p-3 mb-4 flex gap-2 items-start">
      <ShieldAlert className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <ul className="text-xs text-amber-200 space-y-1">
        <li><strong>Do not revert blindly.</strong></li>
        <li>Check stock, buy box, coupon, price, reviews, delivery promise, and current live bid before making any manual change.</li>
        <li>This is correlation, not confirmed causation.</li>
        <li>Any bid/budget/status change must be done manually in Amazon Ads Console.</li>
      </ul>
    </div>
  )
}

function toCsv(rows: ManualReviewCase[]): string {
  const headers = [
    'rank', 'priority', 'portfolio', 'campaign_name', 'ad_group_name', 'main_entity', 'issue_summary',
    'combined_sales_decline', 'worst_acos_before', 'worst_acos_after', 'worst_roas_before', 'worst_roas_after',
    'related_changes_count', 'earliest_related_change', 'latest_related_change', 'timing_bucket', 'match_strength',
    'evidence_summary', 'status', 'owner', 'decision', 'decision_date', 'next_check_date', 'expected_metrics',
    'stock_checked', 'buy_box_checked', 'coupon_checked', 'price_checked', 'reviews_checked',
    'delivery_promise_checked', 'listing_active_checked', 'live_bid_checked', 'live_status_checked', 'live_budget_checked',
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.rank, r.priority, r.portfolio, r.campaignName, r.adGroupName, r.mainEntity, r.issueSummary,
      r.combinedSalesDecline, r.worstAcosBefore, r.worstAcosAfter, r.worstRoasBefore, r.worstRoasAfter,
      r.relatedChangesCount, r.earliestRelatedChange, r.latestRelatedChange, r.timingBucket, r.matchStrength,
      r.evidenceSummary, r.status, r.owner, r.decision, r.decisionDate, r.nextCheckDate, r.expectedMetrics.join('|'),
      r.stockChecked, r.buyBoxChecked, r.couponChecked, r.priceChecked, r.reviewsChecked,
      r.deliveryPromiseChecked, r.listingActiveChecked, r.liveBidChecked, r.liveStatusChecked, r.liveBudgetChecked,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

function ExecutionRow({
  c,
  onUpdate,
}: {
  c: ManualReviewCase
  onUpdate: (caseKey: string, fields: ExecutionSheetUpdate) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [form, setForm] = useState<ExecutionSheetUpdate>({
    status: c.status, owner: c.owner, decision: c.decision, reason: c.reason,
    nextCheckDate: c.nextCheckDate, notes: c.notes, decisionDate: c.decisionDate, expectedMetrics: c.expectedMetrics,
    stockChecked: c.stockChecked, buyBoxChecked: c.buyBoxChecked, couponChecked: c.couponChecked,
    priceChecked: c.priceChecked, reviewsChecked: c.reviewsChecked, deliveryPromiseChecked: c.deliveryPromiseChecked,
    listingActiveChecked: c.listingActiveChecked, liveBidChecked: c.liveBidChecked,
    liveStatusChecked: c.liveStatusChecked, liveBudgetChecked: c.liveBudgetChecked,
  })
  const [saving, setSaving] = useState(false)

  function update<K extends keyof ExecutionSheetUpdate>(key: K, value: ExecutionSheetUpdate[K]) {
    const next = { ...form, [key]: value }
    setForm(next)
    setSaving(true)
    onUpdate(c.caseKey, next)
    setSaving(false)
  }

  function toggleExpectedMetric(metric: ExpectedMetric) {
    const has = form.expectedMetrics.includes(metric)
    update('expectedMetrics', has ? form.expectedMetrics.filter(m => m !== metric) : [...form.expectedMetrics, metric])
  }

  const nextCheckDue = c.nextCheckDate !== null && c.nextCheckDate <= todayIso()

  return (
    <>
      <tr className="border-b border-border/50 hover:bg-muted/30 align-top cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <td className="py-2 px-2 text-muted-foreground">{c.rank}</td>
        <td className="py-2 px-2 whitespace-nowrap"><Badge variant={PRIORITY_BADGE[c.priority] ?? 'outline'}>{c.priority}</Badge></td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{c.portfolio}</td>
        <td className="py-2 px-2 max-w-[140px] truncate text-foreground" title={c.campaignName ?? ''}>{c.campaignName ?? '—'}</td>
        <td className="py-2 px-2 max-w-[110px] truncate text-muted-foreground" title={c.adGroupName ?? ''}>{c.adGroupName ?? '—'}</td>
        <td className="py-2 px-2 max-w-[160px] truncate text-foreground" title={c.mainEntity}>{c.mainEntity}</td>
        <td className="py-2 px-2 whitespace-nowrap text-foreground">{inr(c.combinedSalesDecline)} / {pct(c.worstAcosBefore)}→{pct(c.worstAcosAfter)}</td>
        <td className="py-2 px-2 whitespace-nowrap">
          <Badge variant={c.timingBucket === 'before decline' ? 'destructive' : c.timingBucket === 'mixed' ? 'secondary' : 'outline'}>{c.timingBucket}</Badge>
        </td>
        <td className="py-2 px-2 text-center text-foreground">{c.relatedChangesCount}</td>
        <td className="py-2 px-2" onClick={e => e.stopPropagation()}>
          <select
            className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
            value={form.status}
            disabled={saving}
            onChange={e => update('status', e.target.value as CaseReviewStatus)}
          >
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>
        <td className="py-2 px-2 whitespace-nowrap">
          {nextCheckDue && <Badge variant="destructive">due</Badge>}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={11} className="py-3 px-4">
            <p className="text-xs text-foreground mb-1">{c.evidenceSummary}</p>
            <p className="text-xs text-muted-foreground mb-2">
              ROAS {roas(c.worstRoasBefore)}→{roas(c.worstRoasAfter)} · match: {c.matchStrength} · {c.facetCount} evidence facet(s) merged
            </p>
            <p className="text-xs text-amber-300 mb-3">{c.doNotRevertWarning}</p>

            <div className="mb-3">
              <p className="text-xs font-semibold text-foreground mb-1">Related change history</p>
              <table className="text-xs w-full max-w-2xl">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left pr-3">Changed at</th>
                    <th className="text-left pr-3">Change</th>
                    <th className="text-left pr-3">Old value</th>
                    <th className="text-left pr-3">New value</th>
                    <th className="text-left">Timing</th>
                  </tr>
                </thead>
                <tbody>
                  {c.relatedChanges.map((rc, i) => (
                    <tr key={i} className="text-foreground">
                      <td className="pr-3 whitespace-nowrap">{rc.changedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td className="pr-3">{rc.changeType}</td>
                      <td className="pr-3">{rc.fromValue ?? '—'}</td>
                      <td className="pr-3">{rc.toValue ?? '—'}</td>
                      <td>{rc.timingBucket}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div onClick={e => e.stopPropagation()}>
              <p className="text-xs font-semibold text-foreground mb-1">Pre-change checklist (review manually before any change)</p>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
                {CHECKLIST_ITEMS.map(item => (
                  <label key={item.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form[item.key] as boolean}
                      onChange={e => update(item.key, e.target.checked as never)}
                    />
                    {item.label}
                  </label>
                ))}
              </div>

              <p className="text-xs font-semibold text-foreground mb-1">Decision</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Owner
                  <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={form.owner ?? ''} onChange={e => update('owner', e.target.value || null)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Decision note
                  <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={form.reason ?? ''} onChange={e => update('reason', e.target.value || null)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Decision date
                  <input type="date" className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={form.decisionDate ?? ''} onChange={e => update('decisionDate', e.target.value || null)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Next check date
                  <input type="date" className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={form.nextCheckDate ?? ''} onChange={e => update('nextCheckDate', e.target.value || null)} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground mb-2 max-w-xl">
                Notes
                <input className="bg-background border border-border rounded-md px-1.5 py-1 text-xs text-foreground" value={form.notes ?? ''} onChange={e => update('notes', e.target.value || null)} />
              </label>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Expected metric(s) to watch</p>
                <div className="flex flex-wrap gap-3">
                  {EXPECTED_METRIC_OPTIONS.map(m => (
                    <label key={m} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" checked={form.expectedMetrics.includes(m)} onChange={() => toggleExpectedMetric(m)} />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function ManualReviewExecutionSheet({
  cases,
  onUpdate,
}: {
  cases: ManualReviewCase[]
  onUpdate: (caseKey: string, fields: ExecutionSheetUpdate) => void
}) {
  const [owner, setOwner] = useState<string | 'All'>('All')
  const [status, setStatus] = useState<CaseReviewStatus | 'All'>('All')
  const [portfolio, setPortfolio] = useState<string | 'All'>('All')
  const [highOnly, setHighOnly] = useState(false)
  const [beforeOnly, setBeforeOnly] = useState(false)
  const [decisionPending, setDecisionPending] = useState(false)
  const [nextCheckDue, setNextCheckDue] = useState(false)

  const owners = useMemo(() => [...new Set(cases.map(c => c.owner).filter((o): o is string => !!o))].sort(), [cases])
  const portfolios = useMemo(() => [...new Set(cases.map(c => c.portfolio))].sort(), [cases])
  const today = todayIso()

  const filtered = useMemo(() => cases.filter(c =>
    (owner === 'All' || c.owner === owner)
    && (status === 'All' || c.status === status)
    && (portfolio === 'All' || c.portfolio === portfolio)
    && (!highOnly || c.priority === 'High')
    && (!beforeOnly || c.timingBucket === 'before decline')
    && (!decisionPending || c.status === 'Not reviewed' || c.status === 'Reviewing')
    && (!nextCheckDue || (c.nextCheckDate !== null && c.nextCheckDate <= today)),
  ), [cases, owner, status, portfolio, highOnly, beforeOnly, decisionPending, nextCheckDue, today])

  const focusCases = useMemo(() => cases.filter(matchesFocusList).slice(0, 8), [cases])

  function downloadCsv() {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `easyhome_review_execution_sheet_${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-primary" /> Today&apos;s Review Execution Sheet
        </h2>
        <button type="button" onClick={downloadCsv} className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted">
          <Download className="w-3 h-3" /> Export CSV ({filtered.length})
        </button>
      </div>

      <GuardrailBanner />

      {focusCases.length > 0 && (
        <div className="bg-primary/10 border border-primary/30 rounded-lg p-3 mb-4">
          <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <Timer className="w-3.5 h-3.5 text-primary" /> First 30-minute team checklist ({focusCases.length} cases)
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  {['Rank', 'Case', 'Portfolio', 'Issue', 'Why it matters', 'What to check first', 'Suggested manual action', 'Status'].map(h => (
                    <th key={h} className="text-left font-semibold py-1.5 pr-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {focusCases.map(c => (
                  <tr key={c.caseKey} className="border-t border-border/40 align-top">
                    <td className="py-1.5 pr-3 text-foreground font-medium">#{c.rank}</td>
                    <td className="py-1.5 pr-3 max-w-[160px] text-foreground" title={`${c.mainEntity} — ${c.campaignName ?? '—'}`}>{c.mainEntity}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{c.portfolio}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{c.issueSummary}</td>
                    <td className="py-1.5 pr-3 max-w-[200px] text-muted-foreground">{whyItMattersFor(c)}</td>
                    <td className="py-1.5 pr-3 max-w-[200px] text-muted-foreground">{whatToCheckFirstFor(c)}</td>
                    <td className="py-1.5 pr-3 max-w-[220px] text-muted-foreground">{c.suggestedReviewAction}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-foreground">{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-amber-300 mt-2">Compare old vs current before any change. Do not revert blindly.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 mb-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Owner
          <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="All">All</option>
            {owners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={status} onChange={e => setStatus(e.target.value as CaseReviewStatus | 'All')}>
            <option value="All">All</option>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Portfolio
          <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={portfolio} onChange={e => setPortfolio(e.target.value)}>
            <option value="All">All</option>
            {portfolios.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={highOnly} onChange={e => setHighOnly(e.target.checked)} /> High priority only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={beforeOnly} onChange={e => setBeforeOnly(e.target.checked)} /> Before decline only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={decisionPending} onChange={e => setDecisionPending(e.target.checked)} /> Decision pending
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground self-end pb-1">
          <input type="checkbox" checked={nextCheckDue} onChange={e => setNextCheckDue(e.target.checked)} /> Next check due
        </label>
      </div>

      <p className="text-xs text-muted-foreground mb-2">Showing {filtered.length} of {cases.length} grouped cases. Click a row for the full checklist, change history, and decision fields.</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {['Rank', 'Priority', 'Portfolio', 'Campaign', 'Ad group', 'Target/SKU/Term', 'Sales/ACOS impact', 'Timing', 'Changes', 'Status', 'Next check'].map(h => (
                <th key={h} className="text-left font-semibold py-2 px-2 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => <ExecutionRow key={c.caseKey} c={c} onUpdate={onUpdate} />)}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Correlated with the post-15-June window — review manually; possible rollback review only after the checklist is complete. Compare old vs current. Do not revert blindly.
      </p>
    </div>
  )
}
