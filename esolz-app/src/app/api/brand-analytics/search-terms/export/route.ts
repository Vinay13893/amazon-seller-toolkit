import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 25

const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'
const EXPORT_GROUP_LIMIT = 5000

type OpportunityFilter =
  | 'all'
  | 'high-demand'
  | 'conversion-gap'
  | 'click-share-opportunity'
  | 'winning-term'
  | 'competitor-asin'

type ExportSourceRow = {
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

function toNullableInt(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeSearchInput(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function toCsv(rows: ExportSourceRow[]): string {
  const header = [
    'search_term',
    'search_frequency_rank',
    'department',
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
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push([
      row.search_term,
      row.search_frequency_rank,
      row.department_name,
      row.product_1_asin,
      row.product_1_title,
      row.product_1_click_share,
      row.product_1_conversion_share,
      row.product_2_asin,
      row.product_2_title,
      row.product_2_click_share,
      row.product_2_conversion_share,
      row.product_3_asin,
      row.product_3_title,
      row.product_3_click_share,
      row.product_3_conversion_share,
      row.opportunity_tag,
      row.suggested_action,
    ].map(csvCell).join(','))
  }
  return lines.join('\n')
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ errorCode: 'unauthorized', stage: 'auth', message: 'Unauthorized' }, { status: 401 })
  }

  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (memberErr || !member?.workspace_id) {
    return NextResponse.json({ errorCode: 'workspace_not_found', stage: 'workspace_resolution', message: 'No workspace found.' }, { status: 404 })
  }

  const url = new URL(req.url)
  const searchTerm = normalizeSearchInput(url.searchParams.get('searchTerm') ?? '')
  const clickedAsin = normalizeSearchInput(url.searchParams.get('clickedAsin') ?? '').toUpperCase()
  const departmentName = url.searchParams.get('departmentName')?.trim() ?? ''
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
  const { data: latestJob } = await (readClient as any)
    .from('amazon_report_jobs')
    .select('report_document_id, report_id')
    .eq('workspace_id', workspaceId)
    .eq('report_type', SEARCH_TERMS_REPORT_TYPE)
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('requested_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  let query = readClient
    .from('brand_analytics_search_terms_grouped_rows')
    .select('department_name, search_term, search_frequency_rank, product_1_asin, product_1_title, product_1_click_share, product_1_conversion_share, product_2_asin, product_2_title, product_2_click_share, product_2_conversion_share, product_3_asin, product_3_title, product_3_click_share, product_3_conversion_share, opportunity_tag, suggested_action')
    .eq('workspace_id', workspaceId)

  if (latestJob?.report_document_id) query = query.eq('report_document_id', latestJob.report_document_id)
  else if (latestJob?.report_id) query = query.eq('report_id', latestJob.report_id)
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
    .limit(EXPORT_GROUP_LIMIT)

  if (error) {
    return NextResponse.json({ errorCode: 'export_query_failed', stage: 'export_query', message: 'Export failed safely.' }, { status: 500 })
  }

  const csv = toCsv(Array.isArray(data) ? data as ExportSourceRow[] : [])

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="brand-analytics-search-terms.csv"',
    },
  })
}
