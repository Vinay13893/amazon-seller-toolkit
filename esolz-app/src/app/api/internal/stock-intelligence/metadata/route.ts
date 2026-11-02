import { NextResponse } from 'next/server'
import { getStockIntelligenceAccessContext } from '@/lib/stock-intelligence/access'
import { getStockWorkbookMetadata, StockSheetsError } from '@/lib/stock-intelligence/google-sheets'

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
    if (error instanceof StockSheetsError) {
      return NextResponse.json({
        status: error.code === 'configuration_required' ? 'configuration_required' : 'unavailable',
        message: error.safeMessage,
      }, { status: error.status })
    }
    return NextResponse.json({
      status: 'unavailable',
      message: 'Stock workbook metadata is temporarily unavailable.',
    }, { status: 503 })
  }
}
