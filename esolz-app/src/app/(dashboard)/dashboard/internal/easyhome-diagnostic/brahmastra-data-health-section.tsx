'use client'

import { AlertTriangle, Megaphone } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { portfolioDisplayLabel } from '@/lib/internal/portfolio-labels'
import type { ApiResponse, ControlPanelMeta, SourceAccuracyAudit } from './brahmastra-shared'
import { DataTable, downloadCsv, formatInr, formatInrCompact } from './brahmastra-shared'

/**
 * Reused by both Overview (standard view) and Data Health & Imports
 * (expanded view, per Phase R5 spec) so the source-of-truth numbers never
 * drift between the two places they're shown.
 */
export function AccuracyAuditPanel({
  controlPanel,
  sourceAccuracyAudit,
}: {
  controlPanel: ControlPanelMeta
  sourceAccuracyAudit: SourceAccuracyAudit
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Data source accuracy audit</p>
          <p className="text-xs text-muted-foreground">
            Settlement net sales/refunds/orders: Payment Transactions. Amazon Ads spend/ad-attributed sales/ACOS/ROAS: Amazon Ads Reports. Business Report sessions/page-views: not connected.
          </p>
        </div>
        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {controlPanel.mode === 'single' ? 'Selected range' : 'Range A vs Range B'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-3">
        <KpiCard label="Mode" value={sourceAccuracyAudit.ranges.mode} sub="Requested by Control Panel" subWrap />
        <KpiCard
          label="Requested Range A"
          value={`${sourceAccuracyAudit.ranges.requestedRangeA.startDate} → ${sourceAccuracyAudit.ranges.requestedRangeA.endDate}`}
          sub="From query params"
          subWrap
        />
        <KpiCard
          label="Effective Range A"
          value={`${sourceAccuracyAudit.ranges.effectiveRangeA.startDate} → ${sourceAccuracyAudit.ranges.effectiveRangeA.endDate}`}
          sub="Actually used by API"
          subWrap
        />
        <KpiCard
          label="Effective Range B"
          value={`${sourceAccuracyAudit.ranges.effectiveRangeB.startDate} → ${sourceAccuracyAudit.ranges.effectiveRangeB.endDate}`}
          sub="Actually used by API"
          subWrap
        />
        <KpiCard label="Latest Ads Date" value={sourceAccuracyAudit.latestAdsDate ?? '—'} sub="Ads Reports" subTitle="Amazon Ads Reports" />
        <KpiCard label="Latest Payment Transaction Date" value={sourceAccuracyAudit.latestSalesDate ?? '—'} sub="Payment Txns" subTitle="Payment Transactions (settlement)" />
        <KpiCard label="Blended metrics complete" value={sourceAccuracyAudit.blendedMetricsComplete ? 'Yes' : 'No'} sub="Both sources required" subWrap />
        <KpiCard label="Business Report" value="Not connected" sub="No sessions/page-views" subTitle="No sessions/page-views in this diagnostic" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <KpiCard label="Settlement Net Sales (B)" value={formatInrCompact(sourceAccuracyAudit.rangeB.settlementNetSales)} valueTitle={formatInr(sourceAccuracyAudit.rangeB.settlementNetSales)} sub="Payment Txns" subTitle="Payment Transactions" />
        <KpiCard label="Amazon Ads Spend (B)" value={formatInrCompact(sourceAccuracyAudit.rangeB.amazonAdsSpend)} valueTitle={formatInr(sourceAccuracyAudit.rangeB.amazonAdsSpend)} sub="Campaign daily rows" />
        <KpiCard label="Settlement Ad Charges (B)" value={formatInrCompact(sourceAccuracyAudit.rangeB.settlementAdCharges)} valueTitle={formatInr(sourceAccuracyAudit.rangeB.settlementAdCharges)} sub="Audit only" subTitle="Settlement Ad Charges — not used as campaign spend" />
        <KpiCard label="Campaign vs Deep Report Variance (B)" value={formatInrCompact(sourceAccuracyAudit.rangeB.amazonAdsSpend - sourceAccuracyAudit.rangeB.advertisedProductSpend)} valueTitle={formatInr(sourceAccuracyAudit.rangeB.amazonAdsSpend - sourceAccuracyAudit.rangeB.advertisedProductSpend)} sub="Campaign minus adv-product" subTitle="Campaign-level minus advertised-product-level" subWrap />
        {controlPanel.mode === 'compare' && (
          <>
            <KpiCard label="Settlement Net Sales (A)" value={formatInrCompact(sourceAccuracyAudit.rangeA.settlementNetSales)} valueTitle={formatInr(sourceAccuracyAudit.rangeA.settlementNetSales)} sub="Payment Txns" subTitle="Payment Transactions" />
            <KpiCard label="Amazon Ads Spend (A)" value={formatInrCompact(sourceAccuracyAudit.rangeA.amazonAdsSpend)} valueTitle={formatInr(sourceAccuracyAudit.rangeA.amazonAdsSpend)} sub="Campaign daily rows" />
            <KpiCard label="Settlement Ad Charges (A)" value={formatInrCompact(sourceAccuracyAudit.rangeA.settlementAdCharges)} valueTitle={formatInr(sourceAccuracyAudit.rangeA.settlementAdCharges)} sub="Audit only" subTitle="Settlement Ad Charges — not used as campaign spend" />
            <KpiCard label="Campaign vs Deep Report Variance (A)" value={formatInrCompact(sourceAccuracyAudit.rangeA.amazonAdsSpend - sourceAccuracyAudit.rangeA.advertisedProductSpend)} valueTitle={formatInr(sourceAccuracyAudit.rangeA.amazonAdsSpend - sourceAccuracyAudit.rangeA.advertisedProductSpend)} sub="Campaign minus adv-product" subTitle="Campaign-level minus advertised-product-level" subWrap />
          </>
        )}
      </div>
      {sourceAccuracyAudit.warnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-600 dark:text-amber-300 mt-3">{w}</p>
      ))}
    </div>
  )
}

