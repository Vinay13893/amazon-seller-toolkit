'use client'

import { useCallback, useEffect, useState } from 'react'
import { resolveAsinProductDomains, type AsinProduct, type CatalogProductRow, type CompetitorProductRow } from '@/lib/asins/product-domain'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { createClient } from '@/lib/supabase/client'

export function useAsinProductDomains() {
  const [myProducts, setMyProducts] = useState<AsinProduct[]>([])
  const [competitorProducts, setCompetitorProducts] = useState<AsinProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [competitorsUnavailable, setCompetitorsUnavailable] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    const workspaceId = await getWorkspaceId()
    if (!workspaceId) {
      setMyProducts([])
      setCompetitorProducts([])
      setCatalogUnavailable(true)
      setCompetitorsUnavailable(true)
      setLoading(false)
      return
    }

    const supabase = createClient()
    const [catalogResult, trackedResult] = await Promise.all([
      supabase
        .from('amazon_listing_items')
        .select('id, asin, sku, marketplace_id, item_name, brand, product_type, image_url')
        .eq('workspace_id', workspaceId)
        .not('asin', 'is', null)
        .limit(5000),
      supabase
        .from('tracked_asins')
        .select('id, asin, marketplace, product_title, brand, category, image_url, status')
        .eq('workspace_id', workspaceId)
        .neq('status', 'archived')
        .limit(5000),
    ])

    const catalogFailed = Boolean(catalogResult.error)
    const trackedFailed = Boolean(trackedResult.error)
    const domains = resolveAsinProductDomains({
      catalogRows: (catalogResult.data ?? []) as CatalogProductRow[],
      trackedRows: (trackedResult.data ?? []) as CompetitorProductRow[],
      catalogUnavailable: catalogFailed,
      trackedUnavailable: trackedFailed,
    })

    setMyProducts(domains.myProducts)
    setCompetitorProducts(domains.competitorProducts)
    setCatalogUnavailable(catalogFailed)
    setCompetitorsUnavailable(catalogFailed || trackedFailed)
    setLoading(false)
  }, [])

  useEffect(() => {
    queueMicrotask(() => { void reload() })
  }, [reload])

  return { myProducts, competitorProducts, loading, catalogUnavailable, competitorsUnavailable, reload }
}
