// Run only in a trusted server environment, for example a protected Preview build.
// This invokes the production read-only adapter and logs only counts and safe failures.
import { registerHooks } from 'node:module'

if (process.env.VERCEL_ENV !== 'preview' ||
    process.env.VERCEL_GIT_COMMIT_REF !== 'feat/stock-intelligence-integration') process.exit(0)

// Next supplies this marker at bundling time. This CLI is also server-only.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return nextResolve('next/dist/compiled/server-only/empty.js', context)
    return nextResolve(specifier, context)
  },
})

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
  if (error?.stage === 'jwt_signing') {
    const raw = (process.env.GOOGLE_STOCK_SHEETS_PRIVATE_KEY ?? '').trim()
    let code = 'invalid_pem_encoding'
    if (raw.startsWith('{')) code = 'json_object_in_pem_field'
    else if (/^["']/.test(raw)) code = 'quoted_pem'
    else if (raw.includes('\\\\n')) code = 'double_escaped_newlines'
    else if (!raw.startsWith('-----BEGIN PRIVATE KEY-----') || !raw.includes('-----END PRIVATE KEY-----')) code = 'missing_pem_boundary'
    else if (!raw.replaceAll('\\n', '\n').includes('\n')) code = 'missing_pem_line_breaks'
    console.error('[stock-intelligence-check]', JSON.stringify({ stage: 'jwt_signing', code }))
  }
  // Keep the protected Preview available so an operator can test the error UI.
}
