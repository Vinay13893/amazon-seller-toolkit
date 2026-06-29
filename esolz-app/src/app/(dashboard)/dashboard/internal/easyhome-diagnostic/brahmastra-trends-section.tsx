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
  const { diagnostic, campaignDiagnostic, businessReportDailyTrend, primarySalesSource } = data
  const isBusinessReportPrimary = primarySalesSource === 'business_report'

  // Daily Ads spend keyed by date, merged onto whichever sales series is
  // primary — Business Report Ordered Product Sales when complete for the
  // loaded range, otherwise Settlement Net Sales with an explicit fallback
  // warning. The two sales series are never combined into one number.
  const spendByDate = new Map(campaignDiagnostic.campaignDailyTrend.map(row => [row.date, row.spend]))
  const primarySalesSeries = isBusinessReportPrimary
    ? businessReportDailyTrend.map(row => ({ date: row.date, primarySales: row.orderedProductSales, spend: spendByDate.get(row.date) ?? null }))
    : diagnostic.dailyTrend.map(row => ({ date: row.date, primarySales: row.netSales, spend: spendByDate.get(row.date) ?? null }))

  return (
    <div className="space-y-6">
      {/* Primary daily trend — source switches with primarySalesSource */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-1">
          {isBusinessReportPrimary ? 'Daily Ordered Product Sales vs Amazon Ads Spend' : 'Daily Settlement Net Sales vs Amazon Ads Spend'}
        </h2>
        <p className="text-xs text-muted-foreground mb-1">
          {isBusinessReportPrimary
            ? 'Sales: Seller Central Business Reports. Spend: Amazon Ads Reports.'
            : 'Sales: Payment Transactions (settlement). Spend: Amazon Ads Reports.'}
        </p>
        {!isBusinessReportPrimary && (
          <p className="text-xs text-amber-600 dark:text-amber-300 mb-3">
            Business Report data is missing for this range — showing Settlement Net Sales as a fallback.
          </p>
        )}
        <p className="text-xs text-muted-foreground mb-4 italic">
          Settlement Net Sales can differ due to settlement/refund timing.
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={primarySalesSeries} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="primarySales" name={isBusinessReportPrimary ? 'Ordered Product Sales' : 'Settlement Net Sales'} stroke="#22c55e" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="spend" name="Amazon Ads Spend" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls />
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

      {!campaignDiagnostic.hasCampaignData && (
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
