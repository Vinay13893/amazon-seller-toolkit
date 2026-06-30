'use client'

import { useEffect, useState, useCallback } from 'react'
import { SYSTEM_DEFAULT_THRESHOLDS, PORTFOLIO_DISPLAY_NAMES, type ThresholdValues } from '@/lib/internal/brahmastra-thresholds'

type ThresholdRow = ThresholdValues & {
  portfolio: string
  is_active: boolean
  updated_at: string | null
  source: 'saved' | 'system_default'
}

type EditState = Partial<ThresholdValues>

const THRESHOLD_FIELDS: Array<{ key: keyof ThresholdValues; label: string; description: string; unit: string }> = [
  { key: 'waste_spend_min', label: 'Waste Spend Min', description: 'Minimum ad spend (₹) to flag as a waste-spend candidate', unit: '₹' },
  { key: 'waste_roas_max', label: 'Waste ROAS Max', description: 'ROAS below this (with non-zero sales) = waste candidate', unit: 'x' },
  { key: 'min_clicks_for_waste', label: 'Min Clicks for Waste', description: 'Minimum clicks required before flagging as waste', unit: '' },
  { key: 'high_acos_pct', label: 'High ACOS %', description: 'ACOS above this % = High ACOS finding', unit: '%' },
  { key: 'high_acos_spend_min', label: 'High ACOS Spend Min', description: 'Minimum spend (₹) before flagging High ACOS', unit: '₹' },
  { key: 'high_spend_low_roas_spend_min', label: 'High Spend Low ROAS Min', description: 'Minimum spend (₹) for High Spend Low Sales Impact finding', unit: '₹' },
  { key: 'high_spend_low_roas_max', label: 'High Spend Low ROAS Max', description: 'ROAS below this = High Spend Low Sales Impact', unit: 'x' },
  { key: 'protect_roas_min', label: 'Protect/Scale ROAS Min', description: 'ROAS at or above this = Protect/Scale candidate', unit: 'x' },
  { key: 'protect_acos_max', label: 'Protect/Scale ACOS Max', description: 'ACOS at or below this % = Protect/Scale candidate', unit: '%' },
  { key: 'protect_spend_min', label: 'Protect/Scale Spend Min', description: 'Minimum spend (₹) to consider for Protect/Scale', unit: '₹' },
  { key: 'high_tacos_pct', label: 'High TACOS %', description: 'Ads Spend ÷ Business Report Ordered Sales above this % = High TACOS finding', unit: '%' },
  { key: 'high_tacos_min_ordered_sales', label: 'High TACOS Min Ordered Sales', description: 'Minimum Business Report Ordered Sales (₹) before flagging High TACOS', unit: '₹' },
  { key: 'refund_rate_min_pct', label: 'Refund Watch Rate %', description: 'Refunds ÷ Gross Sales above this % = Refund Watch finding', unit: '%' },
  { key: 'refund_min_amount', label: 'Refund Watch Min Amount', description: 'Minimum total refunds (₹) before flagging Refund Watch', unit: '₹' },
  { key: 'good_roas_min', label: 'Good ROAS Min', description: 'ROAS at or above this = Good Working / Protect/Scale candidate', unit: 'x' },
  { key: 'good_acos_max', label: 'Good ACOS Max', description: 'ACOS at or below this % = Good Working / Protect/Scale candidate', unit: '%' },
]

function ThresholdInput({ fieldKey, value, onChange }: {
  fieldKey: keyof ThresholdValues
  value: number | undefined
  onChange: (key: keyof ThresholdValues, value: number) => void
}) {
  return (
    <input
      type="number"
      step="0.1"
      min="0"
      value={value ?? ''}
      onChange={e => {
        const v = parseFloat(e.target.value)
        if (!isNaN(v)) onChange(fieldKey, v)
      }}
      className="w-20 text-xs text-foreground bg-background border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
    />
  )
}

