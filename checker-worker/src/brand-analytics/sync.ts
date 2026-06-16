import {
  AmazonReportDocumentStageError,
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
  | 'read_job_failed'
  | 'env_missing'
  | 'job_not_found'
  | 'missing_job_report_document_id'
  | 'load_spapi_credentials_failed'
  | 'missing_spapi_credentials'
  | 'decrypt_refresh_token_failed'
  | 'lwa_access_token_failed'
  | 'get_report_document_failed'
  | 'report_document_url_missing'
  | 'download_report_document_failed'
  | 'decompress_report_failed'
  | 'parse_report_failed'
  | 'unsupported_report_type'
  | 'store_rows_failed'
  | 'count_rows_failed'
  | 'sync_failed'

class BrandAnalyticsSyncError extends Error {
  code: BrandAnalyticsSyncErrorCode

  constructor(code: BrandAnalyticsSyncErrorCode, safeMessage?: string) {
    super(safeMessage ?? code)
    this.code = code
  }
}

function getMissingWorkerEnvNames(): string[] {
  return [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SPAPI_ENCRYPTION_KEY',
    'SPAPI_LWA_CLIENT_ID',
    'SPAPI_LWA_CLIENT_SECRET',
  ].filter((name) => !process.env[name]?.trim())
}

function isSupportedReportType(value: string): value is BrandAnalyticsReportType {
  return BRAND_ANALYTICS_REPORT_TYPES.includes(value as BrandAnalyticsReportType)
}

function toSafeErrorMessage(code: BrandAnalyticsSyncErrorCode): string {
  switch (code) {
    case 'env_missing':
      return 'Brand Analytics sync failed: required worker environment is missing.'
    case 'read_job_failed':
      return 'Brand Analytics sync failed: report job could not be read.'
    case 'job_not_found':
      return 'Brand Analytics sync failed: job not found.'
    case 'missing_job_report_document_id':
      return 'Brand Analytics sync failed: report document is missing.'
    case 'load_spapi_credentials_failed':
      return 'Brand Analytics sync failed: SP-API credentials could not be loaded.'
    case 'missing_spapi_credentials':
      return 'Brand Analytics sync failed: SP-API credentials are missing.'
    case 'decrypt_refresh_token_failed':
      return 'Stored SP-API credential could not be decrypted; verify SPAPI_ENCRYPTION_KEY matches production app.'
    case 'lwa_access_token_failed':
      return 'Amazon LWA token exchange failed; verify matching client id/client secret pair.'
    case 'get_report_document_failed':
      return 'Brand Analytics sync failed: report document metadata could not be read.'
    case 'report_document_url_missing':
      return 'Brand Analytics sync failed: report document URL is missing.'
    case 'download_report_document_failed':
      return 'Brand Analytics sync failed: report document download failed.'
    case 'decompress_report_failed':
      return 'Brand Analytics sync failed: report document decompression failed.'
    case 'parse_report_failed':
      return 'Brand Analytics sync failed: report document could not be parsed.'
    case 'unsupported_report_type':
      return 'Brand Analytics sync failed: unsupported report type.'
    case 'store_rows_failed':
      return 'Brand Analytics sync failed: storing parsed rows failed.'
    case 'count_rows_failed':
      return 'Brand Analytics sync failed: stored row counts could not be read.'
    default:
      return 'Brand Analytics sync failed.'
  }
}

function getSafeSyncErrorMessage(error: unknown, code: BrandAnalyticsSyncErrorCode): string {
  if (error instanceof BrandAnalyticsSyncError && error.message && error.message !== code) {
    return error.message
  }
  return toSafeErrorMessage(code)
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
  let safeContext: Pick<BrandAnalyticsSyncResult, 'reportId' | 'reportType' | 'reportDocumentId'> = {
    reportId: null,
    reportType: '',
    reportDocumentId: '',
  }

  try {
    try {
      requireWorkerEnvForSync()
    } catch {
      const missingEnvNames = getMissingWorkerEnvNames()
      const safeMessage = missingEnvNames.length > 0
        ? `Brand Analytics sync failed: missing worker environment: ${missingEnvNames.join(', ')}.`
        : toSafeErrorMessage('env_missing')
      throw new BrandAnalyticsSyncError('env_missing', safeMessage)
    }

    const supabase = createSupabaseAdminClient()
    let job
    try {
      job = await getBrandAnalyticsJob(supabase, input.jobId)
    } catch {
      throw new BrandAnalyticsSyncError('read_job_failed')
    }

    if (!job) {
      throw new BrandAnalyticsSyncError('job_not_found')
    }

    safeContext = {
      reportId: job.report_id,
      reportType: job.report_type,
      reportDocumentId: job.report_document_id ?? '',
    }

    if (job.processing_status !== 'DONE') {
      throw new BrandAnalyticsSyncError('read_job_failed')
    }

    if (!job.report_document_id) {
      throw new BrandAnalyticsSyncError('missing_job_report_document_id')
    }

    if (!isSupportedReportType(job.report_type)) {
      throw new BrandAnalyticsSyncError('unsupported_report_type')
    }

    const reportType = job.report_type
    let connection
    try {
      connection = await getAmazonConnection(supabase, job.amazon_connection_id)
    } catch {
      throw new BrandAnalyticsSyncError('load_spapi_credentials_failed')
    }

    if (!connection || connection.status !== 'active' || !connection.refresh_token_encrypted) {
      throw new BrandAnalyticsSyncError('missing_spapi_credentials')
    }

    let refreshToken
    try {
      refreshToken = decryptToken(connection.refresh_token_encrypted)
    } catch {
      throw new BrandAnalyticsSyncError('decrypt_refresh_token_failed')
    }

    let accessToken
    try {
      ;({ accessToken } = await refreshAccessToken(refreshToken))
    } catch {
      throw new BrandAnalyticsSyncError('lwa_access_token_failed')
    }

    let document
    try {
      document = await getAmazonReportDocument(accessToken, job.report_document_id)
    } catch (error) {
      if (error instanceof AmazonReportDocumentStageError && error.code === 'report_document_url_missing') {
        throw new BrandAnalyticsSyncError('report_document_url_missing')
      }
      throw new BrandAnalyticsSyncError('get_report_document_failed')
    }

    let rawContent = ''
    try {
      rawContent = await downloadAmazonReportDocument(document)
    } catch (error) {
      if (error instanceof AmazonReportDocumentStageError) {
        throw new BrandAnalyticsSyncError(error.code)
      }
      throw new BrandAnalyticsSyncError('download_report_document_failed')
    }

    let parsed
    try {
      parsed = parseBrandAnalyticsReport(reportType, rawContent)
    } catch {
      throw new BrandAnalyticsSyncError('parse_report_failed')
    }

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
        throw new BrandAnalyticsSyncError('store_rows_failed')
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
      throw new BrandAnalyticsSyncError('store_rows_failed')
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
    console.error('[brand-analytics-sync] failed', {
      jobId: input.jobId,
      errorCode,
    })

    return {
      ...baseErrorResult,
      ...safeContext,
      errorCode,
      errorMessage: getSafeSyncErrorMessage(error, errorCode),
    }
  }
}
