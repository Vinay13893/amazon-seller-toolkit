import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 20

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'

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

export async function GET(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: member, error: memberErr } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()

    if (memberErr || !member?.workspace_id) {
      return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
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

    const admin = createAdminClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: latestJob } = await (admin as any)
      .from('amazon_report_jobs')
      .select('report_id, report_document_id, report_type, processing_status, data_start_time, data_end_time, completed_at, raw_summary')
      .eq('workspace_id', member.workspace_id)
      .eq('report_type', SEARCH_TERMS_REPORT_TYPE)
      .order('completed_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const latestSummary = latestJob?.raw_summary && typeof latestJob.raw_summary === 'object'
      ? latestJob.raw_summary as Record<string, unknown>
      : {}

    const effectiveReportId = reportId || latestJob?.report_id || ''
    const effectiveReportDocumentId = reportDocumentId || latestJob?.report_document_id || ''

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (admin as any)
      .from('brand_analytics_search_terms_rows')
      .select([
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
      ].join(', '))
      .eq('workspace_id', member.workspace_id)

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
      return NextResponse.json({ error: 'Failed to load Brand Analytics rows' }, { status: 500 })
    }

    const rows = Array.isArray(data) ? data.slice(0, pageSize) : []
    const hasMore = Array.isArray(data) && data.length > pageSize
    const storedRowCount = toNullableNumber(latestSummary.stored_row_count)
      ?? toNullableNumber(latestSummary.cumulative_stored_row_count)
    const parsedRowCount = toNullableNumber(latestSummary.parsed_row_count)

    return NextResponse.json({
      page,
      pageSize,
      hasMore,
      rows,
      meta: {
        latestReportId: toNullableString(latestJob?.report_id),
        latestReportDocumentId: toNullableString(latestJob?.report_document_id),
        reportType: toNullableString(latestJob?.report_type),
        processingStatus: toNullableString(latestJob?.processing_status),
        dataStartTime: toNullableString(latestJob?.data_start_time),
        dataEndTime: toNullableString(latestJob?.data_end_time),
        completedAt: toNullableString(latestJob?.completed_at),
        storedRowCount,
        parsedRowCount,
      },
    })
  } catch {
    return NextResponse.json({ error: 'Brand Analytics search terms failed unexpectedly' }, { status: 500 })
  }
}
