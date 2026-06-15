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