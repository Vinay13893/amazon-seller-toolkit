'use client'

import { useEffect, useState, useCallback } from 'react'
import { SYSTEM_DEFAULT_THRESHOLDS, PORTFOLIO_DISPLAY_NAMES, type ThresholdValues } from '@/lib/internal/brahmastra-thresholds'

type ThresholdRow = ThresholdValues & {
  portfolio: string
  is_active: boolean
  updated_at: string | null
  source: 'saved' | 'system_default'
}

const THRESHOLD_FIELDS: Array<{ key: keyof ThresholdValues; label: string; description: string; unit: string }> = [
  { key: 'waste_spend_threshold', label: 'Waste Spend Threshold', description: 'Minimum ad spend (₹) to flag as a waste-spend candidate', unit: '₹' },
  { key: 'minimum_roas', label: 'Minimum ROAS', description: 'ROAS below this (with non-zero sales) = waste / low-impact candidate', unit: 'x' },
  { key: 'min_clicks_for_waste', label: 'Min Clicks for Waste', description: 'Minimum clicks before flagging as waste', unit: '' },
  { key: 'high_spend_threshold', label: 'High Spend Threshold', description: 'Minimum ad spend (₹) for High Spend Low Sales Impact rule', unit: '₹' },
  { key: 'min_ad_spend_for_action', label: 'Min Ad Spend for Action', description: 'Minimum spend (₹) for High ACOS / Protect-Scale checks', unit: '₹' },
  { key: 'max_acos_pct', label: 'Max ACOS %', description: 'ACOS above this % = High ACOS finding; at or below = Good Working', unit: '%' },
  { key: 'protect_roas', label: 'Protect ROAS', description: 'ROAS at or above this = Protect/Scale candidate (Good Working)', unit: 'x' },
  { key: 'protect_acos_pct', label: 'Protect ACOS %', description: 'ACOS at or below this % = Protect/Scale candidate (Good Working)', unit: '%' },
  { key: 'good_roas', label: 'Good ROAS', description: 'ROAS at or above this = Good Working candidate in engine', unit: 'x' },
  { key: 'warning_tacos_pct', label: 'Warning TACOS %', description: 'Ads Spend ÷ Ordered Sales above this % = Medium-priority High TACOS finding', unit: '%' },
  { key: 'critical_tacos_pct', label: 'Critical TACOS %', description: 'Ads Spend ÷ Ordered Sales above this % = High-priority TACOS finding', unit: '%' },
  { key: 'min_ordered_sales_for_category_action', label: 'Min Ordered Sales (Category)', description: 'Minimum Business Report Ordered Sales (₹) before checking category TACOS', unit: '₹' },
  { key: 'refund_warning_pct', label: 'Refund Warning %', description: 'Refunds ÷ Gross Sales above this % = Refund Watch finding', unit: '%' },
  { key: 'high_refund_amount', label: 'High Refund Amount', description: 'Minimum total refunds (₹) before triggering Refund Watch', unit: '₹' },
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

function PortfolioRow({ row, onSave }: { row: ThresholdRow; onSave: (portfolio: string, values: ThresholdValues) => Promise<void> }) {
  const [edits, setEdits] = useState<Partial<ThresholdValues>>({})
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
    setEdits({ ...SYSTEM_DEFAULT_THRESHOLDS })
    setSaved(false)
  }

  const isDirty = Object.keys(edits).length > 0

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{PORTFOLIO_DISPLAY_NAMES[row.portfolio] ?? row.portfolio}</h3>
          <p className="text-xs text-muted-foreground">
            {row.source === 'saved'
              ? `Saved · last updated ${row.updated_at ? new Date(row.updated_at).toLocaleString('en-IN') : 'unknown'}`
              : 'Using system defaults — no saved row yet (apply migration 054 first)'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={handleReset} className="text-xs border border-border text-muted-foreground rounded px-2 py-1 hover:bg-muted">
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
        <p className="text-xs text-muted-foreground mb-2">
          These thresholds control the Daily Action Engine (Single mode). Values are pre-filled with the R10 system defaults — behavior is identical to the current deployed version until you edit and save. Changes apply on the next Run Analysis.
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-300">
          Migration 054 must be applied in Supabase SQL Editor before saved values persist. Until then, the engine uses system defaults (same as R10 behavior). Apply migration at:
          {' '}<span className="font-medium">supabase.com/dashboard/project/okxfwcfxxrtmijmvztdq/sql/new</span>
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
          <p><span className="font-semibold text-foreground">Waste Spend:</span> Ad spend ≥ waste_spend_threshold AND (ad-attributed sales = 0 OR ROAS &lt; minimum_roas). Priority: High if spend ≥ ₹1,000; Medium otherwise.</p>
          <p><span className="font-semibold text-foreground">High Spend Low Impact:</span> Spend ≥ high_spend_threshold AND ROAS &lt; minimum_roas AND sales &gt; 0 (not already flagged as Waste Spend).</p>
          <p><span className="font-semibold text-foreground">High ACOS:</span> ACOS &gt; max_acos_pct AND spend ≥ min_ad_spend_for_action AND sales &gt; 0.</p>
          <p><span className="font-semibold text-foreground">Protect / Scale (Good Working):</span> Spend ≥ min_ad_spend_for_action AND sales &gt; 0 AND (ROAS ≥ protect_roas OR ACOS ≤ protect_acos_pct).</p>
          <p><span className="font-semibold text-foreground">High TACOS — Medium:</span> Business Report Ordered Sales ≥ min_ordered_sales_for_category_action AND TACOS ≥ warning_tacos_pct.</p>
          <p><span className="font-semibold text-foreground">High TACOS — High:</span> Same as above AND TACOS ≥ critical_tacos_pct.</p>
          <p><span className="font-semibold text-foreground">Refund Watch:</span> Refunds ≥ high_refund_amount AND Refunds ÷ Gross Sales × 100 ≥ refund_warning_pct.</p>
          <p><span className="font-semibold text-foreground">Threshold resolution order:</span> (1) Saved portfolio row if is_active = true → (2) Global (__global__) row if present → (3) System defaults (= R10 values, identical behavior when no DB row exists).</p>
          <p className="italic">All rules use "may indicate" language. No automated bid/budget changes. All suggestions require manual review.</p>
        </div>
      </div>
    </div>
  )
}
