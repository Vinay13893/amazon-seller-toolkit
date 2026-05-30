'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

type SignupEmailStatus = 'new' | 'confirmed_existing' | 'unconfirmed_existing'

interface CheckSignupEmailResponse {
  ok: boolean
  status?: SignupEmailStatus
  message: string
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export default function SignupPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [info, setInfo] = useState('')
  const [error, setError] = useState('')
  const [emailStatus, setEmailStatus] = useState<SignupEmailStatus | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = window.setInterval(() => {
      setResendCooldown(prev => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldown])

  async function checkSignupEmail(candidateEmail: string): Promise<CheckSignupEmailResponse> {
    const res = await fetch('/api/auth/check-signup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: candidateEmail }),
    })
    const data = await res.json() as CheckSignupEmailResponse
    return data
  }

  async function handleResendConfirmation() {
    const normalizedEmail = normalizeEmail(email)
    setError('')
    setInfo('')

    if (!isValidEmail(normalizedEmail)) {
      setError('Enter a valid email to resend confirmation.')
      return
    }

    if (resendCooldown > 0) return

    setResending(true)
    try {
      const res = await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      })
      const data = await res.json() as { ok: boolean; message: string }
      if (!res.ok) {
        throw new Error(data.message || 'Unable to resend confirmation right now.')
      }
      setInfo(data.message || "If confirmation is pending, we've sent a new confirmation email.")
      setResendCooldown(60)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to resend confirmation right now.')
    } finally {
      setResending(false)
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setInfo('')
    setEmailStatus(null)

    const normalizedEmail = normalizeEmail(email)

    if (!isValidEmail(normalizedEmail)) {
      setError('Please enter a valid email address.')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setLoading(true)
    try {
      const check = await checkSignupEmail(normalizedEmail)
      if (!check.ok || !check.status) {
        throw new Error(check.message || 'Unable to verify email status. Please try again.')
      }

      if (check.status === 'confirmed_existing') {
        setEmailStatus('confirmed_existing')
        setError(check.message)
        return
      }

      if (check.status === 'unconfirmed_existing') {
        setEmailStatus('unconfirmed_existing')
        setInfo('This email is already registered but not confirmed.')
        return
      }

      const supabase = createClient()
      const { error: signupError } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: { data: { full_name: name, company_name: company } },
      })
      if (signupError) throw signupError
      router.push(`/signup/check-email?email=${encodeURIComponent(normalizedEmail)}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Signup failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
      <div className="text-center mb-8">
        <div className="flex items-center justify-center gap-2.5 mb-1">
          <Image src="/logo.svg" alt="Sociomonkey" width={32} height={32} className="flex-shrink-0" />
          <Link href="/" className="text-2xl font-black">
            Socio<span className="text-primary">monkey</span>
          </Link>
        </div>
        <p className="text-muted-foreground text-sm mt-1">Amazon Intelligence</p>
      </div>

      <h1 className="text-xl font-bold mb-6">Create your free account</h1>
      <p className="text-xs text-muted-foreground -mt-4 mb-5">
        Setup takes under 2 minutes, then you can track your first ASIN and run refresh, Buy Box, pincode, and keyword checks.
      </p>

      <form onSubmit={handleSignup} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Full Name</Label>
          <Input
            id="name"
            type="text"
            placeholder="Your Name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoComplete="name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="company">Company / Brand Name</Label>
          <Input
            id="company"
            type="text"
            placeholder="Your Brand or Company"
            value={company}
            onChange={e => setCompany(e.target.value)}
            autoComplete="organization"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="seller@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="Min. 8 characters"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
        </div>

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
        )}
        {info && (
          <p className="text-sm text-primary bg-primary/10 px-3 py-2 rounded-lg">{info}</p>
        )}

        {emailStatus === 'confirmed_existing' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Button type="button" variant="outline" render={<Link href="/login" />}>
              Login
            </Button>
            <Button type="button" variant="outline" render={<Link href="/forgot-password" />}>
              Forgot Password
            </Button>
          </div>
        )}

        {emailStatus === 'unconfirmed_existing' && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleResendConfirmation}
            disabled={resending || resendCooldown > 0}
          >
            {resending
              ? 'Resending…'
              : resendCooldown > 0
                ? `Resend confirmation (${resendCooldown}s)`
                : 'Resend Confirmation Email'}
          </Button>
        )}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Creating account…' : 'Create Free Account'}
        </Button>

        <div className="text-center">
          <p className="text-xs text-muted-foreground">
            Didn&apos;t receive email?{' '}
            <button
              type="button"
              onClick={handleResendConfirmation}
              className="text-primary hover:underline font-medium"
              disabled={resending || resendCooldown > 0}
            >
              {resendCooldown > 0 ? `Resend confirmation in ${resendCooldown}s` : 'Resend confirmation'}
            </button>
          </p>
        </div>
      </form>

      <p className="text-center text-xs text-muted-foreground mt-4">
        By signing up you agree to our{' '}
        <Link href="#" className="text-primary hover:underline">Terms of Service</Link>
        {' '}and{' '}
        <Link href="#" className="text-primary hover:underline">Privacy Policy</Link>.
      </p>

      <p className="text-center text-sm text-muted-foreground mt-4">
        Already have an account?{' '}
        <Link href="/login" className="text-primary hover:underline font-medium">
          Login
        </Link>
      </p>
    </div>
  )
}
