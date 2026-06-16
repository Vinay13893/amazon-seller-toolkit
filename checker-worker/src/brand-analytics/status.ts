import {
  createSupabaseAdminClient,
  getBrandAnalyticsJob,
} from './supabase'

type StatusInput = {
  jobId: string
}

type BrandAnalyticsStatusErrorCode =
  | 'job_not_found'
  | 'document_read_failed'
  | 'row_count_failed'
  | 'status_failed'

type BrandAnalyticsStatusDebugFailedStage =
  | 'invalid_payload'
  | 'job_not_allowed'
  | 'env_missing'
  | 'create_supabase_client_failed'
  | 'read_job_failed'
  | 'job_not_found'
  | 'read_document_failed'
  | 'count_by_report_id_failed'
  | 'count_by_document_id_failed'
  | 'success'

type EnvPresence = {
  hasSupabaseUrl: boolean
  hasSupabaseServiceRoleKey: boolean
}

export type BrandAnalyticsStatusResult = {
  success: boolean
  jobId: string
  reportId: string | null
  reportType: string | null
  reportDocumentId: string | null
  jobProcessingStatus: string | null
  jobParsedRowCount: number | null
  jobStoredRowCount: number | null
  documentProcessingStatus: string | null
  documentStoredRowCount: number | null
  rowCountByReportId: number | null
  rowCountByReportDocumentId: number | null
  brandAnalyticsRowsAppearStored: boolean | null
  errorCode: BrandAnalyticsStatusErrorCode | null
  errorMessage: string | null
}

export type BrandAnalyticsStatusDebugResult = {
  success: boolean
  failedStage: BrandAnalyticsStatusDebugFailedStage
  envPresence: EnvPresence
  jobId: string
  reportId: string | null
  reportType: string | null
  reportDocumentId: string | null
  jobProcessingStatus: string | null
  jobParsedRowCount: number | null
  jobStoredRowCount: number | null
  documentProcessingStatus: string | null
  documentStoredRowCount: number | null
  rowCountByReportId: number | null
  rowCountByReportDocumentId: number | null
  syncStatus: string | null
  parsedRowCount: number | null
  storedRowCount: number | null
  countSource: 'exact' | 'sync_summary' | 'unavailable'
  brandAnalyticsRowsAppearStored: boolean | null
  errorCode: Exclude<BrandAnalyticsStatusDebugFailedStage, 'success'> | null
  errorMessage: string | null
}

function toSafeErrorMessage(code: BrandAnalyticsStatusErrorCode): string {
  switch (code) {
    case 'job_not_found':
      return 'Brand Analytics status failed: job not found.'
    case 'document_read_failed':
      return 'Brand Analytics status failed: document summary read failed.'
    case 'row_count_failed':
      return 'Brand Analytics status failed: row count read failed.'
    default:
      return 'Brand Analytics status failed.'
  }
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return null
}

function getEnvPresence(): EnvPresence {
  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  return {
    hasSupabaseUrl: Boolean(url),
    hasSupabaseServiceRoleKey: Boolean(key),
  }
}

function createDebugBaseResult(jobId: string): BrandAnalyticsStatusDebugResult {
  return {
    success: false,
    failedStage: 'read_job_failed',
    envPresence: getEnvPresence(),
    jobId,
    reportId: null,
    reportType: null,
    reportDocumentId: null,
    jobProcessingStatus: null,
    jobParsedRowCount: null,
    jobStoredRowCount: null,
    documentProcessingStatus: null,
    documentStoredRowCount: null,
    rowCountByReportId: null,
    rowCountByReportDocumentId: null,
    syncStatus: null,
    parsedRowCount: null,
    storedRowCount: null,
    countSource: 'unavailable',
    brandAnalyticsRowsAppearStored: null,
    errorCode: null,
    errorMessage: null,
  }
}

function createDebugFailure(
  base: BrandAnalyticsStatusDebugResult,
  failedStage: Exclude<BrandAnalyticsStatusDebugFailedStage, 'success'>,
  errorMessage: string,
  overrides: Partial<BrandAnalyticsStatusDebugResult> = {},
): BrandAnalyticsStatusDebugResult {
  return {
    ...base,
    ...overrides,
    success: false,
    failedStage,
    errorCode: failedStage,
    errorMessage,
  }
}

