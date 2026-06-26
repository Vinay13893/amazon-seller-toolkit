'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Download, Play } from 'lucide-react'
import {
  daysInRange,
  validateCompareRanges,
  validateRange,
  DEFAULT_RANGE_B,
  autoBaselineFor,
  PRESET_LABELS,
  buildPreset,
  type AnalysisMode,
  type DateRange,
  type PresetId,
} from '@/lib/internal/date-range'

export type ControlPanelQuery = {
  mode: AnalysisMode
  rangeA: DateRange
  rangeB: DateRange
  portfolio: string | null
  campaign: string | null
  allowUnequalLengths?: boolean
}

const PRESET_OPTIONS: PresetId[] = [
  'june15_single_default',
  'yesterday_vs_previous_day',
  'yesterday_vs_last_week',
  'last3_vs_previous3',
  'last7_vs_previous7',
  'legacy_june15_compare',
  'custom',
]

const DEFAULT_INVESTIGATED_RANGE: DateRange = DEFAULT_RANGE_B // 2026-06-15 -> 2026-06-23

function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input
        type="date"
        className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}

export function BrahmastraControlPanel({
  portfolios,
  campaigns,
  onRun,
  onExportAll,
  loading,
}: {
  portfolios: string[]
  campaigns: string[]
  onRun: (query: ControlPanelQuery) => void
  onExportAll: () => void
  loading: boolean
}) {
  const [mode, setMode] = useState<AnalysisMode>('single')
  const [preset, setPreset] = useState<PresetId>('june15_single_default')
  const [rangeA, setRangeA] = useState<DateRange>(DEFAULT_INVESTIGATED_RANGE)
  const [rangeB, setRangeB] = useState<DateRange>(autoBaselineFor(DEFAULT_INVESTIGATED_RANGE))
  const [portfolio, setPortfolio] = useState<string>('All')
  const [campaign, setCampaign] = useState<string>('All')
  const [allowUnequalLengths, setAllowUnequalLengths] = useState(false)

  useEffect(() => {
    if (preset === 'custom') return
    const resolved = buildPreset(preset)
    if (resolved) {
      setRangeA(resolved.rangeA)
      setRangeB(resolved.rangeB)
      if (resolved.mode) setMode(resolved.mode)
      setAllowUnequalLengths(Boolean(resolved.allowUnequalLengths))
    }
  }, [preset])

  const daysA = useMemo(() => (validateRange(rangeA).valid ? daysInRange(rangeA) : null), [rangeA])
  const daysB = useMemo(() => (mode === 'compare' && validateRange(rangeB).valid ? daysInRange(rangeB) : null), [mode, rangeB])

  const validation = useMemo(() => {
    if (mode === 'single') return validateRange(rangeA)
    if (allowUnequalLengths) {
      const a = validateRange(rangeA)
      return a.valid ? validateRange(rangeB) : a
    }
    return validateCompareRanges(rangeA, rangeB)
  }, [mode, rangeA, rangeB, allowUnequalLengths])

  function handleRangeBStartChange(start: string) {
    // Auto-set Range B end date so the duration always matches Range A (unless
    // the legacy unequal-length preset is active).
    if (allowUnequalLengths) {
      setRangeB(r => ({ ...r, startDate: start }))
      return
    }
    const days = daysInRange(rangeA)
    const startDate = new Date(`${start}T00:00:00Z`)
    startDate.setUTCDate(startDate.getUTCDate() + (days - 1))
    setRangeB({ startDate: start, endDate: startDate.toISOString().slice(0, 10) })
    setPreset('custom')
  }

  function handleRun() {
    if (!validation.valid) return
    onRun({
      mode,
      rangeA,
      rangeB,
      portfolio: portfolio === 'All' ? null : portfolio,
      campaign: campaign === 'All' ? null : campaign,
      allowUnequalLengths,
    })
  }

  return (
    <div className="sticky top-0 z-20 bg-card border border-border rounded-xl p-4 mb-6 shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <CalendarRange className="w-4 h-4 text-primary" /> Brahmastra Control Panel
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onExportAll}
            className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
          >
            <Download className="w-3 h-3" /> Export all reports
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={!validation.valid || loading}
            className="inline-flex items-center gap-1 text-xs text-primary-foreground bg-primary rounded-md px-3 py-1 disabled:opacity-50"
          >
            <Play className="w-3 h-3" /> Run Analysis
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Analysis mode
          <select
            className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
            value={mode}
            onChange={e => { setMode(e.target.value as AnalysisMode); setPreset('custom'); setAllowUnequalLengths(false) }}
          >
            <option value="single">Single Date Range Analysis</option>
            <option value="compare">Compare Two Equal Date Ranges</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Preset
          <select
            className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
            value={preset}
            onChange={e => setPreset(e.target.value as PresetId)}
          >
            {PRESET_OPTIONS.filter(p => mode === 'single' ? true : true).map(p => (
              <option key={p} value={p}>{PRESET_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Portfolio
          <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={portfolio} onChange={e => setPortfolio(e.target.value)}>
            <option value="All">All</option>
            {portfolios.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Campaign
          <select className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground" value={campaign} onChange={e => setCampaign(e.target.value)}>
            <option value="All">All</option>
            {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="flex items-end gap-2 border border-border/60 rounded-md p-2">
          <legend className="text-xs text-muted-foreground px-1">{mode === 'single' ? 'Range (investigated)' : 'Range A'}</legend>
          <DateInput label="Start" value={rangeA.startDate} onChange={v => { setRangeA(r => ({ ...r, startDate: v })); setPreset('custom') }} />
          <DateInput label="End" value={rangeA.endDate} onChange={v => { setRangeA(r => ({ ...r, endDate: v })); setPreset('custom') }} />
          <span className="text-xs text-muted-foreground pb-1">{daysA !== null ? `${daysA} day(s)` : '—'}</span>
        </fieldset>

        {mode === 'compare' && (
          <fieldset className="flex items-end gap-2 border border-border/60 rounded-md p-2">
            <legend className="text-xs text-muted-foreground px-1">Range B</legend>
            <DateInput label="Start" value={rangeB.startDate} onChange={handleRangeBStartChange} />
            <DateInput
              label="End"
              value={rangeB.endDate}
              onChange={v => { setRangeB(r => ({ ...r, endDate: v })); setPreset('custom') }}
            />
            <span className="text-xs text-muted-foreground pb-1">{daysB !== null ? `${daysB} day(s)` : '—'}</span>
          </fieldset>
        )}
      </div>

      {!validation.valid && (
        <p className="text-xs text-red-400 mt-2">{validation.error}</p>
      )}
      {allowUnequalLengths && (
        <p className="text-xs text-amber-300 mt-2">
          Legacy preset: Range A and Range B are intentionally different lengths (the original 14-day vs 9-day June 15 diagnostic). Equal-length validation is skipped for this preset only.
        </p>
      )}
      {mode === 'single' && (
        <p className="text-xs text-muted-foreground mt-2">
          Single Range mode auto-compares against the immediately preceding period of equal length to detect spend cuts/efficiency collapses — only the selected range&apos;s dates are shown as &quot;Range B&quot; below.
        </p>
      )}
    </div>
  )
}
