import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 20

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'

const GROUPED_COLUMNS = [
  'department_name',
  'search_term',
  'search_frequency_rank',
  'product_1_asin',
  'product_1_title',
  'product_1_click_share',
  'product_1_conversion_share',
  'product_2_asin',
  'product_2_title',
  'product_2_click_share',
  'product_2_conversion_share',
  'product_3_asin',
  'product_3_title',
  'product_3_click_share',
  'product_3_conversion_share',
  'opportunity_tag',
  'suggested_action',
  'report_id',
  'report_document_id',
  'marketplace_id',
  'report_period',
  'data_start_time',
  'data_end_time',
]

type OpportunityFilter =
  | 'all'
  | 'high-demand'
  | 'conversion-gap'
  | 'click-share-opportunity'
  | 'winning-term'
  | 'competitor-asin'

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

type GroupedTableRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
  product_1_asin: string | null
  product_1_title: string | null
  product_1_click_share: number | null
  product_1_conversion_share: number | null
  product_2_asin: string | null
  product_2_title: string | null
  product_2_click_share: number | null
  product_2_conversion_share: number | null
  product_3_asin: string | null
  product_3_title: string | null
  product_3_click_share: number | null
  product_3_conversion_share: number | null
  opportunity_tag: string | null
  suggested_action: string | null
  report_id: string | null
  report_document_id: string | null
  marketplace_id: string | null
  report_period: string | null
  data_start_time: string | null
  data_end_time: string | null
}

type SafeDbError = {
  code?: string
  message?: string
  hint?: string
}

function sanitizeDbText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.replace(/"[^"]+"/g, '"[redacted]"').slice(0, 180)
}

function safeDbDetails(error: SafeDbError | null | undefined) {
  return {
    dbErrorCode: typeof error?.code === 'string' ? error.code : null,
    dbErrorMessage: sanitizeDbText(error?.message),
    dbErrorHint: sanitizeDbText(error?.hint),
  }
}

