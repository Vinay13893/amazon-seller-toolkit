'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Loader2, Zap } from 'lucide-react'
import { getPlanUsage, type PlanUsage } from '@/lib/supabase/asins'

export function SidebarPlanCard() {
  const [usage, setUsage]   = useState<PlanUsage | null>(null)
  const [loading, setLoading] = useState(true)

  function refreshUsage() {
    setLoading(true)
    getPlanUsage()
      .then(setUsage)
      .catch(() => setUsage(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refreshUsage()

    function onUsageChanged() {
      refreshUsage()
    }

    window.addEventListener('asin:usage-changed', onUsageChanged)
    return () => window.removeEventListener('asin:usage-changed', onUsageChanged)
  }, [])

  const planName  = usage?.planName  ?? 'Free'
  const asinCount = usage?.asinCount ?? 0
  const asinLimit = usage?.asinLimit ?? 5

  return (
    <div className="bg-primary/10 border border-primary/20 rounded-xl p-3.5">
      {/* Plan name row */}
      <div className="flex items-center gap-2 mb-1.5">
        <Zap className="w-3.5 h-3.5 text-primary flex-shrink-0" />
        {loading ? (
          <span className="h-3 w-16 rounded bg-primary/20 animate-pulse inline-block" />
        ) : (
          <span className="text-xs font-bold">{planName} Plan</span>
        )}
      </div>

      {/* Usage text */}
      <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed min-h-[2.5em]">
        {loading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading usage…
          </span>
        ) : usage ? (
          planName === 'Internal Tester' || planName === 'Internal Test'
            ? `${asinCount} ASINs tracked. Internal testing access enabled.`
            : `${asinCount}/${asinLimit} ASINs used. Upgrade for more features.`
        ) : (
          'Upgrade for more features.'
        )}
      </p>

      {/* CTA */}
      <Link
        href="/dashboard/billing"
        className="flex items-center justify-center gap-1 w-full bg-primary text-primary-foreground text-[11px] font-bold py-2 px-3 rounded-lg hover:bg-primary/90 transition-colors"
      >
        {planName === 'Internal Tester' || planName === 'Internal Test' ? 'View Billing' : 'Upgrade Plan'}
        <ChevronRight className="w-3 h-3" />
      </Link>
    </div>
  )
}
