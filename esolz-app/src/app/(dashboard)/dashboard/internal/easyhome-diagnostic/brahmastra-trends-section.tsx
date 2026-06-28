'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import type { ApiResponse } from './brahmastra-shared'
import { ChartTooltip, formatInr } from './brahmastra-shared'

/**
 * Trends & Charts is chart-focused only — the full KPI/Blended ROAS-TACOS
 * grid lives in Overview (compact) and must not be duplicated here. This
 * tab's job is the daily time-series view of the same numbers.
 */
export function BrahmastraTrendsSection({ data }: { data: ApiResponse }) {
  const { diagnostic, campaignDiagnostic } = data

  return (
    <div className="space-y-6">
      {/* Settlement daily trend */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-1">Daily settlement net sales</h2>
        <p className="text-xs text-muted-foreground mb-4">Source: Payment Transactions (settlement).</p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={diagnostic.dailyTrend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="netSales" name="Settlement net sales" stroke="#22c55e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {campaignDiagnostic.adSpendCrossCheck.warning && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-300 flex gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{campaignDiagnostic.adSpendCrossCheck.warning}</span>
        </div>
      )}

      {campaignDiagnostic.hasCampaignData ? (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-1">Daily Amazon Ads spend vs attributed sales</h2>
          <p className="text-xs text-muted-foreground mb-4">Source: Amazon Ads Reports (campaign daily rows).</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={campaignDiagnostic.campaignDailyTrend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                <Tooltip content={<ChartTooltip />} />
                <Line type="monotone" dataKey="spend" name="Amazon Ads Spend" stroke="#f59e0b" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="sales" name="Amazon Ads Attributed Sales" stroke="#22c55e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-5 text-sm text-muted-foreground">
          No campaign-level analysis available yet — import a daily Sponsored Products campaign CSV first.
        </div>
      )}

      {/* Outlier days */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4">Outlier day breakdown</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {diagnostic.outlierDays.map(day => (
            <div key={day.date} className="border border-border rounded-lg p-4 min-w-0">
              <div className="flex items-center justify-between mb-2 gap-2">
                <span className="font-semibold text-foreground">{day.date}</span>
                {day.vsAfterPeriodAvgSalesPct !== null && (
                  <Badge variant={day.vsAfterPeriodAvgSalesPct < 0 ? 'destructive' : 'secondary'} className="whitespace-nowrap">
                    {day.vsAfterPeriodAvgSalesPct >= 0 ? '+' : ''}{day.vsAfterPeriodAvgSalesPct.toFixed(0)}% vs avg
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground break-words">
                Settlement sales {formatInr(day.netSales)} · Settlement Ad charges {formatInr(day.adSpend)} · Refunds {formatInr(day.refundAmount)} · {day.rowCount} rows
              </p>
              {day.topPortfolioDrops.length > 0 && (
                <ul className="mt-2 text-xs text-muted-foreground space-y-1">
                  {day.topPortfolioDrops.map(p => (
                    <li key={p.portfolio} className="break-words">
                      {portfolioDisplayLabel(p.portfolio)}: {p.dayShare.toFixed(1)}% of that day&apos;s sales vs {p.afterPeriodAvgShare.toFixed(1)}% of the after-period average
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
