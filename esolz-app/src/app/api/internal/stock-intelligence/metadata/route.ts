import { NextResponse } from 'next/server'
import { getStockIntelligenceAccessContext } from '@/lib/stock-intelligence/access'
import { getStockWorkbookMetadata } from '@/lib/stock-intelligence/google-sheets'
import { stockSheetsFailure } from '@/lib/stock-intelligence/errors'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const access = await getStockIntelligenceAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  try {
    return NextResponse.json(await getStockWorkbookMetadata(refresh), {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    const failure = stockSheetsFailure(error)
    return NextResponse.json(failure.body, {
      status: failure.status,
      headers: { 'cache-control': 'private, no-store' },
    })
  }
}
