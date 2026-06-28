// Phase: mapping cleanup foundation. Read-only against Amazon (this script
// never calls any Amazon API — it only reads our own Supabase tables) and
// read-only against the DB too: it writes nothing back, only produces a
// local review file. No buyer PII, no order IDs, no raw transaction rows —
// only Ads-side identifiers (campaign/ad group/SKU/ASIN/keyword/search term)
// and aggregate spend/sales figures.
//
// Usage:
//   npx tsx scripts/export-unmapped-mapping-review.ts                # last 30 days, .xlsx
//   npx tsx scripts/export-unmapped-mapping-review.ts --days=60 --csv

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { resolveEasyhomePortfolio } from '../src/lib/internal/portfolio-labels'
import { mapCostMasterCategoryToPortfolio } from '../src/lib/internal/easyhome-drop-diagnostic'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  // no .env.local present — fine outside local dev
}

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const withValue = arg.match(/^--([a-zA-Z-]+)=(.*)$/)
    if (withValue) { args.set(withValue[1], withValue[2]); continue }
    const bareFlag = arg.match(/^--([a-zA-Z-]+)$/)
    if (bareFlag) args.set(bareFlag[1], '1')
  }
  return args
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

type ReviewRow = {
  detectedValue: string
  entityType: string
  campaignName: string | null
  adGroupName: string | null
  sku: string | null
  asin: string | null
  keywordOrTargetOrSearchTerm: string | null
  currentPortfolio: string | null
  suggestedPortfolio: string | null
  evidenceSource: string
  spendSelectedRange: number
  salesSelectedRange: number
  totalRevenueIfPaymentSource: number
  examplesCount: number
}

const COLUMNS: Array<{ key: keyof ReviewRow | 'userFinalCategory' | 'notes'; header: string }> = [
  { key: 'detectedValue', header: 'detected_value' },
  { key: 'entityType', header: 'entity_type' },
  { key: 'campaignName', header: 'campaign_name' },
  { key: 'adGroupName', header: 'ad_group_name' },
  { key: 'sku', header: 'sku' },
  { key: 'asin', header: 'asin' },
  { key: 'keywordOrTargetOrSearchTerm', header: 'keyword_or_target_or_search_term' },
  { key: 'currentPortfolio', header: 'current_portfolio' },
  { key: 'suggestedPortfolio', header: 'suggested_portfolio' },
  { key: 'evidenceSource', header: 'evidence_source' },
  { key: 'spendSelectedRange', header: 'spend_selected_range' },
  { key: 'salesSelectedRange', header: 'sales_selected_range' },
  { key: 'totalRevenueIfPaymentSource', header: 'total_revenue_if_payment_source' },
  { key: 'examplesCount', header: 'examples_count' },
  { key: 'userFinalCategory', header: 'user_final_category' },
  { key: 'notes', header: 'notes' },
]

