import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 20

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'
const WINNING_CLICK_SHARE_PERCENT = 35
const WINNING_CONVERSION_SHARE_PERCENT = 8
const OPPORTUNITY_CLICK_SHARE_PERCENT = 15
const LOW_CONVERSION_SHARE_PERCENT = 4
const SEARCH_CANDIDATE_LIMIT = 250

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

type OpportunityFilter =
  | 'all'
  | 'high-demand'
  | 'conversion-gap'
  | 'click-share-opportunity'
  | 'winning-term'
  | 'competitor-asin'

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
  queryMode?: 'latest_document_paginated' | 'candidate_first_search'
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

type SearchTermSourceRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
  clicked_asin: string | null
  clicked_item_name: string | null
  click_share_rank: number | null
  click_share: number | null
  conversion_share: number | null
  report_id: string | null
  report_document_id: string | null
  marketplace_id: string | null
  data_start_time: string | null
  data_end_time: string | null
}

type SearchTermCandidateRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
}

type TopClickedProduct = {
  rank: number | null
  asin: string | null
  itemName: string | null
  clickShare: number | null
  conversionShare: number | null
}

type GroupedSearchTermRow = {
  departmentName: string | null
  searchTerm: string | null
  searchFrequencyRank: number | null
  reportId: string | null
  reportDocumentId: string | null
  marketplaceId: string | null
  dataStartTime: string | null
  dataEndTime: string | null
  topClickedProducts: TopClickedProduct[]
  topClickedAsin: string | null
  topClickShare: number | null
  topConversionShare: number | null
  opportunityTag: 'Winning term' | 'Conversion gap' | 'Click share opportunity' | 'Monitor'
  suggestedAction: string
}

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

function normalizeSearchInput(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function normalizeSharePercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.abs(value) <= 1 ? value * 100 : value
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
  opportunity: OpportunityFilter
}): string[] {
  const filters = ['workspace_id']
  if (input.reportDocumentId) filters.push('report_document_id')
  else if (input.reportId) filters.push('report_id')
  if (input.searchTerm) filters.push('search_term')
  if (input.clickedAsin) filters.push('clicked_asin')
  if (input.departmentName) filters.push('department_name')
  if (input.minRank !== null) filters.push('min_search_frequency_rank')
  if (input.maxRank !== null) filters.push('max_search_frequency_rank')
  if (input.opportunity !== 'all') filters.push('opportunity')
  return filters
}

function getOpportunity(row: SearchTermSourceRow): Pick<GroupedSearchTermRow, 'opportunityTag' | 'suggestedAction'> {
  const rank = row.search_frequency_rank ?? Number.MAX_SAFE_INTEGER
  const clickShare = normalizeSharePercent(row.click_share)
  const conversionShare = normalizeSharePercent(row.conversion_share)

  if (rank <= 5000 && clickShare >= WINNING_CLICK_SHARE_PERCENT && conversionShare >= WINNING_CONVERSION_SHARE_PERCENT) {
    return {
      opportunityTag: 'Winning term',
      suggestedAction: 'Protect winning term',
    }
  }

  if (rank <= 25000 && clickShare >= OPPORTUNITY_CLICK_SHARE_PERCENT && conversionShare < LOW_CONVERSION_SHARE_PERCENT) {
    return {
      opportunityTag: 'Conversion gap',
      suggestedAction: 'Improve image/title/price/reviews',
    }
  }

  if (rank <= 25000 && clickShare < OPPORTUNITY_CLICK_SHARE_PERCENT) {
    return {
      opportunityTag: 'Click share opportunity',
      suggestedAction: 'Add to exact-match campaign',
    }
  }

  return {
    opportunityTag: 'Monitor',
    suggestedAction: 'Monitor next report',
  }
}

function groupSearchTerms(rows: SearchTermSourceRow[], pageSize: number): GroupedSearchTermRow[] {
  const groups = new Map<string, GroupedSearchTermRow>()

  for (const row of rows) {
    const key = [
      row.report_document_id ?? '',
      row.department_name ?? '',
      row.search_term ?? '',
      row.search_frequency_rank ?? '',
    ].join('|')

    let group = groups.get(key)
    if (!group) {
      const opportunity = getOpportunity(row)
      group = {
        departmentName: row.department_name,
        searchTerm: row.search_term,
        searchFrequencyRank: row.search_frequency_rank,
        reportId: row.report_id,
        reportDocumentId: row.report_document_id,
        marketplaceId: row.marketplace_id,
        dataStartTime: row.data_start_time,
        dataEndTime: row.data_end_time,
        topClickedProducts: [],
        topClickedAsin: row.clicked_asin,
        topClickShare: row.click_share,
        topConversionShare: row.conversion_share,
        ...opportunity,
      }
      groups.set(key, group)
    }

    if (group.topClickedProducts.length < 3) {
      group.topClickedProducts.push({
        rank: row.click_share_rank,
        asin: row.clicked_asin,
        itemName: row.clicked_item_name,
        clickShare: row.click_share,
        conversionShare: row.conversion_share,
      })
    }

    if (groups.size >= pageSize && group.topClickedProducts.length >= 3) {
      continue
    }
  }

  return Array.from(groups.values()).slice(0, pageSize)
}

