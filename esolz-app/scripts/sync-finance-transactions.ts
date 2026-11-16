// Run on the existing SP-API worker after migration, with explicit --workspace-id=UUID.
// Reads Amazon only. Writes a separate API ledger, never legacy uploads or Google Sheets.
// --dry-run checks access and all pages without writing data or run history.
// Default: re-read 30 days to capture corrected/deferred transactions; --days=1..180 for backfill.
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../src/lib/amazon/crypto'
import { refreshAccessToken } from '../src/lib/amazon/lwa'
import { financeTransactionPages } from '../src/lib/amazon/finance-transactions'
import { marketplaceTodayIso, marketplaceCalendarDayWindow, addCalendarDays } from '../src/lib/internal/business-report-marketplace-time'

async function main() {
  const args = new Map(process.argv.slice(2).map(arg => {
    const [key, ...value] = arg.replace(/^--/, '').split('=')
    return [key, value.join('=') || 'true']
  }))
  const workspaceId = args.get('workspace-id')
  const days = Number(args.get('days') ?? 30)
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId) || !Number.isInteger(days) || days < 1 || days > 180) {
    throw new Error('Supply an explicit workspace ID and days between 1 and 180.')
  }
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !process.env.SPAPI_ENCRYPTION_KEY || !process.env.SPAPI_LWA_CLIENT_ID || !process.env.SPAPI_LWA_CLIENT_SECRET) {
    throw new Error('Finance worker configuration is incomplete. Configure secrets in the hosting dashboard.')
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: connection, error } = await admin.from('amazon_connections')
    .select('marketplace_id,refresh_token_encrypted').eq('workspace_id', workspaceId).eq('status', 'active').single()
  if (error || !connection?.refresh_token_encrypted || connection.marketplace_id !== 'A21TJRUUN4KGV') {
    throw new Error('An active India SP-API connection is required for this workspace.')
  }
  const marketplaceId = connection.marketplace_id as string
  const today = marketplaceTodayIso('Asia/Kolkata')
  const dateFrom = addCalendarDays(today, -days)
  const dateTo = addCalendarDays(today, -1)
  const postedAfter = marketplaceCalendarDayWindow(dateFrom, 'Asia/Kolkata').dataStartTime
  const postedBefore = marketplaceCalendarDayWindow(today, 'Asia/Kolkata').dataStartTime
  let token = '', expiresAt = 0
  const accessToken = async () => {
    if (Date.now() >= expiresAt) {
      try {
        const refreshed = await refreshAccessToken(decryptToken(connection.refresh_token_encrypted))
        token = refreshed.access_token
        expiresAt = Date.now() + Math.max(60, refreshed.expires_in - 120) * 1000
      } catch { throw new Error('Amazon authentication failed. Check the SP-API connection.') }
    }
    return token
  }
  const dryRun = args.has('dry-run')
  let runId: string | undefined
  if (!dryRun) {
    // Partial unique index in the migration makes overlapping invocations fail atomically.
    // Never expire another worker's lock based solely on wall-clock age.
    const run = await admin.from('internal_data_refresh_runs').insert({
      workspace_id: workspaceId, marketplace_id: marketplaceId,
      source: 'finance_transactions_sp_api', status: 'running', date_from: dateFrom, date_to: dateTo,
      report_options: { apiVersion: '2024-06-19', ledgerOnly: true, recentDataMayBeDelayed: true },
    }).select('id').single()
    if (run.error || !run.data) throw new Error('Cannot acquire Finance sync lock. Check migration or an existing run.')
    runId = run.data.id
  }
  let rowCount = 0, pageCount = 0
  try {
    for await (const rows of financeTransactionPages({ marketplaceId, postedAfter, postedBefore, accessToken })) {
      // A repeated transaction ID updates status/amount; it does not create a duplicate.
      const distinct = [...new Map(rows.map(row => [row.transaction_id, row])).values()]
      for (let offset = 0; !dryRun && offset < distinct.length; offset += 250) {
        const batch = distinct.slice(offset, offset + 250).map(row => ({
          ...row, workspace_id: workspaceId, marketplace_id: marketplaceId,
          last_seen_at: new Date().toISOString(), sync_run_id: runId,
        }))
        const saved = await admin.from('internal_amazon_finance_transactions').upsert(batch, {
          onConflict: 'workspace_id,marketplace_id,transaction_id',
        })
        if (saved.error) throw new Error('Finance ledger write failed; this run is incomplete.')
      }
      rowCount += rows.length
      pageCount++
    }
    if (runId) {
      const finished = await admin.from('internal_data_refresh_runs').update({
        status: 'success', finished_at: new Date().toISOString(), rows_fetched: rowCount,
        rows_rejected: 0,
      }).eq('id', runId).eq('workspace_id', workspaceId)
      if (finished.error) throw new Error('Could not record Finance sync completion.')
    }
    console.log(`Finance ${dryRun ? 'access check' : 'sync'} complete: ${pageCount} pages, ${rowCount} received rows. Latest 48 hours may still change.`)
  } catch (error) {
    // Only library-generated safe errors are persisted; no response body or token.
    const message = error instanceof Error ? error.message : 'Finance sync failed.'
    if (runId) await admin.from('internal_data_refresh_runs').update({
      status: 'failed', finished_at: new Date().toISOString(), rows_fetched: rowCount,
      error_message: message,
    }).eq('id', runId).eq('workspace_id', workspaceId)
    throw error
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Finance sync failed.')
  process.exitCode = 1
})
