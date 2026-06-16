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

type SafeDbError = {
  code: string | null
  hint: string | null
  message: string | null
}

type SafeSyncDiagnostics = {
  parsedRowCount: number
  rowsPreparedForInsertCount: number
  targetTable: string
  parsedFieldNames: string[]
  insertColumnNames: string[]
  missingRequiredColumns: string[]
  unsupportedReportType: boolean
  dbErrorCode: string | null
  dbErrorHint: string | null
  dbErrorMessage: string | null
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

function getRequiredInsertColumns(targetTable: string): string[] {
  if (targetTable === 'brand_analytics_search_terms_rows') {
    return [
      'workspace_id',
      'amazon_connection_id',
      'marketplace_id',
      'report_document_id',
      'department_name',
      'search_term',
      'clicked_asin',
      'click_share_rank',
    ]
  }
  if (targetTable === 'brand_analytics_search_query_rows') {
    return ['workspace_id', 'amazon_connection_id', 'marketplace_id', 'report_id', 'search_query', 'asin']
  }
  if (targetTable === 'brand_analytics_search_catalog_rows') {
    return ['workspace_id', 'amazon_connection_id', 'marketplace_id', 'report_id', 'search_query', 'asin']
  }
  return []
}

function getInsertColumnNames(rows: Record<string, unknown>[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).sort()
}

function getMissingRequiredColumns(targetTable: string, insertColumnNames: string[]): string[] {
  const columnSet = new Set(insertColumnNames)
  return getRequiredInsertColumns(targetTable).filter((column) => !columnSet.has(column))
}

function sanitizeDbError(error: unknown): SafeDbError {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; hint?: unknown; message?: unknown; details?: unknown }
    : {}
  const code = typeof record.code === 'string' ? record.code : null
  const rawMessage = typeof record.message === 'string' ? record.message : ''
  const rawHint = typeof record.hint === 'string' ? record.hint : ''
  const rawDetails = typeof record.details === 'string' ? record.details : ''
  const combined = `${rawMessage} ${rawDetails}`.toLowerCase()

  let message = 'Database write failed.'
  if (combined.includes('row-level security')) {
    message = 'Database write failed: row-level security policy blocked the write.'
  } else if (combined.includes('schema cache') || combined.includes('could not find')) {
    message = 'Database write failed: table or column was not found in schema cache.'
  } else if (combined.includes('not-null') || combined.includes('null value')) {
    message = 'Database write failed: required column was null.'
  } else if (combined.includes('duplicate key') || combined.includes('unique constraint')) {
    message = 'Database write failed: unique constraint conflict.'
  } else if (combined.includes('foreign key')) {
    message = 'Database write failed: foreign key constraint failed.'
  } else if (combined.includes('invalid input syntax')) {
    message = 'Database write failed: invalid value type for a column.'
  } else if (combined.includes('no unique') || combined.includes('on conflict')) {
    message = 'Database write failed: onConflict columns do not match a unique constraint.'
  }

  const hint = rawHint && !/[=:]/.test(rawHint) ? rawHint.slice(0, 160) : null
  return { code, hint, message }
}

function createBaseDiagnostics(): SafeSyncDiagnostics {
  return {
    parsedRowCount: 0,
    rowsPreparedForInsertCount: 0,
    targetTable: '',
    parsedFieldNames: [],
    insertColumnNames: [],
    missingRequiredColumns: [],
    unsupportedReportType: false,
    dbErrorCode: null,
    dbErrorHint: null,
    dbErrorMessage: null,
  }
}

