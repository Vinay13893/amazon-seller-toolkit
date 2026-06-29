// Phase R9: export unmapped Business Report SKU/ASIN rows for manual review.
// Read-only against Amazon (never calls any Amazon API) and read-only
// against the DB (writes nothing back, only produces a local review file).
// No buyer PII — only SKU/ASIN identifiers, cost-master category/title, and
// aggregate sales/traffic figures.
//
// Usage:
//   npx tsx scripts/export-business-report-sku-mapping-review.ts                       # last 30 days, .xlsx
//   npx tsx scripts/export-business-report-sku-mapping-review.ts --days=60 --csv
//   npx tsx scripts/export-business-report-sku-mapping-review.ts --date-start=2026-06-01 --date-end=2026-06-28

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
  reportStartDate: string
  reportEndDate: string
  sku: string | null
  childAsin: string | null
  parentAsin: string | null
  title: string | null
  orderedProductSales: number
  unitsOrdered: number
  totalOrderItems: number
  sessionsTotal: number | null
  pageViewsTotal: number | null
  currentPortfolio: string
  suggestedPortfolio: string | null
  mappingReason: string
}

const COLUMNS: Array<{ key: keyof ReviewRow | 'userFinalCategory' | 'notes'; header: string }> = [
  { key: 'reportStartDate', header: 'report_start_date' },
  { key: 'reportEndDate', header: 'report_end_date' },
  { key: 'sku', header: 'sku' },
  { key: 'childAsin', header: 'child_asin' },
  { key: 'parentAsin', header: 'parent_asin' },
  { key: 'title', header: 'title' },
  { key: 'orderedProductSales', header: 'ordered_product_sales' },
  { key: 'unitsOrdered', header: 'units_ordered' },
  { key: 'totalOrderItems', header: 'total_order_items' },
  { key: 'sessionsTotal', header: 'sessions_total' },
  { key: 'pageViewsTotal', header: 'page_views_total' },
  { key: 'currentPortfolio', header: 'current_portfolio' },
  { key: 'suggestedPortfolio', header: 'suggested_portfolio' },
  { key: 'mappingReason', header: 'mapping_reason' },
  { key: 'userFinalCategory', header: 'user_final_category' },
  { key: 'notes', header: 'notes' },
]

async function collectUnmappedRows(admin: SupabaseClient, workspaceId: string, startDate: string, endDate: string): Promise<ReviewRow[]> {
  const out = new Map<string, ReviewRow>()
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('internal_business_report_sku_sales_traffic')
      .select('report_date, sku, sku_norm, child_asin, parent_asin, portfolio, ordered_product_sales, units_ordered, total_order_items, sessions, page_views')
      .eq('workspace_id', workspaceId)
      .gte('report_date', startDate)
      .lte('report_date', endDate)
      .eq('portfolio', 'Unmapped / Needs Review')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`internal_business_report_sku_sales_traffic: ${error.message}`)
    for (const row of data ?? []) {
      const skuNorm = (row.sku_norm as string | null) ?? null
      const key = `${skuNorm ?? ''}|${row.child_asin ?? ''}|${row.parent_asin ?? ''}`
      const existing = out.get(key)
      if (existing) {
        existing.orderedProductSales += Number(row.ordered_product_sales ?? 0)
        existing.unitsOrdered += Number(row.units_ordered ?? 0)
        existing.totalOrderItems += Number(row.total_order_items ?? 0)
      } else {
        out.set(key, {
          reportStartDate: startDate,
          reportEndDate: endDate,
          sku: row.sku as string | null,
          childAsin: row.child_asin as string | null,
          parentAsin: row.parent_asin as string | null,
          title: null,
          orderedProductSales: Number(row.ordered_product_sales ?? 0),
          unitsOrdered: Number(row.units_ordered ?? 0),
          totalOrderItems: Number(row.total_order_items ?? 0),
          sessionsTotal: row.sessions === null ? null : Number(row.sessions),
          pageViewsTotal: row.page_views === null ? null : Number(row.page_views),
          currentPortfolio: row.portfolio as string,
          suggestedPortfolio: null,
          mappingReason: 'No cost-master category match and no regex pattern match.',
        })
      }
    }
    if (!data || data.length < PAGE) break
  }
  return [...out.values()]
}