export async function getBrandAnalyticsStatus(
  input: StatusInput,
): Promise<BrandAnalyticsStatusResult> {
  const supabase = createSupabaseAdminClient()

  const baseResult: BrandAnalyticsStatusResult = {
    success: false,
    jobId: input.jobId,
    reportId: null,
    reportType: null,
    reportDocumentId: null,
    jobProcessingStatus: null,
    jobParsedRowCount: null,
    jobStoredRowCount: null,
    documentProcessingStatus: null,
    documentStoredRowCount: null,
    rowCountByReportId: null,
    rowCountByReportDocumentId: null,
    brandAnalyticsRowsAppearStored: null,
    errorCode: null,
    errorMessage: null,
  }

  try {
    const job = await getBrandAnalyticsJob(supabase, input.jobId)
    if (!job) {
      return {
        ...baseResult,
        errorCode: 'job_not_found',
        errorMessage: toSafeErrorMessage('job_not_found'),
      }
    }

    const jobSummary = job.raw_summary ?? {}
    const parsedRowCount = toNullableNumber(jobSummary.parsed_row_count)
    const storedRowCount = toNullableNumber(jobSummary.stored_row_count)

    let documentProcessingStatus: string | null = null
    let documentStoredRowCount: number | null = null
    if (job.report_document_id) {
      const { data: docData, error: docError } = await supabase
        .from('amazon_report_documents')
        .select('processing_status, raw_summary')
        .eq('workspace_id', job.workspace_id)
        .eq('report_document_id', job.report_document_id)
        .maybeSingle()

      if (docError) {
        return {
          ...baseResult,
          reportId: job.report_id,
          reportType: job.report_type,
          reportDocumentId: job.report_document_id,
          jobProcessingStatus: job.processing_status,
          jobParsedRowCount: parsedRowCount,
          jobStoredRowCount: storedRowCount,
          errorCode: 'document_read_failed',
          errorMessage: toSafeErrorMessage('document_read_failed'),
        }
      }

      if (docData) {
        documentProcessingStatus =
          typeof docData.processing_status === 'string'
            ? docData.processing_status
            : null
        const rawSummary =
          docData.raw_summary && typeof docData.raw_summary === 'object'
            ? (docData.raw_summary as Record<string, unknown>)
            : {}
        documentStoredRowCount = toNullableNumber(rawSummary.stored_row_count)
      }
    }

    let rowCountByReportId: number | null = null
    if (job.report_id) {
      const { count, error } = await supabase
        .from('brand_analytics_search_terms_rows')
        .select('*', { head: true, count: 'exact' })
        .eq('report_id', job.report_id)

      if (error) {
        return {
          ...baseResult,
          reportId: job.report_id,
          reportType: job.report_type,
          reportDocumentId: job.report_document_id,
          jobProcessingStatus: job.processing_status,
          jobParsedRowCount: parsedRowCount,
          jobStoredRowCount: storedRowCount,
          documentProcessingStatus,
          documentStoredRowCount,
          errorCode: 'row_count_failed',
          errorMessage: toSafeErrorMessage('row_count_failed'),
        }
      }

      rowCountByReportId = count ?? 0
    }

    let rowCountByReportDocumentId: number | null = null
    if (job.report_document_id) {
      const { count, error } = await supabase
        .from('brand_analytics_search_terms_rows')
        .select('*', { head: true, count: 'exact' })
        .eq('report_document_id', job.report_document_id)

      if (error) {
        return {
          ...baseResult,
          reportId: job.report_id,
          reportType: job.report_type,
          reportDocumentId: job.report_document_id,
          jobProcessingStatus: job.processing_status,
          jobParsedRowCount: parsedRowCount,
          jobStoredRowCount: storedRowCount,
          documentProcessingStatus,
          documentStoredRowCount,
          rowCountByReportId,
          errorCode: 'row_count_failed',
          errorMessage: toSafeErrorMessage('row_count_failed'),
        }
      }

      rowCountByReportDocumentId = count ?? 0
    }

    const brandAnalyticsRowsAppearStored =
      (storedRowCount ?? 0) > 0 ||
      (documentStoredRowCount ?? 0) > 0 ||
      (rowCountByReportId ?? 0) > 0 ||
      (rowCountByReportDocumentId ?? 0) > 0

    return {
      success: true,
      jobId: job.id,
      reportId: job.report_id,
      reportType: job.report_type,
      reportDocumentId: job.report_document_id,
      jobProcessingStatus: job.processing_status,
      jobParsedRowCount: parsedRowCount,
      jobStoredRowCount: storedRowCount,
      documentProcessingStatus,
      documentStoredRowCount,
      rowCountByReportId,
      rowCountByReportDocumentId,
      brandAnalyticsRowsAppearStored,
      errorCode: null,
      errorMessage: null,
    }
  } catch {
    return {
      ...baseResult,
      errorCode: 'status_failed',
      errorMessage: toSafeErrorMessage('status_failed'),
    }
  }
}