async function collectAdsTableUnmapped(
  admin: SupabaseClient,
  workspaceId: string,
  profileId: string,
  table: string,
  startDate: string,
  entityType: string,
  cols: { entity: string; campaign: string; adGroup?: string; sku?: string; asin?: string },
): Promise<Map<string, ReviewRow>> {
  const out = new Map<string, ReviewRow>()
  const selectCols = ['report_date', 'easyhome_portfolio', 'spend', 'sales', cols.campaign, cols.entity]
  if (cols.adGroup) selectCols.push(cols.adGroup)
  if (cols.sku) selectCols.push(cols.sku)
  if (cols.asin) selectCols.push(cols.asin)

  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(selectCols.join(', '))
      .eq('workspace_id', workspaceId)
      .eq('profile_id', profileId)
      .gte('report_date', startDate)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const campaignName = (row[cols.campaign] as string | null) ?? null
      const entityValue = (row[cols.entity] as string | null) ?? null
      const adGroupName = cols.adGroup ? ((row[cols.adGroup] as string | null) ?? null) : null
      const sku = cols.sku ? ((row[cols.sku] as string | null) ?? null) : null
      const asin = cols.asin ? ((row[cols.asin] as string | null) ?? null) : null
      const storedPortfolio = (row.easyhome_portfolio as string | null) ?? null

      const resolved = resolveEasyhomePortfolio(storedPortfolio, campaignName, adGroupName, entityValue, sku, asin)
      if (resolved !== 'Unmapped / Needs Review') continue

      const detectedValue = entityValue ?? sku ?? campaignName ?? '(unknown)'
      const key = `${entityType}|${detectedValue}|${campaignName ?? ''}`
      const existing = out.get(key)
      if (existing) {
        existing.spendSelectedRange += Number(row.spend ?? 0)
        existing.salesSelectedRange += Number(row.sales ?? 0)
        existing.examplesCount += 1
      } else {
        out.set(key, {
          detectedValue,
          entityType,
          campaignName,
          adGroupName,
          sku,
          asin,
          keywordOrTargetOrSearchTerm: entityType === 'Campaign' ? null : entityValue,
          currentPortfolio: storedPortfolio,
          suggestedPortfolio: null,
          evidenceSource: table,
          spendSelectedRange: Number(row.spend ?? 0),
          salesSelectedRange: Number(row.sales ?? 0),
          totalRevenueIfPaymentSource: 0,
          examplesCount: 1,
        })
      }
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

async function collectPaymentTransactionUnmapped(admin: SupabaseClient, workspaceId: string, startDate: string): Promise<Map<string, ReviewRow>> {
  const out = new Map<string, ReviewRow>()

  const costMasterBySkuNorm = new Map<string, { category: string | null }>()
  {
    const { data, error } = await admin.from('internal_sku_cost_master').select('sku_norm, category').eq('workspace_id', workspaceId).limit(10000)
    if (error) throw new Error(`internal_sku_cost_master: ${error.message}`)
    for (const row of data ?? []) costMasterBySkuNorm.set(row.sku_norm as string, { category: (row.category as string | null) ?? null })
  }

  const revenueBySkuNorm = new Map<string, { sku: string; total: number; rows: number }>()
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('internal_payment_transactions')
      .select('sku, sku_norm, category, product_sales, transaction_date')
      .eq('workspace_id', workspaceId)
      .gte('transaction_date', startDate)
      .in('category', ['Order', 'Refund'])
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`internal_payment_transactions: ${error.message}`)
    for (const row of data ?? []) {
      const skuNorm = row.sku_norm as string | null
      if (!skuNorm) continue
      const existing = revenueBySkuNorm.get(skuNorm) ?? { sku: (row.sku as string | null) ?? skuNorm, total: 0, rows: 0 }
      existing.total += Number(row.product_sales ?? 0)
      existing.rows += 1
      revenueBySkuNorm.set(skuNorm, existing)
    }
    if (!data || data.length < PAGE) break
  }

  for (const [skuNorm, revenue] of revenueBySkuNorm) {
    const costMasterRow = costMasterBySkuNorm.get(skuNorm)
    const category = costMasterRow?.category ?? null
    // Exactly mirrors portfolioForSkuNorm in easyhome-drop-diagnostic.ts:
    // the exact-match cost-master category table first (mapCostMasterCategoryToPortfolio),
    // then fall back to pattern-matching the SKU/product text itself.
    const fromCategory = mapCostMasterCategoryToPortfolio(category)
    const resolved = fromCategory !== 'Unmapped / Needs Review' ? fromCategory : resolveEasyhomePortfolio(null, skuNorm)
    if (resolved !== 'Unmapped / Needs Review') continue

    out.set(`PaymentTransactionSKU|${skuNorm}`, {
      detectedValue: skuNorm,
      entityType: 'Payment Transaction SKU',
      campaignName: null,
      adGroupName: null,
      sku: revenue.sku,
      asin: null,
      keywordOrTargetOrSearchTerm: null,
      currentPortfolio: null,
      // Informational only — surfaces the cost-master category text as a
      // hint, never invents a portfolio bucket the rules don't already know.
      suggestedPortfolio: category,
      evidenceSource: 'internal_payment_transactions + internal_sku_cost_master',
      spendSelectedRange: 0,
      salesSelectedRange: 0,
      totalRevenueIfPaymentSource: Math.round(revenue.total * 100) / 100,
      examplesCount: revenue.rows,
    })
  }
  return out
}

