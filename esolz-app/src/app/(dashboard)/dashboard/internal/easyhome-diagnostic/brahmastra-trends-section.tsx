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
import { KpiCard } from '@/components/dashboard/KpiCard'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import type { ApiResponse } from './brahmastra-shared'
import { ChartTooltip, formatInr, pctStr, roasStr } from './brahmastra-shared'

export function BrahmastraTrendsSection({ data }: { data: ApiResponse }) {
  const { diagnostic, campaignDiagnostic, blendedMetrics, controlPanel } = data
  const { before, after } = diagnostic.accountSummary

  return (
    <div className="space-y-6">
      {/* Account summary — labels state their data source explicitly so "sales" is never
          ambiguous between total (payment transactions) and ad-attributed (Ads reports). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {controlPanel.mode === 'single' ? (
          <>
            <KpiCard label="Settlement Net Sales / Day" value={formatInr(after.netSales / Math.max(after.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Amazon Ads Spend / Day" value={formatInr(blendedMetrics.after.adSpend / Math.max(after.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Settlement Ad Charges" value={formatInr(after.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Orders" value={after.orderCount.toLocaleString('en-IN')} sub={`${after.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds" value={formatInr(after.refundAmount)} sub={`${after.refundCount} orders · Source: Payment Transactions`} />
          </>
        ) : (
          <>
            <KpiCard label="Settlement Net Sales / Day (Range A)" value={formatInr(before.netSales / Math.max(before.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Net Sales / Day (Range B)" value={formatInr(after.netSales / Math.max(after.dayCount, 1))} sub="Source: Payment Transactions" />
            <KpiCard label="Amazon Ads Spend / Day (Range A)" value={formatInr((blendedMetrics.before?.adSpend ?? 0) / Math.max(before.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Spend / Day (Range B)" value={formatInr(blendedMetrics.after.adSpend / Math.max(after.dayCount, 1))} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Settlement Ad Charges (Range A)" value={formatInr(before.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Settlement Ad Charges (Range B)" value={formatInr(after.adSpend)} sub="Audit only, not Ads KPI" />
            <KpiCard label="Orders (Range A)" value={before.orderCount.toLocaleString('en-IN')} sub={`${before.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Orders (Range B)" value={after.orderCount.toLocaleString('en-IN')} sub={`${after.unitsOrdered.toLocaleString('en-IN')} units · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds (Range A)" value={formatInr(before.refundAmount)} sub={`${before.refundCount} orders · Source: Payment Transactions`} />
            <KpiCard label="Settlement Refunds (Range B)" value={formatInr(after.refundAmount)} sub={`${after.refundCount} orders · Source: Payment Transactions`} />
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Ad-attributed Sales / Ad Spend figures below — including Blended ROAS/TACOS — come from Amazon Ads Reports, not payment transactions.
      </p>

      {/* Blended ROAS / TACOS — Settlement Net Sales/Refunds/Orders from Payment Transactions, Ad Spend/Ad Sales from Amazon Ads Reports. */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-bold text-foreground">Blended ROAS / TACOS</h2>
          {!blendedMetrics.complete && (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              Incomplete for selected range
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Settlement Net Sales/Refunds/Orders: Source: Payment Transactions · Amazon Ads Spend/Amazon Ads Attributed Sales: Source: Amazon Ads Reports · Blended ROAS/TACOS: Settlement Net Sales (Payment Transactions) combined with Amazon Ads Spend (Amazon Ads Reports). Seller Central Business Report Ordered Product Sales is not connected yet and may differ from Settlement Net Sales.
        </p>
        {!blendedMetrics.complete && (
          <p className="text-xs text-amber-600 dark:text-amber-300 mb-3">
            Selected range exceeds the latest available Ads and/or payment-transaction data — blended figures below may be incomplete until both sources catch up. This does not affect Ads-only Findings/Good Working.
          </p>
        )}
        {controlPanel.mode === 'single' ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Settlement Net Sales" value={formatInr(blendedMetrics.after.totalSalesNet)} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Gross Product Sales" value={formatInr(blendedMetrics.after.grossSales)} sub="Source: Payment Transactions" />
            <KpiCard label="Settlement Refunds" value={formatInr(blendedMetrics.after.refunds)} sub="Source: Payment Transactions" />
            <KpiCard label="Orders" value={blendedMetrics.after.totalOrders.toLocaleString('en-IN')} sub="Distinct orders · Payment Transactions" />
            <KpiCard label="Units" value={blendedMetrics.after.unitsSold.toLocaleString('en-IN')} sub={`${blendedMetrics.after.refundedUnits.toLocaleString('en-IN')} refunded`} />
            <KpiCard label="Amazon Ads Spend" value={formatInr(blendedMetrics.after.adSpend)} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales" value={formatInr(blendedMetrics.after.adSales)} sub="Source: Amazon Ads Reports" />
            <KpiCard label="Ad ROAS" value={roasStr(blendedMetrics.after.adRoas)} sub="Amazon Ads Attributed Sales ÷ Amazon Ads Spend" />
            <KpiCard label="Blended ROAS" value={roasStr(blendedMetrics.after.blendedRoas)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="TACOS / Blended ACOS" value={pctStr(blendedMetrics.after.tacos)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="Organic Estimate" value={formatInr(blendedMetrics.after.organicEstimate)} sub="Settlement Net Sales − Amazon Ads Attributed Sales (estimate)" />
            <KpiCard label="Ad Sales Share" value={pctStr(blendedMetrics.after.adSalesShare)} sub="Amazon Ads Attributed Sales ÷ Settlement Net Sales" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Settlement Net Sales (A)" value={formatInr(blendedMetrics.before?.totalSalesNet ?? 0)} sub="Payment Transactions" />
            <KpiCard label="Settlement Net Sales (B)" value={formatInr(blendedMetrics.after.totalSalesNet)} sub="Payment Transactions" />
            <KpiCard label="Amazon Ads Spend (A)" value={formatInr(blendedMetrics.before?.adSpend ?? 0)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Spend (B)" value={formatInr(blendedMetrics.after.adSpend)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales (A)" value={formatInr(blendedMetrics.before?.adSales ?? 0)} sub="Amazon Ads Reports" />
            <KpiCard label="Amazon Ads Attributed Sales (B)" value={formatInr(blendedMetrics.after.adSales)} sub="Amazon Ads Reports" />
            <KpiCard label="Blended ROAS (A)" value={roasStr(blendedMetrics.before?.blendedRoas ?? null)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="Blended ROAS (B)" value={roasStr(blendedMetrics.after.blendedRoas)} sub="Settlement Net Sales ÷ Amazon Ads Spend" />
            <KpiCard label="TACOS (A)" value={pctStr(blendedMetrics.before?.tacos ?? null)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="TACOS (B)" value={pctStr(blendedMetrics.after.tacos)} sub="Amazon Ads Spend ÷ Settlement Net Sales" />
            <KpiCard label="Organic Estimate (A)" value={formatInr(blendedMetrics.before?.organicEstimate ?? 0)} sub="Estimate" />
            <KpiCard label="Organic Estimate (B)" value={formatInr(blendedMetrics.after.organicEstimate)} sub="Estimate" />
            <KpiCard label="Settlement Refunds (A)" value={formatInr(blendedMetrics.before?.refunds ?? 0)} sub="Payment Transactions" />
            <KpiCard label="Settlement Refunds (B)" value={formatInr(blendedMetrics.after.refunds)} sub="Payment Transactions" />
            <KpiCard label="Orders (A)" value={(blendedMetrics.before?.totalOrders ?? 0).toLocaleString('en-IN')} sub="Distinct orders" />
            <KpiCard label="Orders (B)" value={blendedMetrics.after.totalOrders.toLocaleString('en-IN')} sub="Distinct orders" />
            <KpiCard label="Units (A)" value={(blendedMetrics.before?.unitsSold ?? 0).toLocaleString('en-IN')} sub="Payment Transactions" />
            <KpiCard label="Units (B)" value={blendedMetrics.after.unitsSold.toLocaleString('en-IN')} sub="Payment Transactions" />
          </div>
        )}
        {blendedMetrics.insights.length > 0 && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className="text-xs font-semibold text-foreground mb-2">Blended insights (correlation only — review manually, not a causal claim)</p>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {blendedMetrics.insights.map((note, i) => (
                <li key={i} className="flex gap-2">
                  <span>•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

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
            <div key={day.date} className="border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-foreground">{day.date}</span>
                {day.vsAfterPeriodAvgSalesPct !== null && (
                  <Badge variant={day.vsAfterPeriodAvgSalesPct < 0 ? 'destructive' : 'secondary'}>
                    {day.vsAfterPeriodAvgSalesPct >= 0 ? '+' : ''}{day.vsAfterPeriodAvgSalesPct.toFixed(0)}% vs after-period avg
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Settlement sales {formatInr(day.netSales)} · Settlement Ad charges {formatInr(day.adSpend)} · Refunds {formatInr(day.refundAmount)} · {day.rowCount} rows
              </p>
              {day.topPortfolioDrops.length > 0 && (
                <ul className="mt-2 text-xs text-muted-foreground space-y-1">
                  {day.topPortfolioDrops.map(p => (
                    <li key={p.portfolio}>
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
