import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import {
  parseAdsCampaignDailyReport,
  type AdsCampaignDailyRecord,
} from '@/lib/internal/ads-campaign-daily-parser'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const TABLE = 'internal_ads_campaign_daily_rows'
const BATCH_TABLE = 'internal_ads_campaign_upload_batches'
const WRITE_CHUNK_SIZE = 500
const SAFE_FILE_NAME = /^[\w.,() -]+\.csv$/i
const BEFORE_START = '2026-06-01'

// Local-machine folder only, matching the payment-transactions importer
// convention — this route only works where the file already exists on disk.
const DEFAULT_CAMPAIGNS_DIR = 'C:\\Vinay\\Emount Profitability Calculator\\Campaigns Report'
const campaignsDir = resolve(process.env.ADS_CAMPAIGN_REPORTS_DIR ?? DEFAULT_CAMPAIGNS_DIR)

type NormalizedRow = {
  workspace_id: string
  upload_batch_id: string
  report_date: string
  campaign_name: string
  campaign_id: string | null
  campaign_status: string | null
  campaign_type: string | null
  targeting_type: string | null
  portfolio_name: string | null
  ad_group_name: string | null
  targeting: string | null
  match_type: string | null
  advertised_sku: string | null
  advertised_asin: string | null
  search_term: string | null
  impressions: number
  clicks: number
  ctr: number | null
  spend: number
  cpc: number | null
  purchases: number
  sales: number
  acos: number | null
  roas: number | null
  easyhome_portfolio: string
  dedupe_key: string
  raw_row: Record<string, string>
  source: string
}

function toNormalizedRow(record: AdsCampaignDailyRecord, workspaceId: string, batchId: string): NormalizedRow {
  return {
    workspace_id: workspaceId,
    upload_batch_id: batchId,
    report_date: record.reportDate,
    campaign_name: record.campaignName,
    campaign_id: record.campaignId,
    campaign_status: record.campaignStatus,
    campaign_type: record.campaignType,
    targeting_type: record.targetingType,
    portfolio_name: record.portfolioName,
    ad_group_name: record.adGroupName,
    targeting: record.targeting,
    match_type: record.matchType,
    advertised_sku: record.advertisedSku,
    advertised_asin: record.advertisedAsin,
    search_term: record.searchTerm,
    impressions: record.impressions,
    clicks: record.clicks,
    ctr: record.ctr,
    spend: record.spend,
    cpc: record.cpc,
    purchases: record.purchases,
    sales: record.sales,
    acos: record.acos,
    roas: record.roas,
    easyhome_portfolio: record.easyhomePortfolio,
    dedupe_key: record.dedupeKey,
    raw_row: record.rawRow,
    source: 'manual_csv_upload',
  }
}

