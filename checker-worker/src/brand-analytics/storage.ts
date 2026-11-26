type WriteError = { code?: string; message?: string }

// A cancelled statement commits no rows. Retry smaller idempotent chunks,
// with a strict lower bound; other errors are never silently retried.
export async function writeSearchTermsBatch<T>(rows: T[],
  write: (rows: T[]) => PromiseLike<{ error: WriteError | null }>,
): Promise<{ error: WriteError | null }> {
  const result = await write(rows)
  if (!result.error || result.error.code !== '57014' || rows.length <= 25) return result
  const middle = Math.ceil(rows.length / 2)
  const first = await writeSearchTermsBatch(rows.slice(0, middle), write)
  if (first.error) return first
  return writeSearchTermsBatch(rows.slice(middle), write)
}

export function rowsAppearStored(exactCount: number | null, summaryCount: number | null): boolean {
  // A successful zero count overrides historical optimistic metadata.
  return (exactCount ?? summaryCount ?? 0) > 0
}
