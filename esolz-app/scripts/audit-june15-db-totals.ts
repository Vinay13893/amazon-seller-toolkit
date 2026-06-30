// Audit 2026-06-15 DB totals: spend/clicks/purchases/sales by campaign type
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

try {
  const envText = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* */ }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

function fmt(n: number) { return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` }

async function main() {
  // Get the Brahmastra profile ID
  const { data: profile } = await supabase
    .from('amazon_ads_profiles')
    .select('profile_id, account_name, display_name')
    .eq('is_primary', true)
    .limit(1)
    .maybeSingle()
  const profileId = profile?.profile_id as string
  console.log(`Profile: ${profile?.display_name ?? profile?.account_name} (${profileId})`)
  console.log(`Date: 2026-06-15`)
  console.log()

  const DATE = '2026-06-15'

  // 1. Campaign daily totals (all rows for date)
  const { data: campRows } = await supabase
    .from('internal_ads_campaign_daily_rows')
    .select('campaign_name, campaign_type, spend, clicks, purchases, sales')
    .eq('profile_id', profileId)
    .eq('report_date', DATE)

  const rows = campRows ?? []
  const total = rows.reduce((acc, r) => ({
    spend: acc.spend + Number(r.spend ?? 0),
    clicks: acc.clicks + Number(r.clicks ?? 0),
    purchases: acc.purchases + Number(r.purchases ?? 0),
    sales: acc.sales + Number(r.sales ?? 0),
  }), { spend: 0, clicks: 0, purchases: 0, sales: 0 })

  console.log(`=== Campaign daily (internal_ads_campaign_daily_rows) ===`)
  console.log(`Total rows: ${rows.length}`)
  console.log(`Total Spend:     ${fmt(total.spend)} (Console expects: ₹11,343.92)`)
  console.log(`Total Clicks:    ${total.clicks.toLocaleString('en-IN')} (Console expects: 1,573)`)
  console.log(`Total Purchases: ${total.purchases} (Console expects: 62)`)
  console.log(`Total Sales:     ${fmt(total.sales)} (Console expects: ₹64,474.75)`)
  console.log(`ROAS:            ${total.spend > 0 ? (total.sales / total.spend).toFixed(2) : '—'}x (Console expects: 5.68x)`)
  console.log()

  // 2. Breakdown by campaign_type
  const byType = new Map<string, { spend: number; clicks: number; purchases: number; sales: number; count: number }>()
  for (const r of rows) {
    const t = (r.campaign_type as string | null) ?? '(null/unknown)'
    const acc = byType.get(t) ?? { spend: 0, clicks: 0, purchases: 0, sales: 0, count: 0 }
    acc.spend += Number(r.spend ?? 0)
    acc.clicks += Number(r.clicks ?? 0)
    acc.purchases += Number(r.purchases ?? 0)
    acc.sales += Number(r.sales ?? 0)
    acc.count += 1
    byType.set(t, acc)
  }

  console.log(`=== Breakdown by campaign_type ===`)
  for (const [type, acc] of [...byType.entries()].sort((a, b) => b[1].spend - a[1].spend)) {
    console.log(`  ${type}: rows=${acc.count}, spend=${fmt(acc.spend)}, clicks=${acc.clicks}, purchases=${acc.purchases}, sales=${fmt(acc.sales)}`)
  }
  console.log()

  // 3. Breakdown by campaign name prefix (SP/SD/SB)
  const byPrefix = new Map<string, { spend: number; clicks: number; count: number }>()
  for (const r of rows) {
    const name = (r.campaign_name as string | null) ?? ''
    const prefix = name.startsWith('SD') ? 'SD' : name.startsWith('SB') || name.startsWith('Sponsored Brands') ? 'SB' : 'SP'
    const acc = byPrefix.get(prefix) ?? { spend: 0, clicks: 0, count: 0 }
    acc.spend += Number(r.spend ?? 0)
    acc.clicks += Number(r.clicks ?? 0)
    acc.count += 1
    byPrefix.set(prefix, acc)
  }
  console.log(`=== Breakdown by campaign name prefix ===`)
  for (const [prefix, acc] of [...byPrefix.entries()].sort((a, b) => b[1].spend - a[1].spend)) {
    console.log(`  ${prefix}: rows=${acc.count}, spend=${fmt(acc.spend)}, clicks=${acc.clicks}`)
  }
  console.log()

  // 4. List unique campaign names
  const names = [...new Set(rows.map(r => r.campaign_name as string))].sort()
  console.log(`=== Unique campaign names (${names.length}) ===`)
  for (const n of names) console.log(`  ${n}`)
  console.log()

  // 5. Gap vs Console
  const consoleSpend = 11343.92, consoleClicks = 1573, consolePurchases = 62, consoleSales = 64474.75
  console.log(`=== Gap vs Amazon Ads Console ===`)
  console.log(`  Spend gap:     ${fmt(consoleSpend - total.spend)} (${((consoleSpend - total.spend) / consoleSpend * 100).toFixed(1)}% missing)`)
  console.log(`  Clicks gap:    ${consoleClicks - total.clicks}`)
  console.log(`  Purchases gap: ${consolePurchases - total.purchases}`)
  console.log(`  Sales gap:     ${fmt(consoleSales - total.sales)}`)
}

main().catch(console.error)
