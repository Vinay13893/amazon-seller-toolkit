import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 25

const SEARCH_TERMS_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT'
const EXPORT_GROUP_LIMIT = 5000
const EXPORT_SOURCE_LIMIT = EXPORT_GROUP_LIMIT * 3
const EXPORT_CANDIDATE_LIMIT = 5000
const WINNING_CLICK_SHARE_PERCENT = 35
const WINNING_CONVERSION_SHARE_PERCENT = 8
const OPPORTUNITY_CLICK_SHARE_PERCENT = 15
const LOW_CONVERSION_SHARE_PERCENT = 4

type OpportunityFilter =
  | 'all'
  | 'high-demand'
  | 'conversion-gap'
  | 'click-share-opportunity'
  | 'winning-term'
  | 'competitor-asin'

type SourceRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
  clicked_asin: string | null
  clicked_item_name: string | null
  click_share_rank: number | null
  click_share: number | null
  conversion_share: number | null
}

type CandidateRow = {
  department_name: string | null
  search_term: string | null
  search_frequency_rank: number | null
}

type Product = {
  asin: string | null
  title: string | null
  clickShare: number | null
  conversionShare: number | null
}

type ExportRow = {
  searchTerm: string | null
  rank: number | null
  department: string | null
  products: Product[]
  opportunityTag: string
  suggestedAction: string
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

function normalizeSharePercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.abs(value) <= 1 ? value * 100 : value
}

function getOpportunity(row: SourceRow): Pick<ExportRow, 'opportunityTag' | 'suggestedAction'> {
  const rank = row.search_frequency_rank ?? Number.MAX_SAFE_INTEGER
  const clickShare = normalizeSharePercent(row.click_share)
  const conversionShare = normalizeSharePercent(row.conversion_share)

  if (rank <= 5000 && clickShare >= WINNING_CLICK_SHARE_PERCENT && conversionShare >= WINNING_CONVERSION_SHARE_PERCENT) {
    return { opportunityTag: 'Winning term', suggestedAction: 'Protect winning term' }
  }
  if (rank <= 25000 && clickShare >= OPPORTUNITY_CLICK_SHARE_PERCENT && conversionShare < LOW_CONVERSION_SHARE_PERCENT) {
    return { opportunityTag: 'Conversion gap', suggestedAction: 'Improve image/title/price/reviews' }
  }
  if (rank <= 25000 && clickShare < OPPORTUNITY_CLICK_SHARE_PERCENT) {
    return { opportunityTag: 'Click share opportunity', suggestedAction: 'Add to exact-match campaign' }
  }
  return { opportunityTag: 'Monitor', suggestedAction: 'Monitor next report' }
}

function groupRows(rows: SourceRow[]): ExportRow[] {
  const groups = new Map<string, ExportRow>()
  for (const row of rows) {
    const key = [row.department_name ?? '', row.search_term ?? '', row.search_frequency_rank ?? ''].join('|')
    let group = groups.get(key)
    if (!group) {
      group = {
        searchTerm: row.search_term,
        rank: row.search_frequency_rank,
        department: row.department_name,
        products: [],
        ...getOpportunity(row),
      }
      groups.set(key, group)
    }
    if (group.products.length < 3) {
      group.products.push({
        asin: row.clicked_asin,
        title: row.clicked_item_name,
        clickShare: row.click_share,
        conversionShare: row.conversion_share,
      })
    }
  }
  return Array.from(groups.values()).slice(0, EXPORT_GROUP_LIMIT)
}

function candidateKey(row: CandidateRow): string {
  return [
    row.department_name ?? '',
    row.search_term ?? '',
    row.search_frequency_rank ?? '',
  ].join('|')
}

