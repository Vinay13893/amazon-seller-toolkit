// Shared import logic for Change History JSON (single-file and bulk-folder
// imports both call this). Read-only against Amazon — this only ever writes
// to our own Supabase tables from an already-saved local JSON file.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type ChangeHistoryParseResult, type ChangeHistoryRecord } from './ads-change-history-parser'

const TABLE = 'internal_ads_change_history_events'
const BATCH_TABLE = 'internal_ads_change_history_import_batches'
const WRITE_CHUNK_SIZE = 500
const EXISTING_PAGE_SIZE = 1000

function toRow(record: ChangeHistoryRecord, workspaceId: string, batchId: string) {
  return {
    workspace_id: workspaceId,
    import_batch_id: batchId,
    source: 'manual_console_event_history_json',
    changed_at: record.changedAtIso,
    changed_at_ms: record.changedAtMs,
    change_type: record.changeType,
    old_value: record.oldValue,
    new_value: record.newValue,
    is_system_event: record.isSystemEvent,
    event_source_type: record.eventSourceType,
    event_source_id: record.eventSourceId,
    entity_name: record.entityName,
    targeting_type: record.targetingType,
    match_type: record.matchType,
    targeting_secondary: record.targetingSecondary,
    campaign_id: record.campaignId,
    campaign_name: record.campaignName,
    ad_group_id: record.adGroupId,
    ad_group_name: record.adGroupName,
    program_type: record.programType,
    easyhome_portfolio: record.easyhomePortfolio,
    raw_event: record.rawEvent,
    dedupe_key: record.dedupeKey,
  }
}

export type ImportFileOutcome =
  | {
      ok: true
      fileName: string
      written: boolean
      acceptedCount: number
      rejectedCount: number
      insertedCount: number
      updatedCount: number
      dateRangeStart: string | null
      dateRangeEnd: string | null
      isIncomplete: boolean
      incompleteImportWarning: string | null
    }
  | { ok: false; fileName: string; error: string }

/**
 * Imports an already-parsed (ok:true) Change History result for one file.
 * Creates one batch row, then idempotently inserts/updates event rows keyed
 * by dedupe_key — safe to re-run on overlapping files without duplicating.
 */
export async function importParsedChangeHistory(
  admin: SupabaseClient,
  workspaceId: string,
  fileName: string,
  result: Extract<ChangeHistoryParseResult, { ok: true }>,
): Promise<ImportFileOutcome> {
  if (result.accepted.length === 0) {
    return {
      ok: true,
      fileName,
      written: false,
      acceptedCount: 0,
      rejectedCount: result.rejected.length,
      insertedCount: 0,
      updatedCount: 0,
      dateRangeStart: result.stats.dateRangeStart,
      dateRangeEnd: result.stats.dateRangeEnd,
      isIncomplete: result.stats.isIncomplete,
      incompleteImportWarning: null,
    }
  }

  const { data: batch, error: batchError } = await admin
    .from(BATCH_TABLE)
    .insert({
      workspace_id: workspaceId,
      original_filename: fileName,
      from_date: result.stats.dateRangeStart,
      to_date: result.stats.dateRangeEnd,
      total_records: result.stats.totalRowCount,
      imported_count: result.stats.acceptedCount,
      rejected_count: result.stats.rejectedCount,
      page_size: result.stats.pageSize,
      page_offset: result.stats.pageOffset,
      max_page_number: result.stats.maxPageNumber,
      total_records_reported: result.stats.totalRecordsReported,
      is_incomplete: result.stats.isIncomplete,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return { ok: false, fileName, error: 'Upload batch could not be recorded. Confirm migration 041/042 is applied.' }
  }

  const dedupedRows = new Map<string, ReturnType<typeof toRow>>()
  for (const record of result.accepted) {
    const row = toRow(record, workspaceId, batch.id as string)
    dedupedRows.set(row.dedupe_key, row)
  }
  const rows = [...dedupedRows.values()]

  const existingIdByKey = new Map<string, string>()
  for (let page = 0; ; page += 1) {
    const { data: pageRows, error: pageError } = await admin
      .from(TABLE)
      .select('id, dedupe_key')
      .eq('workspace_id', workspaceId)
      .range(page * EXISTING_PAGE_SIZE, page * EXISTING_PAGE_SIZE + EXISTING_PAGE_SIZE - 1)
    if (pageError) {
      return { ok: false, fileName, error: 'Existing change history rows could not be read. Confirm migration 041 is applied.' }
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
      const { error } = await admin.from(TABLE).insert(chunk)
      if (error) throw new Error(error.message)
      insertedCount += chunk.length
    }
    for (let i = 0; i < updateRows.length; i += WRITE_CHUNK_SIZE) {
      const chunk = updateRows.slice(i, i + WRITE_CHUNK_SIZE)
      const { error } = await admin.from(TABLE).upsert(chunk, { onConflict: 'id' })
      if (error) throw new Error(error.message)
    }
  } catch (error) {
    return { ok: false, fileName, error: error instanceof Error ? error.message : 'Change history rows could not be saved.' }
  }

  await admin
    .from(BATCH_TABLE)
    .update({ inserted_count: insertedCount, updated_count: updateRows.length })
    .eq('id', batch.id)

  return {
    ok: true,
    fileName,
    written: true,
    acceptedCount: result.stats.acceptedCount,
    rejectedCount: result.stats.rejectedCount,
    insertedCount,
    updatedCount: updateRows.length,
    dateRangeStart: result.stats.dateRangeStart,
    dateRangeEnd: result.stats.dateRangeEnd,
    isIncomplete: result.stats.isIncomplete,
    incompleteImportWarning: result.stats.isIncomplete
      ? `This import captured only ${result.stats.acceptedCount + result.stats.rejectedCount} of ${result.stats.totalRecordsReported} records Amazon reported (pageSize=${result.stats.pageSize}, pageOffset=${result.stats.pageOffset}). More pages are needed for full coverage of this date range.`
      : null,
  }
}
