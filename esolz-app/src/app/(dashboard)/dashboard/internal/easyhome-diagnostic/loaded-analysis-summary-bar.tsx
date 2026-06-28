'use client'

// Phase R5: compact "what am I looking at" bar shown on every tab except
// Overview (which already has the full Control Panel + banners). Every tab
// must make the loaded range, latest source dates, and any pending-changes
// state visible without forcing the user back to Overview to find out.
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import type { ControlPanelMeta } from './brahmastra-shared'
import { rangeLabel } from './brahmastra-shared'
import type { ControlPanelQuery } from './brahmastra-control-panel'

export function LoadedAnalysisSummaryBar({
  controlPanel,
  loadedQuery,
  pendingChanges,
}: {
  controlPanel: ControlPanelMeta
  loadedQuery: ControlPanelQuery
  pendingChanges: boolean
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 flex flex-wrap items-center gap-3">
      <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
        Loaded analysis
      </span>
      <span className="text-xs text-foreground">
        {controlPanel.mode === 'single' ? 'Single Range' : 'Compare'} · {rangeLabel(loadedQuery)}
      </span>
      <span className="text-xs text-muted-foreground">
        Ads through {controlPanel.latestAdsDate ?? 'unknown'} · Payment through {controlPanel.latestPaymentDate ?? 'unknown'}
      </span>
      {pendingChanges && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="w-3 h-3" /> Pending changes — not applied
        </span>
      )}
      <Link
        href="/dashboard/internal/easyhome-diagnostic?view=overview"
        className="ml-auto text-xs text-primary underline hover:no-underline"
      >
        Change ranges in Overview →
      </Link>
    </div>
  )
}
