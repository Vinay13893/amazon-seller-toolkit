import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 20

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'

type LatestReportMeta = {
  report_id?: string | null
  report_document_id?: string | null
  report_type?: string | null
  processing_status?: string | null
  data_start_time?: string | null
  data_end_time?: string | null
  completed_at?: string | null
  raw_summary?: Record<string, unknown> | null
}

type SafeErrorStage =
  | 'auth'
  | 'workspace_resolution'
  | 'read_client'
  | 'latest_report_lookup'
  | 'latest_row_lookup'
  | 'rows_query'
  | 'unexpected'

type SafeDbError = {
  code?: string
  message?: string
  hint?: string
}

type SafeErrorDetails = {
  dbErrorCode?: string | null
  dbErrorMessage?: string | null
  dbErrorHint?: string | null
  queryMode?: 'latest_document_paginated'
  countMode?: 'summary_or_unavailable'
  selectedColumns?: string[]
  orderColumns?: string[]
  filtersApplied?: string[]
  workspaceResolved?: boolean
  workspaceIdPresent?: boolean
  pageSize?: number
}

const SEARCH_TERMS_COLUMNS = [
  'department_name',
  'search_term',
  'search_frequency_rank',
  'clicked_asin',
  'clicked_item_name',
  'click_share_rank',
  'click_share',
  'conversion_share',
  'report_id',
  'report_document_id',
  'marketplace_id',
  'data_start_time',
  'data_end_time',
]

function sanitizeDbText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.replace(/"[^"]+"/g, '"[redacted]"').slice(0, 180)
}

function safeDbDetails(error: SafeDbError | null | undefined): Pick<SafeErrorDetails, 'dbErrorCode' | 'dbErrorMessage' | 'dbErrorHint'> {
  return {
    dbErrorCode: typeof error?.code === 'string' ? error.code : null,
    dbErrorMessage: sanitizeDbText(error?.message),
    dbErrorHint: sanitizeDbText(error?.hint),
  }
}

function safeError(
  stage: SafeErrorStage,
  status: number,
  errorCode: string,
  message: string,
  details: SafeErrorDetails = {},
) {
  return NextResponse.json({ errorCode, stage, message, ...details }, { status })
}

function toPositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function toNullableInt(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeStatus(value: string | null): string | null {
  if (!value) return null
  return value.toLowerCase() === 'done' ? 'done' : value
}

function getSummaryNumber(summary: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = toNullableNumber(summary[key])
    if (value !== null) return value
  }
  return null
}

function getAppliedFilters(input: {
  reportId: string
  reportDocumentId: string
  searchTerm: string
  clickedAsin: string
  departmentName: string
  minRank: number | null
  maxRank: number | null
}): string[] {
  const filters = ['workspace_id']
  if (input.reportDocumentId) filters.push('report_document_id')
  else if (input.reportId) filters.push('report_id')
  if (input.searchTerm) filters.push('search_term')
  if (input.clickedAsin) filters.push('clicked_asin')
  if (input.departmentName) filters.push('department_name')
  if (input.minRank !== null) filters.push('min_search_frequency_rank')
  if (input.maxRank !== null) filters.push('max_search_frequency_rank')
  return filters
}

