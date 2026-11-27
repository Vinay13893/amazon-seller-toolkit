/** A completed scan can confirm absence as well as a found rank. */
export function isConfirmedKeywordScan(status: string | null | undefined): boolean {
  return status === 'success' || status === 'not_found'
}
