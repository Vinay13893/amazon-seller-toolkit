import { NextResponse } from 'next/server'
import { getStockIntelligenceAccessContext } from '@/lib/stock-intelligence/access'
import { getStockWorksheet } from '@/lib/stock-intelligence/google-sheets'
import { stockSheetsFailure } from '@/lib/stock-intelligence/errors'

export const runtime = 'nodejs'

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function boundedText(value: string | null, maximum: number): string {
  return (value ?? '').trim().slice(0, maximum)
}

export async function GET(request: Request) {
  const access = await getStockIntelligenceAccessContext()
  if (!access.authorized || !access.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const params = new URL(request.url).searchParams
  const title = boundedText(params.get('title'), 120)
  if (!title) return NextResponse.json({ error: 'Worksheet title is required.' }, { status: 400 })
  const sortDirectionRaw = params.get('sortDirection')
  const sortDirection = sortDirectionRaw === 'asc' || sortDirectionRaw === 'desc'
    ? sortDirectionRaw
    : null
  const sortColumnRaw = params.get('sortColumn')
  const sortColumn = sortColumnRaw !== null && /^\d+$/.test(sortColumnRaw)
    ? boundedInteger(sortColumnRaw, 0, 0, 500)
    : null

  try {
    return NextResponse.json(await getStockWorksheet({
      title,
      page: boundedInteger(params.get('page'), 1, 1, 100000),
      pageSize: boundedInteger(params.get('pageSize'), 50, 10, 100),
      search: boundedText(params.get('search'), 120),
      brand: boundedText(params.get('brand'), 120),
      category: boundedText(params.get('category'), 120),
      sortColumn,
      sortDirection,
      refresh: params.get('refresh') === '1',
    }), {
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
