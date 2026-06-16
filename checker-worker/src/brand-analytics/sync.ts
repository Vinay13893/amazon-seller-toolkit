import {
  BRAND_ANALYTICS_REPORT_TYPES,
  type BrandAnalyticsReportType,
  decryptToken,
  downloadAmazonReportDocument,
  getAmazonReportDocument,
  parseBrandAnalyticsReport,
  refreshAccessToken,
} from './amazonReports'
import {
  createSupabaseAdminClient,
  getAmazonConnection,
  getBrandAnalyticsJob,
  getSafeBatchSize,
  requireWorkerEnvForSync,
  updateAmazonDocumentSummary,
  updateAmazonJobSummary,
  updateAmazonReportDocument,
} from './supabase'

type SyncInput = {
  jobId: string
  batchSize?: number
}

type BrandAnalyticsSyncErrorCode =
  | 'env_missing'
  | 'job_not_found'
  | 'job_not_done'
  | 'missing_report_document'
  | 'unsupported_report_type'
  | 'connection_unavailable'
  | 'document_download_failed'
  | 'row_store_failed'
  | 'summary_update_failed'
  | 'sync_failed'

class BrandAnalyticsSyncError extends Error {
  code: BrandAnalyticsSyncErrorCode

  constructor(code: BrandAnalyticsSyncErrorCode) {
    super(code)
    this.code = code
  }
}

function isSupportedReportType(value: string): value is BrandAnalyticsReportType {
  return BRAND_ANALYTICS_REPORT_TYPES.includes(value as BrandAnalyticsReportType)
}

function toSafeErrorMessage(code: BrandAnalyticsSyncErrorCode): string {
  switch (code) {
    case 'env_missing':
      return 'Brand Analytics sync failed: required worker environment is missing.'
    case 'job_not_found':
      return 'Brand Analytics sync failed: job not found.'
    case 'job_not_done':
      return 'Brand Analytics sync failed: job is not DONE.'
    case 'missing_report_document':
      return 'Brand Analytics sync failed: report document is missing.'
    case 'unsupported_report_type':
      return 'Brand Analytics sync failed: unsupported report type.'
    case 'connection_unavailable':
      return 'Brand Analytics sync failed: Amazon connection unavailable.'
    case 'document_download_failed':
      return 'Brand Analytics sync failed: report document download failed.'
    case 'row_store_failed':
      return 'Brand Analytics sync failed: storing parsed rows failed.'
    case 'summary_update_failed':
      return 'Brand Analytics sync failed: summary update failed.'
    default:
      return 'Brand Analytics sync failed.'
  }
}

export type BrandAnalyticsSyncResult = {
  jobId: string
  reportId: string | null
  reportType: string
  reportDocumentId: string
  totalParsedRows: number
  totalStoredRows: number
  batchSize: number
  fieldNames: string[]
  targetTable: string
  status: 'success' | 'failed'
  errorCode: BrandAnalyticsSyncErrorCode | null
  errorMessage: string | null
}

function pickValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) return null
    const parsed = Number.parseFloat(normalized)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

function toNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) return null
    if (normalized.endsWith('%')) {
      const pct = Number.parseFloat(normalized.slice(0, -1))
      return Number.isFinite(pct) ? pct / 100 : null
    }
    const parsed = Number.parseFloat(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function mapRowsForTable(
  reportType: BrandAnalyticsReportType,
  rows: Record<string, unknown>[],
  baseRow: Record<string, unknown>,
): { targetTable: string; onConflict: string; rowsToUpsert: Record<string, unknown>[] } {
  if (reportType === 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT') {
    return {
      targetTable: 'brand_analytics_search_query_rows',
      onConflict: 'workspace_id,report_id,search_query,asin',
      rowsToUpsert: rows.map((row) => ({
        ...baseRow,
        asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
        search_query: toText(pickValue(row, ['search_query', 'query', 'customer_search_term', 'search_term'])) ?? '',
        impressions: toInt(pickValue(row, ['impressions', 'search_query_impressions'])),
        clicks: toInt(pickValue(row, ['clicks', 'search_query_clicks'])),
        cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
        purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
        click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
        purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
        top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
        top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
        top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
        raw_row: row,
      })),
    }
  }

  if (reportType === 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT') {
    return {
      targetTable: 'brand_analytics_search_terms_rows',
      onConflict: 'workspace_id,report_id,search_term,asin',
      rowsToUpsert: rows.map((row) => ({
        ...baseRow,
        asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
        search_term: toText(pickValue(row, ['search_term', 'search_query', 'query'])) ?? '',
        impressions: toInt(pickValue(row, ['impressions', 'search_term_impressions'])),
        clicks: toInt(pickValue(row, ['clicks', 'search_term_clicks'])),
        cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
        purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
        click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
        purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
        top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
        top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
        top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
        raw_row: row,
      })),
    }
  }

  return {
    targetTable: 'brand_analytics_search_catalog_rows',
    onConflict: 'workspace_id,report_id,asin,search_query',
    rowsToUpsert: rows.map((row) => ({
      ...baseRow,
      asin: toText(pickValue(row, ['asin', 'child_asin', 'product_asin'])) ?? '',
      search_query: toText(pickValue(row, ['search_query', 'query', 'search_term'])) ?? '',
      impressions: toInt(pickValue(row, ['impressions'])),
      clicks: toInt(pickValue(row, ['clicks'])),
      cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
      purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
      click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
      purchase_share: toNumeric(pickValue(row, ['purchase_share'])),
      top_clicked_asin_1: toText(pickValue(row, ['top_clicked_asin_1', 'top_clicked_asin1'])),
      top_clicked_asin_2: toText(pickValue(row, ['top_clicked_asin_2', 'top_clicked_asin2'])),
      top_clicked_asin_3: toText(pickValue(row, ['top_clicked_asin_3', 'top_clicked_asin3'])),
      raw_row: row,
    })),
  }
}

export async function runBrandAnalyticsSync(input: SyncInput): Promise<BrandAnalyticsSyncResult> {
  const batchSize = getSafeBatchSize(input.batchSize)

  const baseErrorResult: BrandAnalyticsSyncResult = {
    jobId: input.jobId,
    reportId: null,
    reportType: '',
    reportDocumentId: '',
    totalParsedRows: 0,
    totalStoredRows: 0,
    batchSize,
    fieldNames: [],
    targetTable: '',
    status: 'failed',
    errorCode: null,
    errorMessage: null,
  }

  try {
    try {
      requireWorkerEnvForSync()
    } catch {
      throw new BrandAnalyticsSyncError('env_missing')
    }

    const supabase = createSupabaseAdminClient()
    const job = await getBrandAnalyticsJob(supabase, input.jobId)
    if (!job) {
      throw new BrandAnalyticsSyncError('job_not_found')
    }

    if (job.processing_status !== 'DONE') {
      throw new BrandAnalyticsSyncError('job_not_done')
    }

    if (!job.report_document_id) {
      throw new BrandAnalyticsSyncError('missing_report_document')
    }

    if (!isSupportedReportType(job.report_type)) {
      throw new BrandAnalyticsSyncError('unsupported_report_type')
    }

    const reportType = job.report_type
    const connection = await getAmazonConnection(supabase, job.amazon_connection_id)
    if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
      throw new BrandAnalyticsSyncError('connection_unavailable')
    }

    const refreshToken = decryptToken(connection.refresh_token_encrypted)
    const { accessToken } = await refreshAccessToken(refreshToken)

    let document
    let rawContent = ''
    try {
      document = await getAmazonReportDocument(accessToken, job.report_document_id)
      rawContent = await downloadAmazonReportDocument(document)
    } catch {
      throw new BrandAnalyticsSyncError('document_download_failed')
    }

    const parsed = parseBrandAnalyticsReport(reportType, rawContent)

    const now = new Date().toISOString()
    await updateAmazonReportDocument(supabase, {
      workspace_id: job.workspace_id,
      amazon_connection_id: job.amazon_connection_id,
      amazon_report_job_id: job.id,
      report_type: job.report_type,
      report_id: job.report_id,
      report_document_id: document.reportDocumentId,
      marketplace_id: job.marketplace_id,
      report_period: job.report_period,
      data_start_time: job.data_start_time,
      data_end_time: job.data_end_time,
      processing_status: 'DONE',
      requested_at: job.requested_at,
      completed_at: now,
      raw_summary: {
        document_compression: document.compressionAlgorithm ?? null,
        document_encrypted: !!document.encryptionDetails,
      },
      updated_at: now,
    })

    const baseRow = {
      workspace_id: job.workspace_id,
      amazon_connection_id: job.amazon_connection_id,
      marketplace_id: job.marketplace_id ?? 'A21TJRUUN4KGV',
      report_id: job.report_id,
      report_document_id: job.report_document_id,
      report_period: job.report_period,
      data_start_time: job.data_start_time,
      data_end_time: job.data_end_time,
      updated_at: now,
    }

    const mapped = mapRowsForTable(reportType, parsed.rows, baseRow)
    let totalStoredRows = 0

    for (let i = 0; i < mapped.rowsToUpsert.length; i += batchSize) {
      const chunk = mapped.rowsToUpsert.slice(i, i + batchSize)
      if (chunk.length === 0) continue
      const { error: upsertError } = await supabase
        .from(mapped.targetTable)
        .upsert(chunk, { onConflict: mapped.onConflict })

      if (upsertError) {
        throw new BrandAnalyticsSyncError('row_store_failed')
      }

      totalStoredRows += chunk.length
    }

    const mergedSummary = {
      ...(job.raw_summary ?? {}),
      synced_at: now,
      parse_format: parsed.format,
      parsed_row_count: parsed.rows.length,
      stored_row_count: totalStoredRows,
      parsed_field_names: parsed.fieldNames,
      target_table: mapped.targetTable,
      sync_runner: 'checker-worker',
      sync_batch_size: batchSize,
    }

    try {
      await updateAmazonJobSummary(supabase, input.jobId, {
        processing_status: 'DONE',
        completed_at: now,
        raw_summary: mergedSummary,
        updated_at: now,
      })

      await updateAmazonDocumentSummary(supabase, job.workspace_id, job.report_document_id, {
        processing_status: 'DONE',
        completed_at: now,
        raw_summary: mergedSummary,
        updated_at: now,
      })
    } catch {
      throw new BrandAnalyticsSyncError('summary_update_failed')
    }

    return {
      jobId: input.jobId,
      reportId: job.report_id,
      reportType,
      reportDocumentId: job.report_document_id,
      totalParsedRows: parsed.rows.length,
      totalStoredRows,
      batchSize,
      fieldNames: parsed.fieldNames,
      targetTable: mapped.targetTable,
      status: 'success',
      errorCode: null,
      errorMessage: null,
    }
  } catch (error) {
    const errorCode = error instanceof BrandAnalyticsSyncError ? error.code : 'sync_failed'
    const reportType = errorCode === 'unsupported_report_type' ? 'UNSUPPORTED' : ''

    console.error('[brand-analytics-sync] failed', {
      jobId: input.jobId,
      errorCode,
    })

    return {
      ...baseErrorResult,
      reportType,
      errorCode,
      errorMessage: toSafeErrorMessage(errorCode),
    }
  }
}
