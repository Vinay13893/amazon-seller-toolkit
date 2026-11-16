// Release-only preflight: credentials stay in Vercel; output contains counts only.
// Reads Google Sheets through the same read-only adapter as the dashboard.
import './stock-sheets-server-marker.mjs'
const { getStockWorkbookMetadata, getStockWorksheet } = await import('../src/lib/stock-intelligence/google-sheets.ts')
const { stockSheetsFailure } = await import('../src/lib/stock-intelligence/errors.ts')
try {
  const metadata = await getStockWorkbookMetadata(true)
  console.log('[stock-release]', JSON.stringify({ authentication: 'success', visibleWorksheets: metadata.visibleSheetCount }))
  const titles = ['Today', 'Stock Reconciliation', 'Hub Planner', 'Packing List', 'Claims to Check', 'Run Health', 'Case Messages']
  for (const title of titles) {
    if (!metadata.worksheets.some(sheet => sheet.title === title)) throw new Error('Required worksheet missing')
    const input = { title, page: 1, pageSize: 50, search: '', brand: '', category: '', sortColumn: null, sortDirection: null, refresh: false }
    const data = await getStockWorksheet(input)
    if (data.status !== 'ready' || data.warning) throw new Error('Incomplete worksheet')
    if (title === 'Case Messages') {
      const last = await getStockWorksheet({ ...input, page: data.totalPages })
      console.log('[stock-release]', JSON.stringify({ worksheet: title, dataRows: data.totalRows, lastSourceRow: last.rowNumbers.at(-1), lastPageRows: last.rows.length }))
    }
    // Keep this preflight below per-user read quotas, including multi-range worksheets.
    await new Promise(resolve => setTimeout(resolve, 6000))
  }
  console.log('[stock-release]', JSON.stringify({ criticalWorksheetsChecked: titles.length, result: 'passed', mode: 'read-only' }))
} catch (error) {
  stockSheetsFailure(error)
  process.exitCode = 1
}
