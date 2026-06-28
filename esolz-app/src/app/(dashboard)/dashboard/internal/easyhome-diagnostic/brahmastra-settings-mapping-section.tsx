'use client'

import { KpiCard } from '@/components/dashboard/KpiCard'
import type { ApiResponse } from './brahmastra-shared'
import { MappingHealthCard } from './brahmastra-data-health-section'

/**
 * Profile selection itself lives outside this diagnostic (Brahmastra sync
 * settings), so this tab shows the resolved profile read-only plus the
 * mapping rules/health and helper notes already computed for the loaded
 * analysis — it does not add new profile-switching UI.
 */
export function BrahmastraSettingsMappingSection({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  const { controlPanel, diagnostic } = data

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Amazon Ads profile</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard label="Selected profile" value={controlPanel.selectedProfileName ?? controlPanel.selectedProfileId} sub={controlPanel.selectedProfileId} />
          <KpiCard label="Latest Ads date" value={controlPanel.latestAdsDate ?? '—'} sub="Amazon Ads Reports" />
          <KpiCard label="Latest payment date" value={controlPanel.latestPaymentDate ?? '—'} sub="Payment Transactions (settlement)" />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Profile selection/switching for Brahmastra sync is managed outside this diagnostic. Ads tables here are always scoped to the profile above (profile_id filter).
        </p>
      </div>

      <MappingHealthCard data={data} loadedRangeSuffix={loadedRangeSuffix} />

      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3">Portfolio / category mapping notes</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {diagnostic.dataGaps.map((gap, i) => (
            <li key={i} className="flex gap-2">
              <span>•</span>
              <span>{gap}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground mt-3 italic">
          SKU/campaign/target/search-term portfolio mapping is exact-match-first (cost master category), then pattern-matched against name/SKU text. Unmapped entities surface above in Mapping health for manual review.
        </p>
      </div>
    </div>
  )
}
