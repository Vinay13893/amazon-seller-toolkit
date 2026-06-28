import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  parseDeepReport,
  resolveAdvertisedProductPortfolio,
  type DeepReportKind,
  type DeepReportRecord,
} from '@/lib/internal/ads-deep-report-parser'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSelectedProfileForWorkspace } from '@/lib/internal/brahmastra-selected-profile'

export const runtime = 'nodejs'
export const maxDuration = 60

const BATCH_TABLE = 'internal_ads_deep_report_upload_batches'
const WRITE_CHUNK_SIZE = 500
const SAFE_FILE_NAME = /^[\w.,() -]+\.csv$/i

const TABLE_BY_KIND: Record<DeepReportKind, string> = {
  advertised_product: 'internal_ads_advertised_product_daily_rows',
  targeting: 'internal_ads_targeting_daily_rows',
  search_term: 'internal_ads_search_term_daily_rows',
}

const DEFAULT_DEEP_REPORTS_DIR = 'C:\\Vinay\\Emount Profitability Calculator\\Campaigns Report'
const deepReportsDir = resolve(process.env.ADS_DEEP_REPORTS_DIR ?? DEFAULT_DEEP_REPORTS_DIR)

function baseRow(record: DeepReportRecord, workspaceId: string, profileId: string, batchId: string, portfolio: string) {
  return {
    workspace_id: workspaceId,
    profile_id: profileId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    ad_group_name: record.adGroupName,
    ad_group_id: record.adGroupId,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    units: record.units,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: portfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'manual_csv_upload',
  }
}

function toRowForKind(record: DeepReportRecord, kind: DeepReportKind, workspaceId: string, profileId: string, batchId: string, portfolio: string) {
  const base = baseRow(record, workspaceId, profileId, batchId, portfolio)
  if (kind === 'advertised_product') {
    return { ...base, advertised_asin: record.advertisedAsin, advertised_sku: record.advertisedSku }
  }
  if (kind === 'targeting') {
    return {
      ...base,
      targeting: record.targeting,
      keyword: record.keyword,
      keyword_type: record.keywordType,
      keyword_id: record.keywordId,
      keyword_bid: record.keywordBid,
      match_type: record.matchType,
    }
  }
  return { ...base, search_term: record.searchTerm, targeting: record.targeting }
}

