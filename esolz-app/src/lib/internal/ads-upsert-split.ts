// Pure insert/update split behind upsertByDedupeKey() in both
// scripts/sync-ads-reports.ts and scripts/poll-pending-reports.ts -- given
// the existing dedupe_key -> id map already read from the DB and the new
// rows to write, decides which rows are brand-new inserts vs which already
// exist and should be updated by id. Extracted so idempotent re-polling
// (the same dedupe_key seen twice, e.g. a manual sync followed by
// poll-pending-reports.ts recovering the same range) is covered by a real
// test independent of any live Supabase call.
export function splitRowsForUpsert<T extends Record<string, unknown>>(
  existingIdByKey: Map<string, string>,
  rows: T[],
): { insertRows: T[]; updateRows: Array<T & { id: string }> } {
  const insertRows: T[] = []
  const updateRows: Array<T & { id: string }> = []
  for (const row of rows) {
    const existingId = existingIdByKey.get(row.dedupe_key as string)
    if (existingId) updateRows.push({ ...row, id: existingId })
    else insertRows.push(row)
  }
  return { insertRows, updateRows }
}