async function main() {
  const args = parseArgs()
  const days = args.has('days') ? Number(args.get('days')) : 30
  const startDate = args.get('date-start') ?? addDays(todayIso(), -days)
  const endDate = args.get('date-end') ?? todayIso()
  const forceCsv = args.has('csv')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exitCode = 1
    return
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  console.log(`Business Report SKU mapping review — ${startDate} to ${endDate} (read-only, no Amazon calls, no PII)`)

  const { data: workspaceRows } = await admin.from('amazon_ads_profiles').select('workspace_id, profile_id, brahmastra_sync_enabled, is_primary').limit(1000)
  const selectedProfile = (workspaceRows ?? []).find(r => r.brahmastra_sync_enabled && r.is_primary) ?? (workspaceRows ?? []).find(r => r.brahmastra_sync_enabled)
  if (!selectedProfile) {
    console.error('No Brahmastra-selected Amazon Ads profile found — nothing to review.')
    process.exitCode = 1
    return
  }
  const workspaceId = selectedProfile.workspace_id as string

  const rows = await collectUnmappedRows(admin, workspaceId, startDate, endDate)

  // Best-effort suggestion: same two-tier resolver used by the live sync —
  // cost-master exact-match category first, then the shared regex resolver
  // against SKU/title/ASIN text. Never invents a category outside that chain.
  const skuNorms = rows.map(r => (r.sku ? r.sku.toLocaleUpperCase('en-US') : null)).filter((v): v is string => Boolean(v))
  const costMasterBySkuNorm = new Map<string, { category: string | null; productName: string | null }>()
  if (skuNorms.length > 0) {
    const { data } = await admin.from('internal_sku_cost_master').select('sku_norm, category, product_name').eq('workspace_id', workspaceId).in('sku_norm', skuNorms)
    for (const row of data ?? []) costMasterBySkuNorm.set(row.sku_norm as string, { category: (row.category as string | null) ?? null, productName: (row.product_name as string | null) ?? null })
  }
  for (const row of rows) {
    const skuNorm = row.sku ? row.sku.toLocaleUpperCase('en-US') : null
    const costMasterRow = skuNorm ? costMasterBySkuNorm.get(skuNorm) : undefined
    row.title = costMasterRow?.productName ?? null
    const fromCategory = mapCostMasterCategoryToPortfolio(costMasterRow?.category ?? null)
    const suggested = fromCategory !== 'Unmapped / Needs Review'
      ? fromCategory
      : resolveEasyhomePortfolio(null, row.sku, row.title, row.childAsin, row.parentAsin)
    if (suggested !== 'Unmapped / Needs Review') {
      row.suggestedPortfolio = suggested
      row.mappingReason = costMasterRow?.category
        ? `Cost-master category "${costMasterRow.category}" maps to ${suggested}.`
        : `SKU/ASIN/title text pattern matched ${suggested}.`
    } else if (costMasterRow?.category) {
      row.mappingReason = `Cost-master category "${costMasterRow.category}" has no known portfolio mapping yet.`
    }
  }

  rows.sort((a, b) => b.orderedProductSales - a.orderedProductSales)

  console.log(`Found ${rows.length} distinct unmapped SKU/ASIN combination(s) in this range.`)
  const stillSuggestable = rows.filter(r => r.suggestedPortfolio).length
  if (stillSuggestable > 0) console.log(`  ${stillSuggestable} row(s) have an automatic suggestion already — review and confirm rather than leaving blank.`)

  const outDir = resolve(process.cwd())
  const canWriteXlsx = !forceCsv
  let outPath: string

  if (canWriteXlsx) {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Business Report SKU Review')
    sheet.addRow(COLUMNS.map(c => c.header))
    for (const row of rows) {
      sheet.addRow(COLUMNS.map(c => {
        if (c.key === 'userFinalCategory' || c.key === 'notes') return ''
        return row[c.key as keyof ReviewRow] ?? ''
      }))
    }
    sheet.columns.forEach(col => { col.width = 22 })
    outPath = resolve(outDir, 'business-report-sku-mapping-review.xlsx')
    await workbook.xlsx.writeFile(outPath)
  } else {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [COLUMNS.map(c => c.header).join(',')]
    for (const row of rows) {
      lines.push(COLUMNS.map(c => esc(c.key === 'userFinalCategory' || c.key === 'notes' ? '' : row[c.key as keyof ReviewRow])).join(','))
    }
    outPath = resolve(outDir, 'business-report-sku-mapping-review.csv')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, lines.join('\n'), 'utf8')
  }

  console.log(`Wrote ${rows.length} row(s) to ${outPath}`)
  console.log(existsSync(outPath) ? 'File confirmed on disk.' : 'WARNING: file not found after write.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