async function main() {
  const args = parseArgs()
  const days = args.has('days') ? Number(args.get('days')) : 30
  const startDate = addDays(todayIso(), -days)
  const forceCsv = args.has('csv')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log(`Brahmastra unmapped mapping review — last ${days} days, from ${startDate} (read-only, no Amazon calls, no PII)`)

  const { data: workspaceRows } = await admin.from('amazon_ads_profiles').select('workspace_id, profile_id, brahmastra_sync_enabled, is_primary').limit(1000)
  const selectedProfile = (workspaceRows ?? []).find(r => r.brahmastra_sync_enabled && r.is_primary) ?? (workspaceRows ?? []).find(r => r.brahmastra_sync_enabled)
  if (!selectedProfile) {
    console.error('No Brahmastra-selected Amazon Ads profile found — nothing to review.')
    process.exitCode = 1
    return
  }
  const workspaceId = selectedProfile.workspace_id as string
  const profileId = selectedProfile.profile_id as string
  console.log(`Profile: ${profileId}`)

  const tableResults = await Promise.all([
    collectAdsTableUnmapped(admin, workspaceId, profileId, 'internal_ads_campaign_daily_rows', startDate, 'Campaign', { entity: 'campaign_name', campaign: 'campaign_name' }),
    collectAdsTableUnmapped(admin, workspaceId, profileId, 'internal_ads_advertised_product_daily_rows', startDate, 'SKU', { entity: 'advertised_sku', campaign: 'campaign_name', adGroup: 'ad_group_name', sku: 'advertised_sku', asin: 'advertised_asin' }),
    collectAdsTableUnmapped(admin, workspaceId, profileId, 'internal_ads_targeting_daily_rows', startDate, 'Keyword / Target', { entity: 'targeting', campaign: 'campaign_name', adGroup: 'ad_group_name' }),
    collectAdsTableUnmapped(admin, workspaceId, profileId, 'internal_ads_search_term_daily_rows', startDate, 'Search Term', { entity: 'search_term', campaign: 'campaign_name', adGroup: 'ad_group_name' }),
  ])
  const paymentResult = await collectPaymentTransactionUnmapped(admin, workspaceId, startDate)

  const allRows: ReviewRow[] = [...tableResults.flatMap(m => [...m.values()]), ...paymentResult.values()]
  allRows.sort((a, b) => (b.spendSelectedRange + b.totalRevenueIfPaymentSource) - (a.spendSelectedRange + a.totalRevenueIfPaymentSource))

  console.log(`Found ${allRows.length} distinct unmapped entity/SKU combination(s) across Ads tables and payment transactions.`)
  for (const t of ['Campaign', 'SKU', 'Keyword / Target', 'Search Term', 'Payment Transaction SKU']) {
    const count = allRows.filter(r => r.entityType === t).length
    if (count > 0) console.log(`  ${t}: ${count}`)
  }

  const outDir = resolve(process.cwd())
  const canWriteXlsx = !forceCsv
  let outPath: string

  if (canWriteXlsx) {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Unmapped Review')
    sheet.addRow(COLUMNS.map(c => c.header))
    for (const row of allRows) {
      sheet.addRow(COLUMNS.map(c => {
        if (c.key === 'userFinalCategory' || c.key === 'notes') return ''
        return row[c.key as keyof ReviewRow] ?? ''
      }))
    }
    sheet.columns.forEach(col => { col.width = 22 })
    outPath = resolve(outDir, 'brahmastra-unmapped-mapping-review.xlsx')
    await workbook.xlsx.writeFile(outPath)
  } else {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [COLUMNS.map(c => c.header).join(',')]
    for (const row of allRows) {
      lines.push(COLUMNS.map(c => esc(c.key === 'userFinalCategory' || c.key === 'notes' ? '' : row[c.key as keyof ReviewRow])).join(','))
    }
    outPath = resolve(outDir, 'brahmastra-unmapped-mapping-review.csv')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, lines.join('\n'), 'utf8')
  }

  console.log(`Wrote ${allRows.length} row(s) to ${outPath}`)
  console.log(existsSync(outPath) ? 'File confirmed on disk.' : 'WARNING: file not found after write.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