export async function getBrandAnalyticsStatusDebug(
  input: StatusInput,
): Promise<BrandAnalyticsStatusDebugResult> {
  const baseResult = createDebugBaseResult(input.jobId)
  const envPresence = baseResult.envPresence

  if (!envPresence.hasSupabaseUrl || !envPresence.hasSupabaseServiceRoleKey) {
    return createDebugFailure(
      baseResult,
      'env_missing',
      'Brand Analytics debug failed: required Supabase environment is missing.',
    )
  }

  let supabase: ReturnType<typeof createSupabaseAdminClient>
  try {
    supabase = createSupabaseAdminClient()
  } catch {
    return createDebugFailure(
      baseResult,
      'create_supabase_client_failed',
      'Brand Analytics debug failed: could not create Supabase client.',
    )
  }

  let job: Awaited<ReturnType<typeof getBrandAnalyticsJob>>
  try {
    job = await getBrandAnalyticsJob(supabase, input.jobId)
  } catch {
    return createDebugFailure(
      baseResult,
      'read_job_failed',
      'Brand Analytics debug failed: job read failed.',
    )
  }

  if (!job) {
    return createDebugFailure(
      baseResult,
      'job_not_found',
      'Brand Analytics debug failed: job not found.',
    )
  }

  const jobSummary = job.raw_summary ?? {}
  const parsedRowCount = toNullableNumber(jobSummary.parsed_row_count)
  const storedRowCount = toNullableNumber(jobSummary.stored_row_count)
  const syncStatus = typeof jobSummary.sync_status === 'string' ? jobSummary.sync_status : null

  const jobScopedBase = {
    reportId: job.report_id,
    reportType: job.report_type,
    reportDocumentId: job.report_document_id,
    jobProcessingStatus: job.processing_status,
    jobParsedRowCount: parsedRowCount,
    jobStoredRowCount: storedRowCount,
    syncStatus,
    parsedRowCount,
    storedRowCount,
  }

  let documentProcessingStatus: string | null = null
  let documentStoredRowCount: number | null = null

  if (job.report_document_id) {
    const { data: docData, error: docError } = await supabase
      .from('amazon_report_documents')
      .select('processing_status, raw_summary')
      .eq('workspace_id', job.workspace_id)
      .eq('report_document_id', job.report_document_id)
      .maybeSingle()

    if (docError) {
      return createDebugFailure(
        baseResult,
        'read_document_failed',
        'Brand Analytics debug failed: document read failed.',
        {
          ...jobScopedBase,
        },
      )
    }

    if (docData) {
      documentProcessingStatus =
        typeof docData.processing_status === 'string'
          ? docData.processing_status
          : null
      const rawSummary =
        docData.raw_summary && typeof docData.raw_summary === 'object'
          ? (docData.raw_summary as Record<string, unknown>)
          : {}
      documentStoredRowCount = toNullableNumber(rawSummary.stored_row_count)
    }
  }

  let rowCountByReportId: number | null = null
  let reportIdCountSucceeded = false
  if (job.report_id) {
    const { count, error } = await supabase
      .from('brand_analytics_search_terms_rows')
      .select('*', { head: true, count: 'exact' })
      .eq('report_id', job.report_id)

    if (!error) {
      rowCountByReportId = count ?? 0
      reportIdCountSucceeded = true
    }
  }

  let rowCountByReportDocumentId: number | null = null
  let documentIdCountSucceeded = false
  if (job.report_document_id) {
    const { count, error } = await supabase
      .from('brand_analytics_search_terms_rows')
      .select('*', { head: true, count: 'exact' })
      .eq('report_document_id', job.report_document_id)

    if (error) {
      rowCountByReportDocumentId = null
    } else {
      rowCountByReportDocumentId = count ?? 0
      documentIdCountSucceeded = true
    }
  }

  const countSource =
    reportIdCountSucceeded || documentIdCountSucceeded
      ? 'exact'
      : (storedRowCount ?? documentStoredRowCount ?? parsedRowCount) !== null
        ? 'sync_summary'
        : 'unavailable'

  const brandAnalyticsRowsAppearStored =
    (storedRowCount ?? 0) > 0 ||
    (documentStoredRowCount ?? 0) > 0 ||
    (rowCountByReportId ?? 0) > 0 ||
    (rowCountByReportDocumentId ?? 0) > 0

  return {
    ...baseResult,
    success: true,
    failedStage: 'success',
    jobId: job.id,
    reportId: job.report_id,
    reportType: job.report_type,
    reportDocumentId: job.report_document_id,
    jobProcessingStatus: job.processing_status,
    jobParsedRowCount: parsedRowCount,
    jobStoredRowCount: storedRowCount,
    documentProcessingStatus,
    documentStoredRowCount,
    rowCountByReportId,
    rowCountByReportDocumentId,
    syncStatus,
    parsedRowCount,
    storedRowCount,
    countSource,
    brandAnalyticsRowsAppearStored,
    errorCode: null,
    errorMessage: null,
  }
}
