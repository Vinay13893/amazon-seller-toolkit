'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, TrendingDown } from 'lucide-react'
import { entityDisplayLabel, portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import type { AdvertisedProductRow, ApiResponse, SearchTermRow, TargetingRow } from './brahmastra-shared'
import { ChartTooltip, DataTable, SkuLoserTable, downloadCsv, formatInr } from './brahmastra-shared'
import { usePaginatedRows, TablePaginationControls } from './table-pagination'

export function BrahmastraCategorySection({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  const { diagnostic, campaignDiagnostic, topSpenders, topAdSalesGenerators, deepDiagnostic, controlPanel, businessReport } = data
  const campaignTablePaging = usePaginatedRows(campaignDiagnostic.campaignTable)
  const isBusinessReportPrimary = businessReport.categoryPrimarySource === 'business_report_sku'
  const { skuMapping } = businessReport

  return (
    <div className="space-y-6">
      {controlPanel.mode === 'single' && (topSpenders.length > 0 || topAdSalesGenerators.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-foreground">Top spenders (selected period)</h2>
              <button
                type="button"
                onClick={() => downloadCsv(
                  'brahmastra_top_spenders',
                  ['date_range_start', 'date_range_end', 'mode', 'portfolio', 'campaign', 'spend', 'ad_attributed_sales', 'clicks', 'acos', 'roas', 'source'],
                  topSpenders.map(row => [
                    diagnostic.windows.afterStart, diagnostic.windows.afterEnd, controlPanel.mode, portfolioDisplayLabel(row.portfolio), row.campaignName,
                    row.afterSpend, row.afterSales, row.afterClicks, row.afterAcos, row.afterRoas, 'Amazon Ads Reports',
                  ]),
                  loadedRangeSuffix,
                )}
                className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
              >
                Export CSV
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Source: Amazon Ads Reports</p>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Ad Spend', 'Ad-attributed Sales', 'ACOS']}
              rows={topSpenders.map(row => [
                row.campaignName, portfolioDisplayLabel(row.portfolio), formatInr(row.afterSpend), formatInr(row.afterSales),
                row.afterAcos !== null ? `${row.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-foreground">Top ad sales generators (selected period)</h2>
              <button
                type="button"
                onClick={() => downloadCsv(
                  'brahmastra_top_ad_sales_generators',
                  ['date_range_start', 'date_range_end', 'mode', 'portfolio', 'campaign', 'ad_attributed_sales', 'spend', 'clicks', 'acos', 'roas', 'source'],
                  topAdSalesGenerators.map(row => [
                    diagnostic.windows.afterStart, diagnostic.windows.afterEnd, controlPanel.mode, portfolioDisplayLabel(row.portfolio), row.campaignName,
                    row.afterSales, row.afterSpend, row.afterClicks, row.afterAcos, row.afterRoas, 'Amazon Ads Reports',
                  ]),
                  loadedRangeSuffix,
                )}
                className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
              >
                Export CSV
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Source: Amazon Ads Reports</p>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Ad-attributed Sales', 'Ad Spend', 'ROAS']}
              rows={topAdSalesGenerators.map(row => [
                row.campaignName, portfolioDisplayLabel(row.portfolio), formatInr(row.afterSales), formatInr(row.afterSpend),
                row.afterRoas !== null ? `${row.afterRoas.toFixed(2)}x` : '—',
              ])}
            />
          </div>
        </div>
      )}

      {/* Business Report SKU category rollup — primary when sufficiently mapped */}
      {skuMapping.totalRows > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-red-400" /> Category (portfolio) — Business Report Ordered Product Sales
            </h2>
            {isBusinessReportPrimary && (
              <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
                Primary
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-1">Source: Seller Central Business Reports (SKU/ASIN), mapped by SKU.</p>
          {!isBusinessReportPrimary && (
            <p className="text-xs text-amber-600 dark:text-amber-300 mb-3">
              Business Report SKU category mapping incomplete. {skuMapping.unmappedRows} row(s) / {formatInr(skuMapping.unmappedOrderedProductSales)} ordered sales unmapped. Settlement category table below remains the fallback.
            </p>
          )}
          <DataTable
            columns={['Portfolio', 'Range A Ordered Sales', 'Range B Ordered Sales', 'Sales Delta', 'Delta %', 'Range A Units', 'Range B Units']}
            rows={businessReport.categoryTable.map(row => [
              portfolioDisplayLabel(row.portfolio),
              formatInr(row.beforeSales),
              formatInr(row.afterSales),
              formatInr(row.deltaSales),
              row.deltaSalesPct !== null ? `${row.deltaSalesPct.toFixed(1)}%` : '—',
              row.beforeUnits.toLocaleString('en-IN'),
              row.afterUnits.toLocaleString('en-IN'),
            ])}
          />
        </div>
      )}

      {/* Category before/after */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-red-400" /> Category (portfolio) - settlement net sales delta
          {isBusinessReportPrimary && (
            <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">Fallback / reconciliation</span>
          )}
        </h2>
        <p className="text-xs text-muted-foreground mb-1">Source: Payment Transactions (settlement), mapped by SKU/category.</p>
        <p className="text-xs text-muted-foreground mb-4 italic">
          {skuMapping.totalRows > 0
            ? 'Category sales here use Settlement Net Sales by SKU/category — kept as a fallback/reconciliation view alongside the Business Report SKU category table above.'
            : 'Category sales use Settlement Net Sales by SKU/category. Business Report category split requires SKU-level Business Report data for this range.'}
        </p>
        <div className="h-64 mb-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={diagnostic.categoryTable} margin={{ top: 5, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="portfolio" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} tickFormatter={portfolioDisplayLabel} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} labelFormatter={label => typeof label === 'string' ? portfolioDisplayLabel(label) : label} />
              <Bar dataKey="deltaSales" name="Sales delta" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <DataTable
          columns={['Portfolio', 'Range A Settlement Sales', 'Range B Settlement Sales', 'Sales Delta', 'Delta %', 'Range A Units', 'Range B Units', 'Range A Refund', 'Range B Refund']}
          rows={diagnostic.categoryTable.map(row => [
            portfolioDisplayLabel(row.portfolio),
            formatInr(row.beforeSales),
            formatInr(row.afterSales),
            formatInr(row.deltaSales),
            row.deltaSalesPct !== null ? `${row.deltaSalesPct.toFixed(1)}%` : '—',
            row.beforeUnits.toLocaleString('en-IN'),
            row.afterUnits.toLocaleString('en-IN'),
            formatInr(row.beforeRefund),
            formatInr(row.afterRefund),
          ])}
        />
      </div>

      <SkuLoserTable title="Top 20 settlement revenue losers (SKU)" rows={diagnostic.topRevenueLosers} metric="sales" />
      <SkuLoserTable title="Top 20 unit/order losers (SKU)" rows={diagnostic.topUnitLosers} metric="units" />
      <SkuLoserTable title="Top 20 SKUs with worsening refund impact" rows={diagnostic.topRefundIncreases} metric="refund" />

      {/* Diagnostic notes */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" /> Diagnostic notes
        </h2>
        <ul className="space-y-2 text-sm text-foreground">
          {diagnostic.diagnosticNotes.map((note, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground">•</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      {campaignDiagnostic.hasCampaignData && (
        <>
          {/* Campaign before/after table */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign — before vs after</h2>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Range A Spend', 'Range B Spend', 'Range A Sales', 'Range B Sales', 'Range A ACOS', 'Range B ACOS']}
              rows={campaignTablePaging.pageRows.map(row => [
                row.campaignName,
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.beforeSpend),
                formatInr(row.afterSpend),
                formatInr(row.beforeSales),
                formatInr(row.afterSales),
                row.beforeAcos !== null ? `${row.beforeAcos.toFixed(1)}%` : '—',
                row.afterAcos !== null ? `${row.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
            <TablePaginationControls
              page={campaignTablePaging.page} setPage={campaignTablePaging.setPage} pageSize={campaignTablePaging.pageSize} setPageSize={campaignTablePaging.setPageSize}
              totalPages={campaignTablePaging.totalPages} totalRows={campaignTablePaging.totalRows} startIndex={campaignTablePaging.startIndex} endIndex={campaignTablePaging.endIndex}
            />
          </div>

          {/* Top campaign losers */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 campaign losers (by sales delta)</h2>
            <DataTable
              columns={['Campaign', 'Portfolio', 'Range A Sales', 'Range B Sales', 'Δ Sales', 'Δ Spend']}
              rows={campaignDiagnostic.topCampaignLosers.map(row => [
                row.campaignName,
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.beforeSales),
                formatInr(row.afterSales),
                formatInr(row.deltaSales),
                formatInr(row.deltaSpend),
              ])}
            />
          </div>

          {/* Spend up, sales down */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaigns where spend increased but sales dropped</h2>
            {campaignDiagnostic.campaignsWithSpendUpAndSalesDown.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Campaign', 'Portfolio', 'Δ Spend', 'Δ Sales']}
                rows={campaignDiagnostic.campaignsWithSpendUpAndSalesDown.map(row => [
                  row.campaignName,
                  portfolioDisplayLabel(row.portfolio),
                  formatInr(row.deltaSpend),
                  formatInr(row.deltaSales),
                ])}
              />
            )}
          </div>
        </>
      )}

      {deepDiagnostic.advertisedProduct && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Portfolio-level deep diagnostic summary (SKU-attributed ad spend/sales)</h2>
            <DataTable
              columns={['Portfolio', 'Range A Spend', 'Range B Spend', 'Range A Sales', 'Range B Sales', 'Range A ACOS', 'Range B ACOS']}
              rows={Object.values(
                deepDiagnostic.advertisedProduct.table.reduce((acc: Record<string, { portfolio: string; beforeSpend: number; afterSpend: number; beforeSales: number; afterSales: number }>, row: AdvertisedProductRow) => {
                  if (!acc[row.portfolio]) acc[row.portfolio] = { portfolio: row.portfolio, beforeSpend: 0, afterSpend: 0, beforeSales: 0, afterSales: 0 }
                  acc[row.portfolio].beforeSpend += row.beforeSpend
                  acc[row.portfolio].afterSpend += row.afterSpend
                  acc[row.portfolio].beforeSales += row.beforeSales
                  acc[row.portfolio].afterSales += row.afterSales
                  return acc
                }, {}),
              ).map(p => [
                portfolioDisplayLabel(p.portfolio), formatInr(p.beforeSpend), formatInr(p.afterSpend), formatInr(p.beforeSales), formatInr(p.afterSales),
                p.beforeSales > 0 ? `${((p.beforeSpend / p.beforeSales) * 100).toFixed(1)}%` : '—',
                p.afterSales > 0 ? `${((p.afterSpend / p.afterSales) * 100).toFixed(1)}%` : '—',
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 advertised SKU ad-sales losers</h2>
            <DataTable
              columns={['SKU', 'Portfolio', 'Range A Sales', 'Range B Sales', 'Δ Sales', 'Range A ACOS', 'Range B ACOS']}
              rows={deepDiagnostic.advertisedProduct.topLosers.map((r: AdvertisedProductRow) => [
                r.advertisedSku, portfolioDisplayLabel(r.portfolio), formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
                r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Advertised SKUs: clicks continued, sales collapsed</h2>
            {deepDiagnostic.advertisedProduct.trafficContinuedSalesCollapsed.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['SKU', 'Portfolio', 'Range A Clicks', 'Range B Clicks', 'Range A Sales', 'Range B Sales']}
                rows={deepDiagnostic.advertisedProduct.trafficContinuedSalesCollapsed.map((r: AdvertisedProductRow) => [
                  r.advertisedSku, portfolioDisplayLabel(r.portfolio), r.beforeClicks, r.afterClicks, formatInr(r.beforeSales), formatInr(r.afterSales),
                ])}
              />
            )}
          </div>
        </>
      )}

      {deepDiagnostic.targeting && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Top 20 target/keyword losers</h2>
            <DataTable
              columns={['Target', 'Match type', 'Campaign', 'Range A Sales', 'Range B Sales', 'Δ Sales']}
              rows={deepDiagnostic.targeting.topLosers.map((r: TargetingRow) => [
                entityDisplayLabel(r.targetLabel), entityDisplayLabel(r.matchType ?? '—'), r.campaignName, formatInr(r.beforeSales), formatInr(r.afterSales), formatInr(r.deltaSales),
              ])}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Targets where ACOS worsened sharply</h2>
            {deepDiagnostic.targeting.acosWorsenedSharply.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Target', 'Match type', 'Range A ACOS', 'Range B ACOS', 'Range B Clicks']}
                rows={deepDiagnostic.targeting.acosWorsenedSharply.map((r: TargetingRow) => [
                  entityDisplayLabel(r.targetLabel), entityDisplayLabel(r.matchType ?? '—'),
                  r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                  r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
                  r.afterClicks,
                ])}
              />
            )}
          </div>
        </>
      )}

      {deepDiagnostic.searchTerm && (
        <>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: high spend, zero orders after 15 June</h2>
            {deepDiagnostic.searchTerm.highSpendZeroOrdersAfter.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Range B Spend', 'Range B Clicks']}
                rows={deepDiagnostic.searchTerm.highSpendZeroOrdersAfter.map((r: SearchTermRow) => [entityDisplayLabel(r.searchTerm), r.campaignName, formatInr(r.afterSpend), r.afterClicks])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: spend up, sales down</h2>
            {deepDiagnostic.searchTerm.spendUpSalesDown.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Δ Spend', 'Δ Sales']}
                rows={deepDiagnostic.searchTerm.spendUpSalesDown.map((r: SearchTermRow) => [entityDisplayLabel(r.searchTerm), r.campaignName, formatInr(r.deltaSpend), formatInr(r.deltaSales)])}
              />
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Search terms: good before, bad after</h2>
            {deepDiagnostic.searchTerm.goodBeforeBadAfter.length === 0 ? (
              <p className="text-sm text-muted-foreground">None found.</p>
            ) : (
              <DataTable
                columns={['Search term', 'Campaign', 'Range A ACOS', 'Range B ACOS', 'Range A Purchases', 'Range B Purchases']}
                rows={deepDiagnostic.searchTerm.goodBeforeBadAfter.map((r: SearchTermRow) => [
                  entityDisplayLabel(r.searchTerm), r.campaignName,
                  r.beforeAcos !== null ? `${r.beforeAcos.toFixed(1)}%` : '—',
                  r.afterAcos !== null ? `${r.afterAcos.toFixed(1)}%` : '—',
                  r.beforePurchases, r.afterPurchases,
                ])}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
