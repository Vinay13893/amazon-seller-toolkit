'use client'

import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { SkuPerformanceDailyDay } from '@/lib/sku-performance/types'
import {
  formatCount, formatDate, formatMoney, formatRatioIfNormal, formatShortDate,
  isTrustworthyDayValue,
} from './format'

interface ChartPoint {
  date: string
  sales: number | null
  spend: number | null
}

function toChartPoints(days: SkuPerformanceDailyDay[]): ChartPoint[] {
  return days.map(day => ({
    date: formatShortDate(day.date),
    // Never plot a day whose coverage state isn't a trustworthy real value
    // (REPORTED_VALUE/CONFIRMED_ZERO) -- UNKNOWN/SOURCE_NOT_COMPLETE/
    // BEFORE_HISTORY become `null`, which recharts renders as a genuine gap
    // in the line (no `connectNulls` prop below), never a fabricated zero.
    sales: isTrustworthyDayValue(day.sales.coverageState) ? day.sales.value : null,
    spend: isTrustworthyDayValue(day.spend.coverageState) ? day.spend.value : null,
  }))
}

function ChartTooltip({ active, payload, label, currencyCode }: {
  active?: boolean
  payload?: { value: number | null; name: string; color: string }[]
  label?: string
  currencyCode: string | null
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 text-muted-foreground">{label}</p>
      {payload.map(entry => (
        <p key={entry.name} className="font-semibold" style={{ color: entry.color }}>
          {entry.name}: {entry.value === null ? 'No trustworthy data' : formatMoney(entry.value, currencyCode)}
        </p>
      ))}
    </div>
  )
}

export function DailyChart({ days, currencyCode }: { days: SkuPerformanceDailyDay[]; currencyCode: string | null }) {
  const points = toChartPoints(days)

  return (
    <div className="flex flex-col gap-4">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="sales" tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
            <YAxis yAxisId="spend" orientation="right" tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<ChartTooltip currencyCode={currencyCode} />} />
            {/* connectNulls is deliberately omitted (default false) -- a gap
                in the line IS the honest signal for an untrustworthy day. */}
            <Line yAxisId="sales" type="monotone" dataKey="sales" name="Ordered sales" stroke="#22c55e" strokeWidth={2} dot={{ r: 2 }} />
            <Line yAxisId="spend" type="monotone" dataKey="spend" name="Ad spend" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 font-medium text-muted-foreground">Date</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Units</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Attributed sales</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">ACOS</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">TACOS</th>
            </tr>
          </thead>
          <tbody>
            {days.map(day => (
              <tr key={day.date} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-1.5 text-foreground">{formatDate(day.date)}</td>
                <td className="px-2 py-1.5 text-right text-foreground">
                  {isTrustworthyDayValue(day.units.coverageState) && day.units.value !== null ? formatCount(day.units.value) : '—'}
                </td>
                <td className="px-2 py-1.5 text-right text-foreground">
                  {isTrustworthyDayValue(day.attributedSales.coverageState) && day.attributedSales.value !== null
                    ? formatMoney(day.attributedSales.value, currencyCode)
                    : '—'}
                </td>
                {/* D's narrower rule: ACOS/TACOS shown ONLY when their ratio state is 'normal' -- blank otherwise, not even a word. */}
                <td className="px-2 py-1.5 text-right text-foreground">{formatRatioIfNormal(day.acos) || '—'}</td>
                <td className="px-2 py-1.5 text-right text-foreground">{formatRatioIfNormal(day.tacos) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