type RequestBody = { fileName?: unknown; reportKind?: unknown }

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const body = await request.json().catch(() => ({})) as RequestBody
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  const reportKind = body.reportKind as DeepReportKind
  if (!fileName || !SAFE_FILE_NAME.test(fileName)) {
    return NextResponse.json({ error: 'A valid .csv file name is required.' }, { status: 400 })
  }
  if (!['advertised_product', 'targeting', 'search_term'].includes(reportKind)) {
    return NextResponse.json({ error: 'reportKind must be advertised_product, targeting, or search_term.' }, { status: 400 })
  }

  const filePath = resolve(/* turbopackIgnore: true */ deepReportsDir, fileName)
  if (!filePath.startsWith(deepReportsDir)) {
    return NextResponse.json({ error: 'File name is not allowed.' }, { status: 400 })
  }

  let result
  try {
    const raw = readFileSync(filePath, 'utf8')
    result = parseDeepReport(raw, reportKind)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Report could not be read.' },
      { status: 400 },
    )
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  if (result.accepted.length === 0) {
    return NextResponse.json({ written: false, ...result.stats, insertedCount: 0, updatedCount: 0 })
  }

  const admin = createAdminClient()
  const table = TABLE_BY_KIND[reportKind]

  const profileSelection = await resolveSelectedProfileForWorkspace(admin, workspaceId)
  if (!profileSelection.ok) {
    return NextResponse.json({ error: profileSelection.message }, { status: 409 })
  }
  const profileId = profileSelection.profileId

  // advertised_product rows need a SKU -> portfolio lookup the pure parser
  // doesn't have access to; resolve it here against internal_sku_cost_master.
  const costMasterCategoryBySkuNorm = new Map<string, string | null>()
  if (reportKind === 'advertised_product') {
    const { data } = await admin
      .from('internal_sku_cost_master')
      .select('sku_norm, category')
      .eq('workspace_id', workspaceId)
      .limit(10000)
    for (const row of data ?? []) costMasterCategoryBySkuNorm.set(row.sku_norm as string, (row.category as string | null) ?? null)
  }

  let unmappedCount = 0
  const resolvedRecords = result.accepted.map(record => {
    const portfolio = reportKind === 'advertised_product'
      ? resolveAdvertisedProductPortfolio(record, costMasterCategoryBySkuNorm)
      : record.easyhomePortfolio
    if (portfolio === 'Unmapped / Needs Review') unmappedCount += 1
    return { record, portfolio }
  })

  const { data: batch, error: batchError } = await admin
    .from(BATCH_TABLE)
    .insert({
      workspace_id: workspaceId,
      profile_id: profileId,
      report_kind: reportKind,
      original_filename: fileName,
      report_date_start: result.stats.dateRangeStart,
      report_date_end: result.stats.dateRangeEnd,
      row_count: result.stats.totalRowCount,
      accepted_count: result.stats.acceptedCount,
      rejected_count: result.stats.rejectedCount,
      total_spend: result.stats.totalSpend,
      total_sales: result.stats.totalSales,
      total_purchases: result.stats.totalPurchases,
      campaign_count: result.stats.campaignCount,
      unmapped_count: unmappedCount,
      attribution_window_used: result.stats.attributionWindowUsed,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return NextResponse.json(
      { error: 'Upload batch could not be recorded. Confirm migration 039 is applied.' },
      { status: 503 },
    )
  }

  const dedupedRows = new Map<string, ReturnType<typeof toRowForKind>>()
  for (const { record, portfolio } of resolvedRecords) {
    const row = toRowForKind(record, reportKind, workspaceId, profileId, batch.id as string, portfolio)
    dedupedRows.set(row.dedupe_key, row)
  }
  const rows = [...dedupedRows.values()]

  const EXISTING_PAGE_SIZE = 1000
  const existingIdByKey = new Map<string, string>()
  for (let page = 0; ; page += 1) {
    const { data: pageRows, error: pageError } = await admin
      .from(table)
      .select('id, dedupe_key')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .range(page * EXISTING_PAGE_SIZE, page * EXISTING_PAGE_SIZE + EXISTING_PAGE_SIZE - 1)
    if (pageError) {
      return NextResponse.json({ error: `Existing ${reportKind} rows could not be read. Confirm migration 039 is applied.` }, { status: 503 })
    }
    for (const row of pageRows ?? []) existingIdByKey.set(row.dedupe_key as string, row.id as string)
    if (!pageRows || pageRows.length < EXISTING_PAGE_SIZE) break
  }

  const insertRows: typeof rows = []
  const updateRows: Array<typeof rows[number] & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(row.dedupe_key)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

  let insertedCount = 0
  try {
    for (let i = 0; i < insertRows.length; i += WRITE_CHUNK_SIZE) {
      const chunk = insertRows.slice(i, i + WRITE_CHUNK_SIZE)
      const { error } = await admin.from(table).insert(chunk)
      if (error) throw new Error(error.message)
      insertedCount += chunk.length
    }
    for (let i = 0; i < updateRows.length; i += WRITE_CHUNK_SIZE) {
      const chunk = updateRows.slice(i, i + WRITE_CHUNK_SIZE)
      const { error } = await admin.from(table).upsert(chunk, { onConflict: 'id' })
      if (error) throw new Error(error.message)
    }
  } catch {
    return NextResponse.json({ error: `${reportKind} rows could not be saved. Confirm migration 039 is applied.` }, { status: 503 })
  }

  await admin.from(BATCH_TABLE).update({ inserted_count: insertedCount, updated_count: updateRows.length }).eq('id', batch.id)

  return NextResponse.json({
    written: true,
    reportKind,
    ...result.stats,
    unmappedCount,
    insertedCount,
    updatedCount: updateRows.length,
  })
}
