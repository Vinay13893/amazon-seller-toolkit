'use client'

import { useMemo, useState } from 'react'
import { Check, Package, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  selectProductForSkuContext,
  shouldToggleProductFromKeyboard,
  type AsinProduct,
  type AsinProductDomain,
} from '@/lib/asins/product-domain'
import { cn } from '@/lib/utils'

export function AsinProductSelector({
  myProducts,
  competitorProducts,
  selectedKeys,
  onSelectedKeysChange,
  maxSelected = 10,
  loading = false,
  catalogUnavailable = false,
  competitorsUnavailable = false,
}: {
  myProducts: AsinProduct[]
  competitorProducts: AsinProduct[]
  selectedKeys: string[]
  onSelectedKeysChange: (keys: string[]) => void
  maxSelected?: number
  loading?: boolean
  catalogUnavailable?: boolean
  competitorsUnavailable?: boolean
}) {
  const [domain, setDomain] = useState<AsinProductDomain>('my')
  const [search, setSearch] = useState('')
  const products = domain === 'my' ? myProducts : competitorProducts
  const unavailable = domain === 'my' ? catalogUnavailable : competitorsUnavailable
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return products
    return products.filter(product => [
      product.title,
      product.asin,
      product.brand,
      product.marketplace,
      ...product.skus,
    ].some(value => value?.toLowerCase().includes(query)))
  }, [products, search])

  function toggleProduct(product: AsinProduct) {
    if (selectedKeys.includes(product.key)) {
      onSelectedKeysChange(selectedKeys.filter(key => key !== product.key))
      return
    }
    if (selectedKeys.length < maxSelected) onSelectedKeysChange([...selectedKeys, product.key])
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {([['my', 'My ASINs'], ['competitor', 'Competitor ASINs']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDomain(value)}
              className={cn(
                'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                domain === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{selectedKeys.length}/{maxSelected} selected</span>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search title, ASIN, SKU, brand, marketplace" className="pl-9" />
      </div>

      {loading ? (
        <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">Loading products...</div>
      ) : unavailable ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {domain === 'my' ? 'Catalog products are temporarily unavailable.' : 'Competitor ownership could not be verified, so no competitor ASINs are shown.'}
        </div>
      ) : visibleProducts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No products found in this list.</div>
      ) : (
        <div className="grid max-h-80 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {visibleProducts.map(product => {
            const selected = selectedKeys.includes(product.key)
            return (
              <div
                key={product.key}
                role="button"
                tabIndex={0}
                onClick={() => toggleProduct(product)}
                onKeyDown={event => {
                  if (!shouldToggleProductFromKeyboard({
                    key: event.key,
                    isContainerTarget: event.target === event.currentTarget,
                  })) return
                  event.preventDefault()
                  toggleProduct(product)
                }}
                className={cn(
                  'flex min-h-28 cursor-pointer gap-3 rounded-md border p-3 transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30',
                )}
              >
                {product.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.imageUrl} alt={product.title} className="size-14 shrink-0 rounded object-contain bg-muted" />
                ) : (
                  <div className="flex size-14 shrink-0 items-center justify-center rounded bg-muted"><Package className="size-5 text-muted-foreground" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium text-foreground">{product.title}</p>
                    {selected && <Check className="size-4 shrink-0 text-primary" />}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="font-mono">{product.asin}</span>
                    <Badge variant="outline" className="text-[9px]">{product.marketplace}</Badge>
                    {product.brand && <span>{product.brand}</span>}
                  </div>
                  {product.domain === 'my' && product.skus.length > 0 && (
                    <SkuChips
                      skus={product.skus}
                      className="mt-2"
                      onSkuSelect={() => {
                        const nextSelection = selectProductForSkuContext({
                          selectedKeys,
                          productKey: product.key,
                          maxSelected,
                        })
                        if (nextSelection.selectedKeys !== selectedKeys) {
                          onSelectedKeysChange(nextSelection.selectedKeys)
                        }
                        return nextSelection.accepted
                      }}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function SkuChips({
  skus,
  className,
  onSkuSelect,
}: {
  skus: string[]
  className?: string
  onSkuSelect?: (sku: string) => boolean | void
}) {
  const [expanded, setExpanded] = useState(false)
  const [contextSku, setContextSku] = useState<string | null>(null)
  const visibleSkus = expanded ? skus : skus.slice(0, 4)

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {visibleSkus.map(sku => (
        <button
          key={sku}
          type="button"
          title="Use this seller SKU as display context"
          onClick={event => {
            event.stopPropagation()
            if (onSkuSelect?.(sku) !== false) setContextSku(sku)
          }}
          onKeyDown={event => event.stopPropagation()}
          className={cn(
            'rounded border px-1.5 py-0.5 font-mono text-[9px]',
            contextSku === sku ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {sku}
        </button>
      ))}
      {!expanded && skus.length > 4 && (
        <button
          type="button"
          onClick={event => { event.stopPropagation(); setExpanded(true) }}
          onKeyDown={event => event.stopPropagation()}
          className="px-1 text-[9px] text-primary hover:underline"
        >
          +{skus.length - 4} more
        </button>
      )}
    </div>
  )
}