function candidateKey(row: SearchTermCandidateRow): string {
  return [
    row.department_name ?? '',
    row.search_term ?? '',
    row.search_frequency_rank ?? '',
  ].join('|')
}

function uniqueCandidates(rows: SearchTermCandidateRow[]): SearchTermCandidateRow[] {
  const seen = new Set<string>()
  const candidates: SearchTermCandidateRow[] = []
  for (const row of rows) {
    if (!row.search_term) continue
    const key = candidateKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(row)
  }
  return candidates
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)))
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))))
}

function matchesOpportunity(row: GroupedSearchTermRow, opportunity: OpportunityFilter): boolean {
  if (opportunity === 'all') return true
  if (opportunity === 'high-demand') return (row.searchFrequencyRank ?? Number.MAX_SAFE_INTEGER) <= 10000
  if (opportunity === 'conversion-gap') return row.opportunityTag === 'Conversion gap'
  if (opportunity === 'click-share-opportunity') return row.opportunityTag === 'Click share opportunity'
  if (opportunity === 'winning-term') return row.opportunityTag === 'Winning term'
  return row.topClickedProducts.some(product => Boolean(product.asin))
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
    const sourceRowsPerTerm = 3
    const sourcePageSize = pageSize * sourceRowsPerTerm
    const offset = (page - 1) * sourcePageSize
    const candidateOffset = (page - 1) * pageSize

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
    const queryMode = searchTerm ? 'candidate_first_search' as const : 'latest_document_paginated' as const
    const countMode = 'summary_or_unavailable' as const

    let sourceRows: SearchTermSourceRow[] = []
    let hasMore = false

    if (searchTerm) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let candidateQuery = (readClient as any)
        .from('brand_analytics_search_terms_rows')
        .select('department_name, search_term, search_frequency_rank')
        .eq('workspace_id', workspaceId)
        .ilike('search_term', `%${searchTerm}%`)

      if (effectiveReportDocumentId) {
        candidateQuery = candidateQuery.eq('report_document_id', effectiveReportDocumentId)
      } else if (effectiveReportId) {
        candidateQuery = candidateQuery.eq('report_id', effectiveReportId)
      }

      if (clickedAsin) candidateQuery = candidateQuery.eq('clicked_asin', clickedAsin)
      if (departmentName) candidateQuery = candidateQuery.eq('department_name', departmentName)
      if (minRank !== null) candidateQuery = candidateQuery.gte('search_frequency_rank', minRank)
      if (maxRank !== null) candidateQuery = candidateQuery.lte('search_frequency_rank', maxRank)
      if (opportunity === 'high-demand') candidateQuery = candidateQuery.lte('search_frequency_rank', 10000)

      const { data: candidateData, error: candidateError } = await candidateQuery
        .order('search_frequency_rank', { ascending: true, nullsFirst: false })
        .limit(SEARCH_CANDIDATE_LIMIT)

      if (candidateError) {
        return safeError(
          'rows_query',
          500,
          'rows_query_failed',
          'Brand Analytics API failed to load Search Terms candidates.',
          {
            ...safeDbDetails(candidateError),
            queryMode,
            countMode,
            selectedColumns: ['department_name', 'search_term', 'search_frequency_rank'],
            orderColumns: ['search_frequency_rank'],
            filtersApplied: getAppliedFilters({
              reportId: effectiveReportId,
              reportDocumentId: effectiveReportDocumentId,
              searchTerm,
              clickedAsin,
              departmentName,
              minRank,
              maxRank,
              opportunity,
            }),
            workspaceResolved: true,
            workspaceIdPresent: Boolean(workspaceId),
            pageSize,
          },
        )
      }

      const candidates = uniqueCandidates(Array.isArray(candidateData) ? candidateData as SearchTermCandidateRow[] : [])
      const pageCandidates = candidates.slice(candidateOffset, candidateOffset + pageSize)
      hasMore = candidates.length > candidateOffset + pageSize

      if (pageCandidates.length > 0) {
        const candidateKeys = new Set(pageCandidates.map(candidateKey))
        const searchTerms = uniqueStrings(pageCandidates.map(row => row.search_term))
        const ranks = uniqueNumbers(pageCandidates.map(row => row.search_frequency_rank))
        const departments = uniqueStrings(pageCandidates.map(row => row.department_name))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let detailQuery = (readClient as any)
          .from('brand_analytics_search_terms_rows')
          .select(SEARCH_TERMS_COLUMNS.join(', '))
          .eq('workspace_id', workspaceId)
          .in('search_term', searchTerms)
          .lte('click_share_rank', 3)

        if (effectiveReportDocumentId) {
          detailQuery = detailQuery.eq('report_document_id', effectiveReportDocumentId)
        } else if (effectiveReportId) {
          detailQuery = detailQuery.eq('report_id', effectiveReportId)
        }

        if (ranks.length > 0) detailQuery = detailQuery.in('search_frequency_rank', ranks)
        if (departments.length > 0) detailQuery = detailQuery.in('department_name', departments)
        if (clickedAsin) detailQuery = detailQuery.eq('clicked_asin', clickedAsin)

        const { data: detailData, error: detailError } = await detailQuery
          .order('search_frequency_rank', { ascending: true, nullsFirst: false })
          .order('click_share_rank', { ascending: true, nullsFirst: false })
          .limit(pageCandidates.length * sourceRowsPerTerm)

        if (detailError) {
          return safeError(
            'rows_query',
            500,
            'rows_query_failed',
            'Brand Analytics API failed to load matching Search Terms rows.',
            {
              ...safeDbDetails(detailError),
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
                opportunity,
              }),
              workspaceResolved: true,
              workspaceIdPresent: Boolean(workspaceId),
              pageSize,
            },
          )
        }

        sourceRows = (Array.isArray(detailData) ? detailData as SearchTermSourceRow[] : [])
          .filter(row => candidateKeys.has(candidateKey(row)))
      }
    } else {
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

      if (clickedAsin) query = query.eq('clicked_asin', clickedAsin)
      if (departmentName) query = query.eq('department_name', departmentName)
      if (minRank !== null) query = query.gte('search_frequency_rank', minRank)
      if (maxRank !== null) query = query.lte('search_frequency_rank', maxRank)
      if (opportunity === 'high-demand') query = query.lte('search_frequency_rank', 10000)
      if (opportunity === 'winning-term') {
        query = query
          .lte('search_frequency_rank', 5000)
          .gte('click_share', WINNING_CLICK_SHARE_PERCENT)
          .gte('conversion_share', WINNING_CONVERSION_SHARE_PERCENT)
      }
      if (opportunity === 'conversion-gap') {
        query = query
          .lte('search_frequency_rank', 25000)
          .gte('click_share', OPPORTUNITY_CLICK_SHARE_PERCENT)
          .lt('conversion_share', LOW_CONVERSION_SHARE_PERCENT)
      }
      if (opportunity === 'click-share-opportunity') {
        query = query
          .lte('search_frequency_rank', 25000)
          .lt('click_share', OPPORTUNITY_CLICK_SHARE_PERCENT)
      }
      query = query.lte('click_share_rank', 3)

      const { data, error } = await query
        .order('search_frequency_rank', { ascending: true, nullsFirst: false })
        .order('click_share_rank', { ascending: true, nullsFirst: false })
        .range(offset, offset + sourcePageSize)

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
              opportunity,
            }),
            workspaceResolved: true,
            workspaceIdPresent: Boolean(workspaceId),
            pageSize,
          },
        )
      }

      sourceRows = Array.isArray(data) ? data as SearchTermSourceRow[] : []
      hasMore = sourceRows.length > sourcePageSize
    }

    const rows = groupSearchTerms(sourceRows, pageSize * 2)
      .filter(row => matchesOpportunity(row, opportunity))
      .slice(0, pageSize)
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

    let departments: string[] = []
    if (effectiveReportDocumentId || effectiveReportId) {
      let departmentQuery = readClient
        .from('brand_analytics_search_terms_rows')
        .select('department_name')
        .eq('workspace_id', workspaceId)
        .neq('department_name', '')
        .order('department_name', { ascending: true })
        .limit(1000)

      if (effectiveReportDocumentId) {
        departmentQuery = departmentQuery.eq('report_document_id', effectiveReportDocumentId)
      } else {
        departmentQuery = departmentQuery.eq('report_id', effectiveReportId)
      }

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
      hasMore,
      rowsReturned: rows.length,
      rows,
      viewMode: 'grouped_top_search_terms',
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
    return safeError(
      'unexpected',
      500,
      'unexpected_error',
      'Brand Analytics search terms failed unexpectedly.',
    )
  }
}