function findMissingDays(presentDates: Set<string>, start: string, end: string): string[] {
  const missing: string[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  while (cursor.getTime() <= endDate.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    if (!presentDates.has(iso)) missing.push(iso)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return missing
}

type RequestBody = { fileName?: unknown }

export async function POST(request: Request) {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  const body = await request.json().catch(() => ({})) as RequestBody
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  if (!fileName || !SAFE_FILE_NAME.test(fileName)) {
    return NextResponse.json({ error: 'A valid .csv file name is required.' }, { status: 400 })
  }

  const filePath = resolve(/* turbopackIgnore: true */ campaignsDir, fileName)
  if (!filePath.startsWith(campaignsDir)) {
    return NextResponse.json({ error: 'File name is not allowed.' }, { status: 400 })
  }

  let result
  try {
    const raw = readFileSync(filePath, 'utf8')
    result = parseAdsCampaignDailyReport(raw)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Campaign report could not be read.' },
      { status: 400 },
    )
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  if (result.accepted.length === 0) {
    return NextResponse.json({
      written: false,
      ...result.stats,
      insertedCount: 0,
      updatedCount: 0,
      rejectedSample: result.rejected.slice(0, 10),
    })
  }

  const admin = createAdminClient()

  const { data: batch, error: batchError } = await admin
    .from(BATCH_TABLE)
    .insert({
      workspace_id: workspaceId,
      original_filename: fileName,
      report_date_start: result.stats.dateRangeStart,
      report_date_end: result.stats.dateRangeEnd,
      row_count: result.stats.totalRowCount,
      accepted_count: result.stats.acceptedCount,
      rejected_count: result.stats.rejectedCount,
      total_spend: result.stats.totalSpend,
      total_sales: result.stats.totalSales,
      campaign_count: result.stats.campaignCount,
      unmapped_campaign_count: result.stats.unmappedCampaignCount,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return NextResponse.json(
      { error: 'Upload batch could not be recorded. Confirm migration 038 is applied.' },
      { status: 503 },
    )
  }

  const dedupedRows = new Map<string, NormalizedRow>()
  for (const record of result.accepted) {
    const normalized = toNormalizedRow(record, workspaceId, batch.id as string)
    dedupedRows.set(normalized.dedupe_key, normalized)
  }
  const rows = [...dedupedRows.values()]

  const EXISTING_PAGE_SIZE = 1000
  const existingIdByKey = new Map<string, string>()
  for (let page = 0; ; page += 1) {
    const { data: pageRows, error: pageError } = await admin
      .from(TABLE)
      .select('id, dedupe_key')
      .eq('workspace_id', workspaceId)
      .range(page * EXISTING_PAGE_SIZE, page * EXISTING_PAGE_SIZE + EXISTING_PAGE_SIZE - 1)
    if (pageError) {
      return NextResponse.json(
        { error: 'Existing campaign rows could not be read. Confirm migration 038 is applied.' },
        { status: 503 },
      )
    }
    for (const row of pageRows ?? []) existingIdByKey.set(row.dedupe_key as string, row.id as string)
    if (!pageRows || pageRows.length < EXISTING_PAGE_SIZE) break
  }

  const insertRows: NormalizedRow[] = []
  const updateRows: Array<NormalizedRow & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(row.dedupe_key)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }

  let insertedCount = 0
  try {
    for (let i = 0; i < insertRows.length; i += WRITE_CHUNK_SIZE) {
      const chunk = insertRows.slice(i, i + WRITE_CHUNK_SIZE)
      const { error } = await admin.from(TABLE).insert(chunk)
      if (error) throw new Error(error.message)
      insertedCount += chunk.length
    }
    for (let i = 0; i < updateRows.length; i += WRITE_CHUNK_SIZE) {
      const chunk = updateRows.slice(i, i + WRITE_CHUNK_SIZE)
      const { error } = await admin.from(TABLE).upsert(chunk, { onConflict: 'id' })
      if (error) throw new Error(error.message)
    }
  } catch {
    return NextResponse.json(
      { error: 'Campaign rows could not be saved. Confirm migration 038 is applied.' },
      { status: 503 },
    )
  }

  await admin
    .from(BATCH_TABLE)
    .update({ inserted_count: insertedCount, updated_count: updateRows.length })
    .eq('id', batch.id)

  const presentDates = new Set(rows.map(row => row.report_date))
  const checkStart = BEFORE_START < (result.stats.dateRangeStart ?? BEFORE_START) ? BEFORE_START : (result.stats.dateRangeStart ?? BEFORE_START)
  const missingDays = result.stats.dateRangeEnd
    ? findMissingDays(presentDates, checkStart, result.stats.dateRangeEnd)
    : []

  const beforeDaysPresent = [...presentDates].filter(d => d >= '2026-06-01' && d <= '2026-06-14').length
  const afterDaysPresent = [...presentDates].filter(d => d >= '2026-06-15').length

  return NextResponse.json({
    written: true,
    ...result.stats,
    insertedCount,
    updatedCount: updateRows.length,
    beforeDaysPresent,
    afterDaysPresent,
    missingDaysInRange: missingDays,
    missingDaysWarning: missingDays.length > 0
      ? `${missingDays.length} day(s) between ${checkStart} and ${result.stats.dateRangeEnd} have no campaign data.`
      : null,
  })
}
