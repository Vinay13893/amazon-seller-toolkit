import { KpiCard } from '@/components/dashboard/KpiCard'
import { InsightFeed } from '@/components/dashboard/InsightFeed'
import { MOCK_BSR_SUMMARY, MOCK_INSIGHTS } from '@/lib/mock-data'
import { Package, TrendingUp, Bell, Clock, RefreshCw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default function DashboardPage() {
  const ranked = MOCK_BSR_SUMMARY
    .filter(a => a.bsr_rank !== null)
    .sort((a, b) => (a.bsr_rank ?? 0) - (b.bsr_rank ?? 0))

  const bestAsin = ranked[0]
  const latestCapture = MOCK_BSR_SUMMARY
    .filter(a => a.captured_at)
    .sort((a, b) => new Date(b.captured_at!).getTime() - new Date(a.captured_at!).getTime())[0]

  return (
    <div className="space-y-6 max-w-7xl">
      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Tracked ASINs"
          value={MOCK_BSR_SUMMARY.length}
          sub="5 of 5 used (Free limit)"
          icon={Package}
        />
        <KpiCard
          label="Best BSR Rank"
          value={bestAsin ? `#${bestAsin.bsr_rank!.toLocaleString('en-IN')}` : '—'}
          sub={bestAsin?.label ?? ''}
          icon={TrendingUp}
          trend={{ value: -8, label: 'positions today' }}
        />
        <KpiCard
          label="Active Alerts"
          value={1}
          sub="1 warning triggered"
          icon={Bell}
        />
        <KpiCard
          label="Last Refresh"
          value={latestCapture ? timeAgo(latestCapture.captured_at!) : 'Never'}
          sub="Auto-refresh every 12h"
          icon={Clock}
        />
      </div>

      {/* BSR Table + Insight Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* BSR Quick View */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="font-bold">BSR Overview</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Button>
              <Button size="sm" render={<Link href="/dashboard/asins" />} className="h-8 gap-1.5 text-xs">
                <Plus className="w-3.5 h-3.5" /> Add ASIN
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border/60">
                  <th className="text-left px-5 py-3 font-semibold uppercase tracking-wider">ASIN</th>
                  <th className="text-left px-3 py-3 font-semibold uppercase tracking-wider">Label</th>
                  <th className="text-right px-3 py-3 font-semibold uppercase tracking-wider">BSR</th>
                  <th className="text-left px-3 py-3 font-semibold uppercase tracking-wider hidden sm:table-cell">Category</th>
                  <th className="text-right px-5 py-3 font-semibold uppercase tracking-wider hidden md:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_BSR_SUMMARY.map((row, i) => (
                  <tr
                    key={row.asin_id}
                    className={`hover:bg-muted/20 transition-colors ${
                      i < MOCK_BSR_SUMMARY.length - 1 ? 'border-b border-border/40' : ''
                    }`}
                  >
                    <td className="px-5 py-3 font-mono text-xs text-blue-400">{row.asin}</td>
                    <td className="px-3 py-3 text-sm max-w-[160px] truncate">{row.label}</td>
                    <td className="px-3 py-3 text-right font-bold">
                      {row.bsr_rank !== null
                        ? `#${row.bsr_rank.toLocaleString('en-IN')}`
                        : <span className="text-muted-foreground font-normal text-xs">—</span>
                      }
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground hidden sm:table-cell max-w-[140px] truncate">
                      {row.category ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-muted-foreground hidden md:table-cell">
                      {row.captured_at ? timeAgo(row.captured_at) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 border-t border-border/60">
            <Link href="/dashboard/bsr" className="text-xs text-primary hover:underline">
              View full BSR tracker →
            </Link>
          </div>
        </div>

        {/* Insight Feed */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="font-bold">Recent Activity</h2>
          </div>
          <div className="p-3">
            <InsightFeed insights={MOCK_INSIGHTS} />
          </div>
        </div>
      </div>

      {/* Upgrade banner */}
      <div className="bg-primary/5 border border-primary/20 rounded-xl px-5 py-4 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
        <div>
          <p className="font-semibold text-sm">You&apos;re on the Free plan</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upgrade to track more ASINs, get faster refresh, and unlock all tools.
          </p>
        </div>
        <Button size="sm" render={<Link href="/dashboard/billing" />} className="flex-shrink-0">
          Upgrade Now
        </Button>
      </div>
    </div>
  )
}
