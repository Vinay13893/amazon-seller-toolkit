import { Badge } from '@/components/ui/badge'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import type { SkuPerformanceRow } from '@/lib/sku-performance/types'
import { identityConflictReasonLabel, toneBadgeClassName } from './format'

/**
 * P1-C1 item 15: identity-conflict explanation. Never hides a conflict --
 * shows exactly the evidence the RPC returned (reasons, catalog ASIN,
 * advertised ASINs, raw-SKU evidence per source) and nothing invented.
 */
export function IdentityConflictSheet({ row, onClose }: { row: SkuPerformanceRow | null; onClose: () => void }) {
  const evidence = row?.identityConflictEvidence ?? null

  return (
    <Sheet open={Boolean(row)} onOpenChange={open => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{row?.sku ?? 'Identity conflict'}</SheetTitle>
          <SheetDescription>
            This canonical SKU could not be safely mapped to a single ASIN identity across sources.
          </SheetDescription>
        </SheetHeader>

        {evidence && (
          <div className="grid gap-5 px-4 pb-6">
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Reasons</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {evidence.reasons.map(reason => (
                  <Badge key={reason} variant="outline" className={toneBadgeClassName('danger')}>
                    {identityConflictReasonLabel(reason)}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Catalog ASIN</p>
              <p className="mt-1 font-mono text-sm text-foreground">{evidence.catalogAsin ?? 'Unknown'}</p>
            </div>

            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Advertised ASINs</p>
              {evidence.advertisedAsins.length > 0 ? (
                <ul className="mt-1 grid gap-1">
                  {evidence.advertisedAsins.map((asin, index) => (
                    <li key={`${asin ?? 'unknown'}-${index}`} className="font-mono text-sm text-foreground">
                      {asin ?? 'Unknown'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">None found</p>
              )}
            </div>

            <RawSkuList label="Catalog raw SKUs" values={evidence.catalogRawSkus} />
            <RawSkuList label="Sales raw SKUs" values={evidence.salesRawSkus} />
            <RawSkuList label="Ads raw SKUs" values={evidence.adsRawSkus} />
            <RawSkuList label="Cost-master raw SKUs" values={evidence.costMasterRawSkus} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function RawSkuList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {values.length > 0 ? (
        <ul className="mt-1 grid gap-1">
          {values.map((value, index) => (
            <li key={`${value}-${index}`} className="font-mono text-sm text-foreground">{value}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">None found</p>
      )}
    </div>
  )
}
