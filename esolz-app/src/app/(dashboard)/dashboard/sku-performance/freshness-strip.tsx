import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SkuPerformanceDateRange, SkuPerformanceSummaryTotals } from '@/lib/sku-performance/types'
import { formatDate, formatDateTime, sourceHealthLabel, sourceHealthTone, toneBadgeClassName } from './format'

/**
 * F. Freshness strip — one compact status row. Every field is read
 * straight off the summary RPC response; a missing/unknown health status
 * renders "Unknown" (via sourceHealthLabel(undefined)), never omitted.
 */
export function FreshnessStrip({ summary, dateRange }: { summary: SkuPerformanceSummaryTotals; dateRange: SkuPerformanceDateRange }) {
  const commonRange = dateRange.commonEffectiveDateFrom && dateRange.commonEffectiveDateTo
    ? `${formatDate(dateRange.commonEffectiveDateFrom)} – ${formatDate(dateRange.commonEffectiveDateTo)}`
    : 'Unknown'

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border/70 bg-muted/20 px-4 py-2.5 text-xs">
      <HealthField label="Sales" status={summary.salesSourceState} detail={`through ${formatDate(summary.salesLatestAcceptedCompleteDate)}`} />
      <HealthField label="Ads" status={summary.adsSourceState} detail={`through ${formatDate(summary.adsLatestAcceptedCompleteDate)}`} />
      <HealthField label="Catalog" status={summary.catalogSourceState} detail={`synced ${formatDateTime(summary.catalogLastSyncedAt)}`} />
      <span className="text-muted-foreground">Common range: <span className="font-medium text-foreground">{commonRange}</span></span>
      {dateRange.wasRangeClamped && (
        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5" />
          Range clamped{dateRange.clampReasons.length > 0 ? `: ${dateRange.clampReasons.join(', ')}` : ''}
        </span>
      )}
    </div>
  )
}

function HealthField({ label, status, detail }: { label: string; status: SkuPerformanceSummaryTotals['salesSourceState']; detail: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className={toneBadgeClassName(sourceHealthTone(status))}>{sourceHealthLabel(status)}</Badge>
      <span className="text-muted-foreground">{detail}</span>
    </span>
  )
}