function uniqueCandidates(rows: CandidateRow[]): CandidateRow[] {
  const seen = new Set<string>()
  const candidates: CandidateRow[] = []
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

function matchesOpportunity(row: ExportRow, opportunity: OpportunityFilter): boolean {
  if (opportunity === 'all') return true
  if (opportunity === 'high-demand') return (row.rank ?? Number.MAX_SAFE_INTEGER) <= 10000
  if (opportunity === 'conversion-gap') return row.opportunityTag === 'Conversion gap'
  if (opportunity === 'click-share-opportunity') return row.opportunityTag === 'Click share opportunity'
  if (opportunity === 'winning-term') return row.opportunityTag === 'Winning term'
  return row.products.some(product => Boolean(product.asin))
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function toCsv(rows: ExportRow[]): string {
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
    const products = [0, 1, 2].flatMap(index => {
      const product = row.products[index]
      return [
        product?.asin ?? '',
        product?.title ?? '',
        product?.clickShare ?? '',
        product?.conversionShare ?? '',
      ]
    })
    lines.push([
      row.searchTerm,
      row.rank,
      row.department,
      ...products,
      row.opportunityTag,
      row.suggestedAction,
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

  let sourceRows: SourceRow[] = []

  if (searchTerm) {
    let candidateQuery = readClient
      .from('brand_analytics_search_terms_rows')
      .select('department_name, search_term, search_frequency_rank')
      .eq('workspace_id', workspaceId)
      .ilike('search_term', `%${searchTerm}%`)

    if (latestJob?.report_document_id) candidateQuery = candidateQuery.eq('report_document_id', latestJob.report_document_id)
    else if (latestJob?.report_id) candidateQuery = candidateQuery.eq('report_id', latestJob.report_id)
    if (clickedAsin) candidateQuery = candidateQuery.eq('clicked_asin', clickedAsin)
    if (departmentName) candidateQuery = candidateQuery.eq('department_name', departmentName)
    if (minRank !== null) candidateQuery = candidateQuery.gte('search_frequency_rank', minRank)
    if (maxRank !== null) candidateQuery = candidateQuery.lte('search_frequency_rank', maxRank)
    if (opportunity === 'high-demand') candidateQuery = candidateQuery.lte('search_frequency_rank', 10000)

    const { data: candidateData, error: candidateError } = await candidateQuery
      .order('search_frequency_rank', { ascending: true, nullsFirst: false })
      .limit(EXPORT_CANDIDATE_LIMIT)

    if (candidateError) {
      return NextResponse.json({ errorCode: 'export_query_failed', stage: 'export_candidate_query', message: 'Export failed safely.' }, { status: 500 })
    }

    const candidates = uniqueCandidates(Array.isArray(candidateData) ? candidateData as CandidateRow[] : [])
      .slice(0, EXPORT_GROUP_LIMIT)

    if (candidates.length > 0) {
      const candidateKeys = new Set(candidates.map(candidateKey))
      const searchTerms = uniqueStrings(candidates.map(row => row.search_term))
      const ranks = uniqueNumbers(candidates.map(row => row.search_frequency_rank))
      const departments = uniqueStrings(candidates.map(row => row.department_name))

      let detailQuery = readClient
        .from('brand_analytics_search_terms_rows')
        .select('department_name, search_term, search_frequency_rank, clicked_asin, clicked_item_name, click_share_rank, click_share, conversion_share')
        .eq('workspace_id', workspaceId)
        .in('search_term', searchTerms)
        .lte('click_share_rank', 3)

      if (latestJob?.report_document_id) detailQuery = detailQuery.eq('report_document_id', latestJob.report_document_id)
      else if (latestJob?.report_id) detailQuery = detailQuery.eq('report_id', latestJob.report_id)
      if (ranks.length > 0) detailQuery = detailQuery.in('search_frequency_rank', ranks)
      if (departments.length > 0) detailQuery = detailQuery.in('department_name', departments)
      if (clickedAsin) detailQuery = detailQuery.eq('clicked_asin', clickedAsin)

      const { data: detailData, error: detailError } = await detailQuery
        .order('search_frequency_rank', { ascending: true, nullsFirst: false })
        .order('click_share_rank', { ascending: true, nullsFirst: false })
        .limit(candidates.length * 3)

      if (detailError) {
        return NextResponse.json({ errorCode: 'export_query_failed', stage: 'export_detail_query', message: 'Export failed safely.' }, { status: 500 })
      }

      sourceRows = (Array.isArray(detailData) ? detailData as SourceRow[] : [])
        .filter(row => candidateKeys.has(candidateKey(row)))
    }
  } else {
    let query = readClient
      .from('brand_analytics_search_terms_rows')
      .select('department_name, search_term, search_frequency_rank, clicked_asin, clicked_item_name, click_share_rank, click_share, conversion_share')
      .eq('workspace_id', workspaceId)
      .lte('click_share_rank', 3)

    if (latestJob?.report_document_id) query = query.eq('report_document_id', latestJob.report_document_id)
    else if (latestJob?.report_id) query = query.eq('report_id', latestJob.report_id)
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

    const { data, error } = await query
      .order('search_frequency_rank', { ascending: true, nullsFirst: false })
      .order('click_share_rank', { ascending: true, nullsFirst: false })
      .limit(EXPORT_SOURCE_LIMIT)

    if (error) {
      return NextResponse.json({ errorCode: 'export_query_failed', stage: 'export_query', message: 'Export failed safely.' }, { status: 500 })
    }

    sourceRows = Array.isArray(data) ? data as SourceRow[] : []
  }

  const rows = groupRows(sourceRows)
    .filter(row => matchesOpportunity(row, opportunity))
    .slice(0, EXPORT_GROUP_LIMIT)
  const csv = toCsv(rows)

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="brand-analytics-search-terms.csv"',
    },
  })
}
