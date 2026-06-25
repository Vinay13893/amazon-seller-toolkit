import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'
import { parseChangeHistoryJson, type ChangeHistoryParseResult } from '@/lib/internal/ads-change-history-parser'
import { importParsedChangeHistory } from '@/lib/internal/ads-change-history-import'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 300

const SAFE_FILE_NAME = /^[\w.,() -]+\.json$/i

// Manual export only — every file here was saved by hand from DevTools.
// Never fetched automatically, never via browser cookies/session auth.
// This route only reads local files already on disk and writes to our own
// Supabase tables — it never calls Amazon.
const DEFAULT_CHANGE_HISTORY_DIR = 'C:\\Vinay\\Emount Profitability Calculator\\Change History'
const changeHistoryDir = resolve(process.env.ADS_CHANGE_HISTORY_DIR ?? DEFAULT_CHANGE_HISTORY_DIR)

// Matches the convention used by these exports, e.g.
// "event_history_20260501_20260520_page0.json" -> [2026-05-01, 2026-05-20]
const FILENAME_DATE_PATTERN = /(\d{8})_(\d{8})/

function filenameImpliedRange(fileName: string): { start: string; end: string } | null {
  const match = fileName.match(FILENAME_DATE_PATTERN)
  if (!match) return null
  const toIso = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
  return { start: toIso(match[1]), end: toIso(match[2]) }
}

type FileEntry = {
  fileName: string
  filenameRange: { start: string; end: string } | null
  filenameRangeMismatch: string | null
} & ({ status: 'parsed'; result: Extract<ChangeHistoryParseResult, { ok: true }> } | { status: 'skipped'; reason: string })

export async function POST() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const workspaceId = access.workspaceId

  let fileNames: string[]
  try {
    fileNames = readdirSync(changeHistoryDir).filter(name => SAFE_FILE_NAME.test(name) && name.toLowerCase().endsWith('.json'))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Change History folder could not be read.' },
      { status: 400 },
    )
  }

  if (fileNames.length === 0) {
    return NextResponse.json({ written: false, filesFound: 0, files: [] })
  }

  // Pass 1: read + parse every file (no DB writes yet), so we can sort by
  // the actual event timestamps inside each file rather than trusting the
  // filename, and flag any filename whose implied range disagrees with it.
  const entries: FileEntry[] = []
  for (const fileName of fileNames) {
    const filenameRange = filenameImpliedRange(fileName)
    const filePath = resolve(changeHistoryDir, fileName)

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      entries.push({ fileName, filenameRange, filenameRangeMismatch: null, status: 'skipped', reason: error instanceof Error ? error.message : 'File could not be read.' })
      continue
    }

    if (!raw.trim()) {
      entries.push({ fileName, filenameRange, filenameRangeMismatch: null, status: 'skipped', reason: 'File is empty (0 bytes).' })
      continue
    }

    const result = parseChangeHistoryJson(raw)
    if (!result.ok) {
      entries.push({ fileName, filenameRange, filenameRangeMismatch: null, status: 'skipped', reason: result.error })
      continue
    }
    if (result.accepted.length === 0) {
      entries.push({ fileName, filenameRange, filenameRangeMismatch: null, status: 'skipped', reason: 'No usable events found in file (all rows rejected or file contained zero events).' })
      continue
    }

    let filenameRangeMismatch: string | null = null
    if (filenameRange && result.stats.dateRangeStart && result.stats.dateRangeEnd) {
      const embeddedStart = result.stats.dateRangeStart.slice(0, 10)
      const embeddedEnd = result.stats.dateRangeEnd.slice(0, 10)
      // Allow embedded range to be a subset of the filename-implied range
      // (Amazon's actual changes don't have to span the whole requested window).
      if (embeddedStart < filenameRange.start || embeddedEnd > filenameRange.end) {
        filenameRangeMismatch = `Filename implies ${filenameRange.start}→${filenameRange.end}, but actual event timestamps span ${embeddedStart}→${embeddedEnd}. Relying on the embedded timestamps, not the filename.`
      }
    }

    entries.push({ fileName, filenameRange, filenameRangeMismatch, status: 'parsed', result })
  }

  // Sort strictly by the embedded event date range, never by filename.
  const parsedEntries = entries.filter((e): e is FileEntry & { status: 'parsed' } => e.status === 'parsed')
  parsedEntries.sort((a, b) => {
    const aStart = a.result.stats.dateRangeStart ?? ''
    const bStart = b.result.stats.dateRangeStart ?? ''
    return aStart < bStart ? -1 : aStart > bStart ? 1 : 0
  })

  const admin = createAdminClient()
  const fileResults: Array<Record<string, unknown>> = []
  let totalAccepted = 0
  let totalInserted = 0
  let totalUpdated = 0
  let totalRejected = 0
  let filesImported = 0

  for (const entry of parsedEntries) {
    const outcome = await importParsedChangeHistory(admin, workspaceId, entry.fileName, entry.result)
    if (!outcome.ok) {
      fileResults.push({ fileName: entry.fileName, status: 'error', error: outcome.error, filenameRangeMismatch: entry.filenameRangeMismatch })
      continue
    }
    filesImported += 1
    totalAccepted += outcome.acceptedCount
    totalInserted += outcome.insertedCount
    totalUpdated += outcome.updatedCount
    totalRejected += outcome.rejectedCount
    fileResults.push({
      fileName: entry.fileName,
      status: 'imported',
      dateRangeStart: outcome.dateRangeStart,
      dateRangeEnd: outcome.dateRangeEnd,
      acceptedCount: outcome.acceptedCount,
      rejectedCount: outcome.rejectedCount,
      insertedCount: outcome.insertedCount,
      updatedCount: outcome.updatedCount,
      isIncomplete: outcome.isIncomplete,
      incompleteImportWarning: outcome.incompleteImportWarning,
      filenameRangeMismatch: entry.filenameRangeMismatch,
    })
  }

  const skippedEntries = entries.filter((e): e is FileEntry & { status: 'skipped' } => e.status === 'skipped')
  for (const entry of skippedEntries) {
    fileResults.push({ fileName: entry.fileName, status: 'skipped', reason: entry.reason })
  }

  const { count: totalStoredEventsAfterImport } = await admin
    .from('internal_ads_change_history_events')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)

  return NextResponse.json({
    written: filesImported > 0,
    filesFound: fileNames.length,
    filesImported,
    filesSkipped: skippedEntries.length,
    totalAccepted,
    // totalInserted = genuinely new rows; totalUpdated = matched an existing
    // dedupe_key (deduped/skipped-as-duplicate-content, not double-counted).
    totalInserted,
    totalUpdated,
    totalRejected,
    totalStoredEventsAfterImport: totalStoredEventsAfterImport ?? null,
    files: fileResults,
  })
}
