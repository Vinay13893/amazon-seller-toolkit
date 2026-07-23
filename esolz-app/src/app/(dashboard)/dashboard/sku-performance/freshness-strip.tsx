import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SkuPerformanceDateRange, SkuPerformanceSummaryTotals } from '@/lib/sku-performance/types'
import { formatDate, formatDateTime, sourceHealthLabel, sourceHealthTone, toneBadgeClassName } from './format'

/**
 * Data-health/freshness strip (P1-C1 item 5). Every field here is read
 * straight off the summary RPC response -- nothing is computed in the
 * browser, and a missing/unknown health status renders as "Unknown"
 * (via sourceHealthLabel(undefined)), never silently omitted.
 */
export function FreshnessStrip({ summary, dateRange }: { summary: SkuPerformanceSummaryTotals; dateRange: SkuPerformanceDateRange }) {
  const commonRange = dateRange.commonEffectiveDateFrom && dateRange.commonEffectiveDateTo
    ? `${formatDate(dateRange.commonEffectiveDateFrom)} – ${formatDate(dateRange.commonEffectiveDateTo)}`
    : 'Unknown'

  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 bg-muted/20 p-4 md:grid-cols-3">
      <HealthField
        label="Sales data"
        status={summary.salesSourceState}
        detail={`Complete through ${formatDate(summary.salesLatestAcceptedCompleteDate)}`}
      />
      <HealthField
        label="Ads data"
        status={summary.adsSourceState}
        detail={`Complete through ${formatDate(summary.adsLatestAcceptedCompleteDate)}`}
      />
      <HealthField
        label="Catalog"
        status={summary.catalogSourceState}
        detail={`Last synced ${formatDateTime(summary.catalogLastSyncedAt)}`}
      />
      <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <p className="text-xs text-muted-foreground">
          Common comparable range (used for combined ACOS/TACOS): <span className="font-medium text-foreground">{commonRange}</span>
        </p>
        {dateRange.wasRangeClamped && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5" />
            <span>
              Range clamped
              {dateRange.clampReasons.length > 0 ? `: ${dateRange.clampReasons.join(', ')}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function HealthField({ label, status, detail }: { label: string; status: SkuPerformanceSummaryTotals['salesSourceState']; detail: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Badge variant="outline" className={toneBadgeClassName(sourceHealthTone(status))}>
          {sourceHealthLabel(status)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}
