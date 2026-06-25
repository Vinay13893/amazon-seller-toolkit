import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { parseChangeHistoryJson } from '@/lib/internal/ads-change-history-parser'
import { importParsedChangeHistory } from '@/lib/internal/ads-change-history-import'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const SAFE_FILE_NAME = /^[\w.,() -]+\.json$/i

// Manual export only — the user saves this JSON by hand from DevTools.
// Never fetched automatically, never via browser cookies/session auth.
const DEFAULT_CHANGE_HISTORY_DIR = 'C:\\Vinay\\Emount Profitability Calculator\\Change History'
const changeHistoryDir = resolve(process.env.ADS_CHANGE_HISTORY_DIR ?? DEFAULT_CHANGE_HISTORY_DIR)

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
    return NextResponse.json({ error: 'A valid .json file name is required.' }, { status: 400 })
  }

  const filePath = resolve(/* turbopackIgnore: true */ changeHistoryDir, fileName)
  if (!filePath.startsWith(changeHistoryDir)) {
    return NextResponse.json({ error: 'File name is not allowed.' }, { status: 400 })
  }

  let result
  try {
    const raw = readFileSync(filePath, 'utf8')
    result = parseChangeHistoryJson(raw)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Change history file could not be read.' },
      { status: 400 },
    )
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  const admin = createAdminClient()
  const outcome = await importParsedChangeHistory(admin, workspaceId, fileName, result)

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 503 })
  }

  const { count: totalStoredEventsAfterImport } = await admin
    .from('internal_ads_change_history_events')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)

  return NextResponse.json({
    written: outcome.written,
    totalRowCount: result.stats.totalRowCount,
    acceptedCount: outcome.acceptedCount,
    rejectedCount: outcome.rejectedCount,
    dateRangeStart: outcome.dateRangeStart,
    dateRangeEnd: outcome.dateRangeEnd,
    campaignCount: result.stats.campaignCount,
    changeTypeCounts: result.stats.changeTypeCounts,
    // insertedCount = genuinely new rows; updatedCount = matched an existing
    // dedupe_key (deduped/skipped-as-duplicate-content, values refreshed in place).
    insertedCount: outcome.insertedCount,
    updatedCount: outcome.updatedCount,
    incompleteImportWarning: outcome.incompleteImportWarning,
    totalStoredEventsAfterImport: totalStoredEventsAfterImport ?? null,
  })
}
