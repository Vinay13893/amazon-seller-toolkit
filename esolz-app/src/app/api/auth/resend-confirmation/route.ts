import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

const GENERIC_MESSAGE = "If confirmation is pending, we've sent a new confirmation email."
const COOLDOWN_MS = 60_000

const lastResendByEmail = new Map<string, number>()

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { email?: string }
    const email = normalizeEmail(body.email ?? '')

    if (!email || !isValidEmail(email)) {
      return NextResponse.json(
        { ok: false, message: 'Please enter a valid email address.' },
        { status: 400 },
      )
    }

    const now = Date.now()
    const lastSentAt = lastResendByEmail.get(email) ?? 0
    if (now - lastSentAt < COOLDOWN_MS) {
      return NextResponse.json({ ok: true, message: GENERIC_MESSAGE })
    }

    const admin = createAdminClient()
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin

    await admin.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${appUrl}/auth/callback?next=/dashboard/asins`,
      },
    })

    lastResendByEmail.set(email, now)

    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE })
  } catch {
    return NextResponse.json(
      { ok: true, message: GENERIC_MESSAGE },
      { status: 200 },
    )
  }
}