function safeError(status: number, errorCode: string, stage: string, message: string, details: Record<string, unknown> = {}) {
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

function normalizeSearchInput(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function normalizeOpportunity(value: string | null): OpportunityFilter {
  if (
    value === 'high-demand' ||
    value === 'conversion-gap' ||
    value === 'click-share-opportunity' ||
    value === 'winning-term' ||
    value === 'competitor-asin'
  ) {
    return value
  }
  return 'all'
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

function mapGroupedRow(row: GroupedTableRow) {
  const topClickedProducts = [
    {
      rank: 1,
      asin: row.product_1_asin,
      itemName: row.product_1_title,
      clickShare: row.product_1_click_share,
      conversionShare: row.product_1_conversion_share,
    },
    {
      rank: 2,
      asin: row.product_2_asin,
      itemName: row.product_2_title,
      clickShare: row.product_2_click_share,
      conversionShare: row.product_2_conversion_share,
    },
    {
      rank: 3,
      asin: row.product_3_asin,
      itemName: row.product_3_title,
      clickShare: row.product_3_click_share,
      conversionShare: row.product_3_conversion_share,
    },
  ].filter(product => product.asin || product.itemName)

  return {
    departmentName: row.department_name,
    searchTerm: row.search_term,
    searchFrequencyRank: row.search_frequency_rank,
    reportId: row.report_id,
    reportDocumentId: row.report_document_id,
    marketplaceId: row.marketplace_id,
    dataStartTime: row.data_start_time,
    dataEndTime: row.data_end_time,
    topClickedProducts,
    topClickedAsin: row.product_1_asin,
    topClickShare: row.product_1_click_share,
    topConversionShare: row.product_1_conversion_share,
    opportunityTag: row.opportunity_tag || 'Monitor',
    suggestedAction: row.suggested_action || 'Monitor next report',
  }
}

export async function GET(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return safeError(401, 'unauthorized', 'auth', 'Unauthorized')

    const { data: member, error: memberErr } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()

    if (memberErr || !member?.workspace_id) {
      return safeError(404, 'workspace_not_found', 'workspace_resolution', 'No workspace found for authenticated user.')
    }

    const url = new URL(req.url)
    const page = toPositiveInt(url.searchParams.get('page'), 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, toPositiveInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE))
    const offset = (page - 1) * pageSize
    const searchTerm = normalizeSearchInput(url.searchParams.get('searchTerm') ?? '')
    const clickedAsin = normalizeSearchInput(url.searchParams.get('clickedAsin') ?? '').toUpperCase()
    const departmentName = url.searchParams.get('departmentName')?.trim() ?? ''
    const reportId = url.searchParams.get('reportId')?.trim() ?? ''
    const reportDocumentId = url.searchParams.get('reportDocumentId')?.trim() ?? ''
    const minRank = toNullableInt(url.searchParams.get('minRank'))
    const maxRank = toNullableInt(url.searchParams.get('maxRank'))
    const opportunity = normalizeOpportunity(url.searchParams.get('opportunity'))
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
      return safeError(500, 'latest_report_lookup_failed', 'latest_report_lookup', 'Brand Analytics API failed to read latest report metadata.', {
        ...safeDbDetails(latestJobError),
      })
    }

    const latestJob = (latestJobData ?? null) as LatestReportMeta | null
    const latestSummary = latestJob?.raw_summary && typeof latestJob.raw_summary === 'object' ? latestJob.raw_summary : {}
    const effectiveReportId = reportId || latestJob?.report_id || ''
    const effectiveReportDocumentId = reportDocumentId || latestJob?.report_document_id || ''

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (readClient as any)
      .from('brand_analytics_search_terms_grouped_rows')
      .select(GROUPED_COLUMNS.join(', '))
      .eq('workspace_id', workspaceId)

    if (effectiveReportDocumentId) query = query.eq('report_document_id', effectiveReportDocumentId)
    else if (effectiveReportId) query = query.eq('report_id', effectiveReportId)
    if (searchTerm) query = query.ilike('search_term', `%${searchTerm}%`)
    if (clickedAsin) query = query.or(`product_1_asin.eq.${clickedAsin},product_2_asin.eq.${clickedAsin},product_3_asin.eq.${clickedAsin}`)
    if (departmentName) query = query.eq('department_name', departmentName)
    if (minRank !== null) query = query.gte('search_frequency_rank', minRank)
    if (maxRank !== null) query = query.lte('search_frequency_rank', maxRank)
    if (opportunity === 'high-demand') query = query.lte('search_frequency_rank', 10000)
    if (opportunity === 'conversion-gap') query = query.eq('opportunity_tag', 'Conversion gap')
    if (opportunity === 'click-share-opportunity') query = query.eq('opportunity_tag', 'Click share opportunity')
    if (opportunity === 'winning-term') query = query.eq('opportunity_tag', 'Winning term')
    if (opportunity === 'competitor-asin') query = query.not('product_1_asin', 'is', null)

    const { data, error } = await query
      .order('search_frequency_rank', { ascending: true, nullsFirst: false })
      .range(offset, offset + pageSize)

    if (error) {
      return safeError(500, 'rows_query_failed', 'rows_query', 'Brand Analytics API failed to load grouped Search Terms rows.', {
        ...safeDbDetails(error),
        queryMode: 'grouped_summary_paginated',
        countMode: 'summary_or_unavailable',
        selectedColumns: GROUPED_COLUMNS,
        orderColumns: ['search_frequency_rank'],
        pageSize,
      })
    }

    const sourceRows = Array.isArray(data) ? data as GroupedTableRow[] : []
    const pageRows = sourceRows.slice(0, pageSize)
    const rows = pageRows.map(mapGroupedRow)
    const parsedRowCount = getSummaryNumber(latestSummary, 'parsed_row_count', 'parsedRowCount')
    const storedRowCount = getSummaryNumber(
      latestSummary,
      'stored_row_count',
      'cumulative_stored_row_count',
      'storedRowCount',
      'cumulativeStoredRowCount',
    )
    const latestStatus = normalizeStatus(
      toNullableString(latestSummary.sync_status)
        ?? toNullableString(latestJob?.processing_status)
        ?? (storedRowCount && storedRowCount > 0 ? 'done' : null),
    )

    let departments: string[] = []
    if (effectiveReportDocumentId || effectiveReportId) {
      let departmentQuery = readClient
        .from('brand_analytics_search_terms_grouped_rows')
        .select('department_name')
        .eq('workspace_id', workspaceId)
        .neq('department_name', '')
        .order('department_name', { ascending: true })
        .limit(1000)

      if (effectiveReportDocumentId) departmentQuery = departmentQuery.eq('report_document_id', effectiveReportDocumentId)
      else departmentQuery = departmentQuery.eq('report_id', effectiveReportId)

      const { data: departmentRows } = await departmentQuery
      departments = Array.from(new Set(
        (Array.isArray(departmentRows) ? departmentRows : [])
          .map(row => typeof row.department_name === 'string' ? row.department_name.trim() : '')
          .filter(Boolean),
      )).slice(0, 100)
    }

    return NextResponse.json({
      page,
      pageSize,
      hasMore: sourceRows.length > pageSize,
      rowsReturned: rows.length,
      rows,
      viewMode: 'grouped_top_search_terms',
      meta: {
        latestReportId: toNullableString(latestJob?.report_id),
        latestReportDocumentId: toNullableString(latestJob?.report_document_id),
        reportType: toNullableString(latestJob?.report_type) ?? SEARCH_TERMS_REPORT_TYPE,
        processingStatus: normalizeStatus(toNullableString(latestJob?.processing_status)),
        latestStatus,
        dataStartTime: toNullableString(latestJob?.data_start_time),
        dataEndTime: toNullableString(latestJob?.data_end_time),
        reportPeriod: toNullableString(latestJob?.data_start_time) || toNullableString(latestJob?.data_end_time)
          ? {
              start: toNullableString(latestJob?.data_start_time),
              end: toNullableString(latestJob?.data_end_time),
            }
          : null,
        completedAt: toNullableString(latestJob?.completed_at),
        storedRowCount,
        parsedRowCount,
        countSource: storedRowCount !== null ? 'sync_summary' : 'unavailable',
        countMode: 'summary_or_unavailable',
        departments,
        fieldCompleteness: {
          impressions: false,
          clicks: false,
          purchases: false,
          cartAdds: false,
        },
      },
    })
  } catch {
    return safeError(500, 'unexpected_error', 'unexpected', 'Brand Analytics search terms failed unexpectedly.')
  }
}