export async function GET(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return safeError('auth', 401, 'unauthorized', 'Unauthorized')
    }

    const { data: member, error: memberErr } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()

    if (memberErr || !member?.workspace_id) {
      return safeError(
        'workspace_resolution',
        404,
        'workspace_not_found',
        'No workspace found for authenticated user.',
      )
    }

    const url = new URL(req.url)
    const page = toPositiveInt(url.searchParams.get('page'), 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      toPositiveInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE),
    )
    const offset = (page - 1) * pageSize

    const searchTerm = url.searchParams.get('searchTerm')?.trim() ?? ''
    const clickedAsin = url.searchParams.get('clickedAsin')?.trim() ?? ''
    const departmentName = url.searchParams.get('departmentName')?.trim() ?? ''
    const reportId = url.searchParams.get('reportId')?.trim() ?? ''
    const reportDocumentId = url.searchParams.get('reportDocumentId')?.trim() ?? ''
    const minRank = toNullableInt(url.searchParams.get('minRank'))
    const maxRank = toNullableInt(url.searchParams.get('maxRank'))
    const workspaceId = member.workspace_id as string

    let readClient: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createAdminClient>
    try {
      readClient = createAdminClient()
    } catch {
      readClient = supabase
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: latestJobData, error: latestJobError } = await (readClient as any)
      .from('amazon_report_jobs')
      .select('report_id, report_document_id, report_type, processing_status, data_start_time, data_end_time, completed_at, raw_summary')
      .eq('workspace_id', workspaceId)
      .eq('report_type', SEARCH_TERMS_REPORT_TYPE)
      .order('completed_at', { ascending: false, nullsFirst: false })
      .order('requested_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    if (latestJobError) {
      return safeError(
        'latest_report_lookup',
        500,
        'latest_report_lookup_failed',
        'Brand Analytics API failed to read latest report metadata.',
        {
          ...safeDbDetails(latestJobError),
          workspaceResolved: true,
          workspaceIdPresent: Boolean(workspaceId),
        },
      )
    }

    const latestJob = (latestJobData ?? null) as LatestReportMeta | null
    const latestSummary = latestJob?.raw_summary && typeof latestJob.raw_summary === 'object'
      ? latestJob.raw_summary
      : {}

    let latestRowMeta: LatestReportMeta | null = null
    if (!latestJob?.report_document_id && !latestJob?.report_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: latestRow, error: latestRowError } = await (readClient as any)
        .from('brand_analytics_search_terms_rows')
        .select('report_id, report_document_id, marketplace_id, data_start_time, data_end_time')
        .eq('workspace_id', workspaceId)
        .order('data_end_time', { ascending: false, nullsFirst: false })
        .order('search_frequency_rank', { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle()

      if (latestRowError) {
        return safeError(
          'latest_row_lookup',
          500,
          'latest_row_lookup_failed',
          'Brand Analytics API failed to read latest stored row metadata.',
          {
            ...safeDbDetails(latestRowError),
            selectedColumns: ['report_id', 'report_document_id', 'marketplace_id', 'data_start_time', 'data_end_time'],
            orderColumns: ['data_end_time', 'search_frequency_rank'],
            filtersApplied: ['workspace_id'],
            workspaceResolved: true,
            workspaceIdPresent: Boolean(workspaceId),
          },
        )
      }

      if (latestRow) {
        latestRowMeta = {
          ...latestRow,
          report_type: SEARCH_TERMS_REPORT_TYPE,
          processing_status: null,
          completed_at: null,
          raw_summary: null,
        }
      }
    }

    const latestReport = latestJob ?? latestRowMeta
    const effectiveReportId = reportId || latestReport?.report_id || ''
    const effectiveReportDocumentId = reportDocumentId || latestReport?.report_document_id || ''
    const queryMode = 'latest_document_paginated' as const
    const countMode = 'summary_or_unavailable' as const

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (readClient as any)
      .from('brand_analytics_search_terms_rows')
      .select(SEARCH_TERMS_COLUMNS.join(', '))
      .eq('workspace_id', workspaceId)

    if (effectiveReportDocumentId) {
      query = query.eq('report_document_id', effectiveReportDocumentId)
    } else if (effectiveReportId) {
      query = query.eq('report_id', effectiveReportId)
    }

    if (searchTerm) query = query.ilike('search_term', `%${searchTerm}%`)
    if (clickedAsin) query = query.ilike('clicked_asin', `%${clickedAsin}%`)
    if (departmentName) query = query.ilike('department_name', `%${departmentName}%`)
    if (minRank !== null) query = query.gte('search_frequency_rank', minRank)
    if (maxRank !== null) query = query.lte('search_frequency_rank', maxRank)

    const { data, error } = await query
      .order('search_frequency_rank', { ascending: true, nullsFirst: false })
      .order('click_share_rank', { ascending: true, nullsFirst: false })
      .range(offset, offset + pageSize)

    if (error) {
      return safeError(
        'rows_query',
        500,
        'rows_query_failed',
        'Brand Analytics API failed to load paginated Search Terms rows.',
        {
          ...safeDbDetails(error),
          queryMode,
          countMode,
          selectedColumns: SEARCH_TERMS_COLUMNS,
          orderColumns: ['search_frequency_rank', 'click_share_rank'],
          filtersApplied: getAppliedFilters({
            reportId: effectiveReportId,
            reportDocumentId: effectiveReportDocumentId,
            searchTerm,
            clickedAsin,
            departmentName,
            minRank,
            maxRank,
          }),
          workspaceResolved: true,
          workspaceIdPresent: Boolean(workspaceId),
          pageSize,
        },
      )
    }

    const rows = Array.isArray(data) ? data.slice(0, pageSize) : []
    const hasMore = Array.isArray(data) && data.length > pageSize
    const parsedRowCount = getSummaryNumber(latestSummary, 'parsed_row_count', 'parsedRowCount')
    let storedRowCount = getSummaryNumber(
      latestSummary,
      'stored_row_count',
      'cumulative_stored_row_count',
      'storedRowCount',
      'cumulativeStoredRowCount',
    )
    const countSource: 'sync_summary' | 'unavailable' =
      storedRowCount !== null ? 'sync_summary' : 'unavailable'

    const latestStatus = normalizeStatus(
      toNullableString(latestSummary.sync_status)
        ?? toNullableString(latestJob?.processing_status)
        ?? (storedRowCount && storedRowCount > 0 ? 'done' : null),
    )

    return NextResponse.json({
      page,
      pageSize,
      hasMore,
      rowsReturned: rows.length,
      rows,
      meta: {
        latestReportId: toNullableString(latestReport?.report_id),
        latestReportDocumentId: toNullableString(latestReport?.report_document_id),
        reportType: toNullableString(latestReport?.report_type) ?? SEARCH_TERMS_REPORT_TYPE,
        processingStatus: normalizeStatus(toNullableString(latestJob?.processing_status)),
        latestStatus,
        dataStartTime: toNullableString(latestReport?.data_start_time),
        dataEndTime: toNullableString(latestReport?.data_end_time),
        reportPeriod: toNullableString(latestReport?.data_start_time) || toNullableString(latestReport?.data_end_time)
          ? {
              start: toNullableString(latestReport?.data_start_time),
              end: toNullableString(latestReport?.data_end_time),
            }
          : null,
        completedAt: toNullableString(latestReport?.completed_at),
        storedRowCount,
        parsedRowCount,
        countSource,
        countMode,
      },
    })
  } catch {
    return safeError(
      'unexpected',
      500,
      'unexpected_error',
      'Brand Analytics search terms failed unexpectedly.',
    )
  }
}
