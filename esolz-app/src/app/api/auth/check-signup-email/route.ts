import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

type SignupEmailStatus = 'new' | 'confirmed_existing' | 'unconfirmed_existing'

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function statusMessage(status: SignupEmailStatus): string {
  if (status === 'confirmed_existing') {
    return 'An account already exists with this email. Please log in or reset your password.'
  }
  if (status === 'unconfirmed_existing') {
    return 'This email is already registered but not confirmed. You can resend the confirmation email.'
  }
  return 'You can continue signup.'
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

    const admin = createAdminClient()

    let page = 1
    const perPage = 1000
    let foundStatus: SignupEmailStatus = 'new'

    // MVP-safe lookup: iterate paginated auth users and stop on first email match.
    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
      if (error) {
        throw new Error(error.message)
      }

      const users = data?.users ?? []
      const found = users.find((u) => (u.email ?? '').toLowerCase() === email)

      if (found) {
        foundStatus = found.email_confirmed_at ? 'confirmed_existing' : 'unconfirmed_existing'
        break
      }

      if (users.length < perPage) break
      page += 1
    }

    return NextResponse.json({
      ok: true,
      status: foundStatus,
      message: statusMessage(foundStatus),
    })
  } catch {
    return NextResponse.json(
      { ok: false, message: 'Unable to verify email right now. Please try again.' },
      { status: 500 },
    )
  }
}