export function MappingHealthCard({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  const { diagnostic } = data
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-foreground">Mapping health</h2>
        {diagnostic.mappingHealth.topUnmappedSkus.length > 0 && (
          <button
            type="button"
            onClick={() => downloadCsv(
              'brahmastra_unmapped_skus',
              ['sku', 'range_a_sales', 'range_b_sales', 'total_sales'],
              diagnostic.mappingHealth.topUnmappedSkus.map(row => [row.sku, row.beforeSales, row.afterSales, row.totalSales]),
              loadedRangeSuffix,
            )}
            className="inline-flex items-center gap-1 text-xs text-primary border border-border rounded-md px-2 py-1 hover:bg-muted"
          >
            Export Unmapped SKUs CSV
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <KpiCard label="SKUs analysed" value={diagnostic.mappingHealth.totalSkusAnalyzed.toLocaleString('en-IN')} />
        <KpiCard label="Mapped" value={diagnostic.mappingHealth.mappedSkuCount.toLocaleString('en-IN')} />
        <KpiCard label="Unmapped" value={diagnostic.mappingHealth.unmappedSkuCount.toLocaleString('en-IN')} />
        <KpiCard label="Revenue in unmapped bucket" value={formatInrCompact(diagnostic.mappingHealth.unmappedRevenue)} valueTitle={formatInr(diagnostic.mappingHealth.unmappedRevenue)} />
      </div>
      {diagnostic.mappingHealth.topUnmappedSkus.length > 0 && (
        <DataTable
          columns={['SKU', 'Range A', 'Range B', 'Total']}
          rows={diagnostic.mappingHealth.topUnmappedSkus.map(row => [
            row.sku,
            formatInr(row.beforeSales),
            formatInr(row.afterSales),
            formatInr(row.totalSales),
          ])}
        />
      )}
    </div>
  )
}

export function BrahmastraDataHealthSection({ data, loadedRangeSuffix }: { data: ApiResponse; loadedRangeSuffix: string }) {
  const { controlPanel, sourceAccuracyAudit, paymentImportStatus, campaignDiagnostic, latestCampaignUploadBatch, latestDeepReportBatches, deepDiagnostic } = data

  return (
    <div className="space-y-6">
      {/* Data Quality indicator */}
      <div className="bg-card border border-border rounded-xl p-4">
        {(() => {
          const hasIssue = Boolean(controlPanel.dataFreshness?.adsDataIncomplete || controlPanel.dataFreshness?.salesDataIncomplete || controlPanel.dataFreshness?.changeHistoryIncomplete)
          const status: 'Healthy' | 'Warning' | 'Blocked' = !controlPanel.selectedProfileId ? 'Blocked' : hasIssue ? 'Warning' : 'Healthy'
          const colorClass = status === 'Healthy'
            ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300'
            : status === 'Warning'
              ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300'
          return (
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${colorClass}`}>
                Data Quality: {status}
              </span>
              <span className="text-xs text-muted-foreground">
                Profile: {controlPanel.selectedProfileName ?? controlPanel.selectedProfileId} ({controlPanel.selectedProfileId}) ·
                {' '}Ads through {controlPanel.dataFreshness?.latestAdsDate ?? 'unknown'} ·
                {' '}Sales through {controlPanel.dataFreshness?.latestSalesDate ?? 'unknown'} ·
                {' '}Change History through {controlPanel.dataFreshness?.latestChangeHistoryDate ?? 'unknown'} ·
                {' '}Profile isolation: scoped (Ads tables filtered by profile_id)
              </span>
            </div>
          )
        })()}
      </div>

      {/* Data freshness */}
      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-sm font-semibold text-foreground mb-1">Data available</p>
        <p className="text-xs text-muted-foreground">
          Ads reports are complete through {controlPanel.dataFreshness?.latestAdsDate ?? 'unknown'}. Sales/payment transactions are complete through {controlPanel.dataFreshness?.latestSalesDate ?? 'unknown'}. Change History is complete through {controlPanel.dataFreshness?.latestChangeHistoryDate ?? 'unknown'}.
        </p>
        {controlPanel.dataFreshness?.adsDataIncomplete && (
          <p className="text-sm text-amber-400 mt-2">
            Selected range extends beyond available Ads data — Ads spend/sales/clicks/ACOS/ROAS findings and Good Working rows may be incomplete for this range.
          </p>
        )}
        {controlPanel.dataFreshness?.salesDataIncomplete && (
          <p className="text-sm text-amber-400 mt-2">
            Total-sales/blended metrics may be incomplete until payment transactions are refreshed. Ads-only findings above are not affected.
          </p>
        )}
        {controlPanel.dataFreshness?.changeHistoryIncomplete && (
          <p className="text-xs text-muted-foreground mt-2">
            Change History is behind the selected range — change-history correlation context may be incomplete; this does not affect Ads or sales metrics.
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-2 italic">
          Order-level and geo demand metrics will use Amazon payment transaction reports as the source of truth for SKU/date/order/geo/fulfillment/returns where available. This is not yet auto-refreshed.
        </p>
        {paymentImportStatus && (
          <div className="mt-3 border-t border-border/60 pt-3">
            <p className="text-xs font-semibold text-foreground mb-1">Payment Transaction Import</p>
            <p className="text-xs text-muted-foreground">
              Last file: {paymentImportStatus.lastFileName} · {paymentImportStatus.acceptedCount} accepted / {paymentImportStatus.rejectedCount} rejected ·{' '}
              {paymentImportStatus.insertedCount} inserted / {paymentImportStatus.updatedCount} updated · uploaded {new Date(paymentImportStatus.uploadedAt).toLocaleString('en-IN')}
            </p>
            <p className="text-xs text-muted-foreground italic">
              No buyer name, email, phone, address, or order ID is shown here — counts and dates only.
            </p>
          </div>
        )}
      </div>

      <AccuracyAuditPanel controlPanel={controlPanel} sourceAccuracyAudit={sourceAccuracyAudit} />

      <MappingHealthCard data={data} loadedRangeSuffix={loadedRangeSuffix} />

      {/* Ads campaign import status */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Ads campaign CSV import
        </h2>
        {latestCampaignUploadBatch ? (
          <div className="text-sm text-foreground space-y-1">
            <p>
              Latest file: <span className="font-semibold">{latestCampaignUploadBatch.original_filename}</span>{' '}
              ({latestCampaignUploadBatch.report_date_start} → {latestCampaignUploadBatch.report_date_end})
            </p>
            <p className="text-muted-foreground text-xs">
              {latestCampaignUploadBatch.accepted_count} accepted / {latestCampaignUploadBatch.rejected_count} rejected ·{' '}
              {latestCampaignUploadBatch.inserted_count} inserted / {latestCampaignUploadBatch.updated_count} updated ·{' '}
              {latestCampaignUploadBatch.campaign_count} campaigns ({latestCampaignUploadBatch.unmapped_campaign_count} unmapped) ·{' '}
              uploaded {new Date(latestCampaignUploadBatch.uploaded_at).toLocaleString('en-IN')}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No campaign CSV has been imported yet. Export a <strong>daily</strong> Sponsored Products campaign report from Amazon Ads
            Console (not a period-aggregate report) and import it via POST /api/internal/ads-campaign-daily/import.
          </p>
        )}
      </div>

      {campaignDiagnostic.adSpendCrossCheck.warning && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-300 flex gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{campaignDiagnostic.adSpendCrossCheck.warning}</span>
        </div>
      )}

      {campaignDiagnostic.hasCampaignData && (
        <>
          {/* Campaign mapping health */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign mapping health</h2>
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <KpiCard label="Campaigns analysed" value={campaignDiagnostic.campaignMappingHealth.totalCampaignsAnalyzed.toLocaleString('en-IN')} />
              <KpiCard label="Mapped" value={campaignDiagnostic.campaignMappingHealth.mappedCampaignCount.toLocaleString('en-IN')} />
              <KpiCard label="Unmapped" value={campaignDiagnostic.campaignMappingHealth.unmappedCampaignCount.toLocaleString('en-IN')} />
              <KpiCard label="Spend in unmapped bucket" value={formatInrCompact(campaignDiagnostic.campaignMappingHealth.unmappedSpend)} valueTitle={formatInr(campaignDiagnostic.campaignMappingHealth.unmappedSpend)} />
            </div>
            {campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns.length > 0 && (
              <DataTable
                columns={['Campaign', 'Total Spend', 'Total Sales']}
                rows={campaignDiagnostic.campaignMappingHealth.topUnmappedCampaigns.map(row => [row.campaignName, formatInr(row.totalSpend), formatInr(row.totalSales)])}
              />
            )}
          </div>

          {/* Campaign vs actual sales cross-check */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">Campaign sales vs actual portfolio sales (cross-check)</h2>
            <DataTable
              columns={['Portfolio', 'Campaign Range A', 'Actual Range A', 'Gap %', 'Campaign Range B', 'Actual Range B', 'Gap %']}
              rows={campaignDiagnostic.campaignPortfolioCrossCheck.map(row => [
                portfolioDisplayLabel(row.portfolio),
                formatInr(row.campaignBeforeSales),
                formatInr(row.actualBeforeSales),
                row.beforeGapPct !== null ? `${row.beforeGapPct.toFixed(0)}%` : '—',
                formatInr(row.campaignAfterSales),
                formatInr(row.actualAfterSales),
                row.afterGapPct !== null ? `${row.afterGapPct.toFixed(0)}%` : '—',
              ])}
            />
          </div>
        </>
      )}

      {/* Deep SP report import status */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Deep SP report import status (SKU / targeting / search term)
        </h2>
        {latestDeepReportBatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deep report (advertised product / targeting / search term) has been imported yet.</p>
        ) : (
          <DataTable
            columns={['Report kind', 'Filename', 'Date range', 'Accepted/Rejected', 'Campaigns', 'Unmapped', 'Attribution window', 'Uploaded']}
            rows={latestDeepReportBatches.map(b => [
              b.report_kind,
              b.original_filename,
              `${b.report_date_start ?? '—'} → ${b.report_date_end ?? '—'}`,
              `${b.accepted_count}/${b.rejected_count}`,
              b.campaign_count,
              b.unmapped_count,
              b.attribution_window_used ?? '—',
              new Date(b.uploaded_at).toLocaleString('en-IN'),
            ])}
          />
        )}
      </div>

      {(deepDiagnostic.advertisedProduct || deepDiagnostic.targeting || deepDiagnostic.searchTerm) && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-bold text-foreground mb-4">Deep report mapping health</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {deepDiagnostic.advertisedProduct && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Advertised product</p>
                <p className="text-sm text-foreground">{deepDiagnostic.advertisedProduct.mappingHealth.mappedCount}/{deepDiagnostic.advertisedProduct.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.advertisedProduct.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
            {deepDiagnostic.targeting && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Targeting</p>
                <p className="text-sm text-foreground">{deepDiagnostic.targeting.mappingHealth.mappedCount}/{deepDiagnostic.targeting.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.targeting.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
            {deepDiagnostic.searchTerm && (
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Search term</p>
                <p className="text-sm text-foreground">{deepDiagnostic.searchTerm.mappingHealth.mappedCount}/{deepDiagnostic.searchTerm.mappingHealth.totalAnalyzed} mapped</p>
                <p className="text-xs text-muted-foreground">Unmapped spend {formatInr(deepDiagnostic.searchTerm.mappingHealth.unmappedSpend)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Data gaps */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-bold text-foreground mb-3">What&apos;s still missing for campaign-level diagnosis</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {data.diagnostic.dataGaps.map((gap, i) => (
            <li key={i} className="flex gap-2">
              <span>•</span>
              <span>{gap}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
