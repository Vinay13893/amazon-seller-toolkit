import { NextResponse } from 'next/server'
import { logError } from '@/lib/observability/logger'

export const runtime     = 'nodejs'
export const maxDuration = 10

/**
 * POST /api/amazon/sync/listings
 *
 * @deprecated — kept for backward compatibility only.
 * Delegates to /api/amazon/sync/listings/start which creates a resumable job.
 * The frontend should call /start directly.
 */
export async function POST() {
  // Proxy to /start so any old callers still work
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://esolz-app.vercel.app'
  try {
    const res  = await fetch(`${base}/api/amazon/sync/listings/start`, { method: 'POST' })
    const data = await res.json() as Record<string, unknown>
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    logError('amazon-sync-listings', 'Proxy to /start failed', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