function PortfolioRow({
  row,
  onSave,
}: {
  row: ThresholdRow
  onSave: (portfolio: string, values: ThresholdValues) => Promise<void>
}) {
  const [edits, setEdits] = useState<EditState>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const current: ThresholdValues = { ...row, ...edits }

  function handleChange(key: keyof ThresholdValues, value: number) {
    setEdits(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(row.portfolio, current)
      setEdits({})
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setEdits(SYSTEM_DEFAULT_THRESHOLDS)
    setSaved(false)
  }

  const isDirty = Object.keys(edits).length > 0

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{PORTFOLIO_DISPLAY_NAMES[row.portfolio] ?? row.portfolio}</h3>
          <p className="text-xs text-muted-foreground">
            {row.source === 'saved' ? `Saved · last updated ${row.updated_at ? new Date(row.updated_at).toLocaleString('en-IN') : 'unknown'}` : 'Using system defaults — no saved row yet'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="text-xs border border-border text-muted-foreground rounded px-2 py-1 hover:bg-muted"
          >
            Reset to Default
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="text-xs text-primary-foreground bg-primary rounded px-3 py-1 disabled:opacity-50"
          >
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {THRESHOLD_FIELDS.map(f => (
          <div key={f.key} className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">{f.label}</label>
            <div className="flex items-center gap-1">
              {f.unit && <span className="text-xs text-muted-foreground">{f.unit}</span>}
              <ThresholdInput fieldKey={f.key} value={current[f.key]} onChange={handleChange} />
            </div>
            <span className="text-[10px] text-muted-foreground leading-tight">{f.description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BrahmastraThresholdsSection() {
  const [rows, setRows] = useState<ThresholdRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchThresholds = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/internal/brahmastra-thresholds')
      if (!res.ok) throw new Error('Failed to load thresholds.')
      const json = await res.json() as { thresholds: ThresholdRow[] }
      setRows(json.thresholds)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thresholds.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchThresholds() }, [fetchThresholds])

  async function handleSave(portfolio: string, values: ThresholdValues) {
    const res = await fetch('/api/internal/brahmastra-thresholds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio, ...values }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: 'Save failed.' })) as { error?: string }
      throw new Error(j.error ?? 'Save failed.')
    }
    // Refresh row source indicator
    setRows(prev => prev.map(r =>
      r.portfolio === portfolio
        ? { ...r, ...values, source: 'saved', updated_at: new Date().toISOString() }
        : r,
    ))
  }

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-1">Thresholds & Assumptions</h2>
        <p className="text-xs text-muted-foreground mb-3">
          These thresholds control the Daily Action Engine (single mode). Values are pre-filled with the R10 system defaults — behavior is identical to the current deployed version until you edit and save. Changes apply on the next Run Analysis.
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-300">
          Note: the database table for thresholds (migration 054) must be applied before saved values are persisted. Until then, all values shown are the system defaults and the engine uses them automatically.
        </p>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading thresholds…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && rows.map(row => (
        <PortfolioRow key={row.portfolio} row={row} onSave={handleSave} />
      ))}

      {/* Formula assumptions */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3">Formula assumptions</h2>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p><span className="font-semibold text-foreground">Waste Spend:</span> Ad spend ≥ waste_spend_min AND (ad-attributed sales = 0 OR ROAS &lt; waste_roas_max). Priority: High if spend ≥ ₹1,000; Medium otherwise.</p>
          <p><span className="font-semibold text-foreground">High ACOS:</span> ACOS &gt; high_acos_pct AND spend ≥ high_acos_spend_min AND sales &gt; 0 (not already flagged as Waste Spend).</p>
          <p><span className="font-semibold text-foreground">High Spend Low Sales Impact:</span> Spend ≥ high_spend_low_roas_spend_min AND ROAS &lt; high_spend_low_roas_max AND sales &gt; 0 (not already flagged as Waste Spend or High ACOS).</p>
          <p><span className="font-semibold text-foreground">Protect / Scale Candidate (Good Working):</span> Spend ≥ protect_spend_min AND sales &gt; 0 AND (ROAS ≥ protect_roas_min OR ACOS ≤ protect_acos_max). Appears in Good Working tab.</p>
          <p><span className="font-semibold text-foreground">High TACOS Category:</span> Business Report Ordered Sales ≥ high_tacos_min_ordered_sales AND Amazon Ads Spend / Ordered Sales × 100 ≥ high_tacos_pct. Priority: High if TACOS ≥ 30%; Medium otherwise.</p>
          <p><span className="font-semibold text-foreground">Refund Watch:</span> Settlement Refunds ≥ refund_min_amount AND Refunds / Gross Sales × 100 ≥ refund_rate_min_pct. Priority: High if rate ≥ 30%; Medium otherwise.</p>
          <p><span className="font-semibold text-foreground">Threshold resolution order:</span> (1) Saved category/portfolio row if present and is_active = true → (2) Global (__global__) row if present → (3) System defaults (= R10 hardcoded values, unchanged behavior).</p>
          <p className="italic">All rules use "may indicate" language. No automated bid/budget changes are made. All suggestions require manual review.</p>
        </div>
      </div>
    </div>
  )
}
