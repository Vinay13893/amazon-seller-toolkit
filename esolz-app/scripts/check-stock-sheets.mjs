// Run only in a trusted server environment, for example a protected Preview build.
// This invokes the production read-only adapter and logs only counts and safe failures.
if (process.env.VERCEL_ENV !== 'preview' ||
    process.env.VERCEL_GIT_COMMIT_REF !== 'feat/stock-intelligence-integration') process.exit(0)

await import('./stock-sheets-server-marker.mjs')

const { getStockWorkbookMetadata } = await import('../src/lib/stock-intelligence/google-sheets.ts')
const { stockSheetsFailure } = await import('../src/lib/stock-intelligence/errors.ts')
try {
  const metadata = await getStockWorkbookMetadata(true)
  console.log('[stock-intelligence-check]', JSON.stringify({
    status: metadata.status,
    visibleWorksheets: metadata.visibleSheetCount,
    hiddenWorksheets: metadata.hiddenSheetCount,
  }))
} catch (error) {
  stockSheetsFailure(error)
  // Keep the protected Preview available so an operator can test the error UI.
}
