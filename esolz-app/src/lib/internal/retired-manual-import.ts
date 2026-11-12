import { NextResponse } from 'next/server'
import { getInternalAccessContext } from '@/lib/internal-access'

/** Keep old URLs safe: no multipart parsing, file access, Amazon calls or DB writes. */
export async function retiredManualImport() {
  const access = await getInternalAccessContext()
  if (!access.authorized || !access.workspaceId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    code: 'MANUAL_IMPORT_RETIRED',
    error: 'Manual uploads are retired. Check Data & Sync for Amazon API data. Business-owned inputs remain unavailable until an authoritative source is connected.',
  }, { status: 410, headers: { 'Cache-Control': 'private, no-store' } })
}
