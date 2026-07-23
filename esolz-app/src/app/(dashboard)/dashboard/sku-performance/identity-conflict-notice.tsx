import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { IdentityConflictEvidence } from '@/lib/sku-performance/types'
import { identityConflictReasonLabel, toneBadgeClassName } from './format'

/**
 * E's compact identity-conflict warning: reasons, catalog ASIN, advertised
 * ASINs — nothing else. Never rendered alongside combined metrics or a
 * chart; the caller is responsible for not rendering either when this
 * shows.
 */
export function IdentityConflictNotice({ evidence }: { evidence: IdentityConflictEvidence }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950">
      <div className="flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
        <AlertTriangle className="size-4" />
        Identity conflict — combined metrics and trend are not shown for this SKU
      </div>
      <div className="flex flex-wrap gap-1.5">
        {evidence.reasons.map(reason => (
          <Badge key={reason} variant="outline" className={toneBadgeClassName('danger')}>{identityConflictReasonLabel(reason)}</Badge>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Catalog ASIN: <span className="font-mono text-foreground">{evidence.catalogAsin ?? 'Unknown'}</span>
        {' · '}
        Advertised ASINs: <span className="font-mono text-foreground">{evidence.advertisedAsins.length > 0 ? evidence.advertisedAsins.map(a => a ?? 'Unknown').join(', ') : 'None found'}</span>
      </p>
    </div>
  )
}