export type BrandAnalyticsSyncResult = {
  jobId: string
  reportId: string | null
  reportType: string
  reportDocumentId: string
  totalParsedRows: number
  rowsPreparedForInsertCount: number
  totalStoredRows: number
  batchSize: number
  fieldNames: string[]
  targetTable: string
  insertColumnNames: string[]
  missingRequiredColumns: string[]
  unsupportedReportType: boolean
  dbErrorCode: string | null
  dbErrorHint: string | null
  dbErrorMessage: string | null
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
      onConflict: 'workspace_id,report_document_id,department_name,search_term,clicked_asin,click_share_rank',
      rowsToUpsert: rows.map((row) => ({
        ...baseRow,
        department_name: toText(pickValue(row, ['department_name', 'department'])) ?? '',
        search_frequency_rank: toInt(pickValue(row, ['search_frequency_rank'])),
        clicked_asin: toText(pickValue(row, ['clicked_asin', 'asin', 'child_asin', 'product_asin'])) ?? '',
        clicked_item_name: toText(pickValue(row, ['clicked_item_name', 'item_name', 'product_title'])),
        click_share_rank: toInt(pickValue(row, ['click_share_rank'])) ?? 0,
        conversion_share: toNumeric(pickValue(row, ['conversion_share', 'purchase_share'])),
        asin: toText(pickValue(row, ['clicked_asin', 'asin', 'child_asin', 'product_asin'])) ?? '',
        search_term: toText(pickValue(row, ['search_term', 'search_query', 'query'])) ?? '',
        impressions: toInt(pickValue(row, ['impressions', 'search_term_impressions'])),
        clicks: toInt(pickValue(row, ['clicks', 'search_term_clicks'])),
        cart_adds: toInt(pickValue(row, ['cart_adds', 'add_to_carts', 'cart_additions'])),
        purchases: toInt(pickValue(row, ['purchases', 'units_ordered'])),
        click_share: toNumeric(pickValue(row, ['click_share', 'clickthrough_share'])),
        purchase_share: toNumeric(pickValue(row, ['purchase_share', 'conversion_share'])),
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
  const syncStartedAt = new Date().toISOString()

  const baseErrorResult: BrandAnalyticsSyncResult = {
    jobId: input.jobId,
    reportId: null,
    reportType: '',
    reportDocumentId: '',
    totalParsedRows: 0,
    rowsPreparedForInsertCount: 0,
    totalStoredRows: 0,
    batchSize,
    fieldNames: [],
    targetTable: '',
    insertColumnNames: [],
    missingRequiredColumns: [],
    unsupportedReportType: false,
    dbErrorCode: null,
    dbErrorHint: null,
    dbErrorMessage: null,
    status: 'failed',
    errorCode: null,
    errorMessage: null,
  }
  let safeContext: Pick<BrandAnalyticsSyncResult, 'reportId' | 'reportType' | 'reportDocumentId'> = {
    reportId: null,
    reportType: '',
    reportDocumentId: '',
  }
  const diagnostics = createBaseDiagnostics()

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
      diagnostics.unsupportedReportType = true
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
    diagnostics.parsedRowCount = parsed.rows.length
    diagnostics.parsedFieldNames = parsed.fieldNames

    const now = new Date().toISOString()
    try {
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
    } catch (error) {
      const dbError = sanitizeDbError(error)
      diagnostics.dbErrorCode = dbError.code
      diagnostics.dbErrorHint = dbError.hint
      diagnostics.dbErrorMessage = dbError.message
      throw new BrandAnalyticsSyncError('store_rows_failed')
    }

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
    diagnostics.targetTable = mapped.targetTable
    diagnostics.rowsPreparedForInsertCount = mapped.rowsToUpsert.length
    diagnostics.insertColumnNames = getInsertColumnNames(mapped.rowsToUpsert)
    diagnostics.missingRequiredColumns = getMissingRequiredColumns(mapped.targetTable, diagnostics.insertColumnNames)
    let totalStoredRows = 0

    const createProgressSummary = (status: 'running' | 'done' | 'failed', overrides: Record<string, unknown> = {}) => ({
      ...(job.raw_summary ?? {}),
      sync_status: status,
      sync_started_at: syncStartedAt,
      sync_updated_at: new Date().toISOString(),
      parsed_row_count: parsed.rows.length,
      rows_prepared_for_insert_count: mapped.rowsToUpsert.length,
      stored_row_count: totalStoredRows,
      parsed_field_names: parsed.fieldNames,
      target_table: mapped.targetTable,
      sync_runner: 'checker-worker',
      sync_batch_size: batchSize,
      ...overrides,
    })

    await updateAmazonJobSummary(supabase, input.jobId, {
      raw_summary: createProgressSummary('running'),
      updated_at: new Date().toISOString(),
    })

    for (let i = 0; i < mapped.rowsToUpsert.length; i += batchSize) {
      const chunk = mapped.rowsToUpsert.slice(i, i + batchSize)
      if (chunk.length === 0) continue
      const { error: upsertError } = await supabase
        .from(mapped.targetTable)
        .upsert(chunk, { onConflict: mapped.onConflict })

      if (upsertError) {
        const dbError = sanitizeDbError(upsertError)
        diagnostics.dbErrorCode = dbError.code
        diagnostics.dbErrorHint = dbError.hint
        diagnostics.dbErrorMessage = dbError.message
        throw new BrandAnalyticsSyncError('store_rows_failed')
      }

      totalStoredRows += chunk.length

      await updateAmazonJobSummary(supabase, input.jobId, {
        raw_summary: createProgressSummary('running', {
          stored_row_count: totalStoredRows,
          sync_offset: i + chunk.length,
        }),
        updated_at: new Date().toISOString(),
      })
    }

    const mergedSummary = {
      ...(job.raw_summary ?? {}),
      synced_at: now,
      sync_status: 'done',
      sync_started_at: syncStartedAt,
      sync_updated_at: now,
      parse_format: parsed.format,
      parsed_row_count: parsed.rows.length,
      rows_prepared_for_insert_count: mapped.rowsToUpsert.length,
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
      diagnostics.dbErrorMessage = diagnostics.dbErrorMessage ?? 'Database write failed: summary update failed.'
      throw new BrandAnalyticsSyncError('store_rows_failed')
    }

    return {
      jobId: input.jobId,
      reportId: job.report_id,
      reportType,
      reportDocumentId: job.report_document_id,
      totalParsedRows: parsed.rows.length,
      rowsPreparedForInsertCount: diagnostics.rowsPreparedForInsertCount,
      totalStoredRows,
      batchSize,
      fieldNames: parsed.fieldNames,
      targetTable: mapped.targetTable,
      insertColumnNames: diagnostics.insertColumnNames,
      missingRequiredColumns: diagnostics.missingRequiredColumns,
      unsupportedReportType: diagnostics.unsupportedReportType,
      dbErrorCode: null,
      dbErrorHint: null,
      dbErrorMessage: null,
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

    const failedResult = {
      ...baseErrorResult,
      ...safeContext,
      totalParsedRows: diagnostics.parsedRowCount,
      targetTable: diagnostics.targetTable,
      rowsPreparedForInsertCount: diagnostics.rowsPreparedForInsertCount,
      fieldNames: diagnostics.parsedFieldNames,
      insertColumnNames: diagnostics.insertColumnNames,
      missingRequiredColumns: diagnostics.missingRequiredColumns,
      unsupportedReportType: diagnostics.unsupportedReportType,
      dbErrorCode: diagnostics.dbErrorCode,
      dbErrorHint: diagnostics.dbErrorHint,
      dbErrorMessage: diagnostics.dbErrorMessage,
      errorCode,
      errorMessage: getSafeSyncErrorMessage(error, errorCode),
    }

    try {
      const supabase = createSupabaseAdminClient()
      const job = await getBrandAnalyticsJob(supabase, input.jobId)
      await updateAmazonJobSummary(supabase, input.jobId, {
        raw_summary: {
          ...(job?.raw_summary ?? {}),
          sync_status: 'failed',
          sync_started_at: syncStartedAt,
          sync_updated_at: new Date().toISOString(),
          parsed_row_count: failedResult.totalParsedRows,
          rows_prepared_for_insert_count: failedResult.rowsPreparedForInsertCount,
          stored_row_count: failedResult.totalStoredRows,
          target_table: failedResult.targetTable,
          last_failed_stage: errorCode,
          last_error_code: errorCode,
        },
        updated_at: new Date().toISOString(),
      })
    } catch {
      // Best-effort progress update only.
    }

    return failedResult
  }
}
