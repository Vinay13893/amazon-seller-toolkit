'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const supabase = createClient()
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      })
      if (resetError) throw resetError
      setSent(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="bg-card border border-border rounded-2xl p-8 shadow-xl text-center">
        <div className="flex justify-center mb-4">
          <CheckCircle className="w-12 h-12 text-primary" />
        </div>
        <h1 className="text-xl font-bold mb-2">Check your inbox</h1>
        <p className="text-sm text-muted-foreground mb-6">
          We&apos;ve sent a password reset link to{' '}
          <span className="font-medium text-foreground">{email}</span>.
          <br />
          Click the link in the email to set a new password.
        </p>
        <Link
          href="/login"
          className="text-sm text-primary hover:underline font-medium"
        >
          ← Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
      <div className="text-center mb-8">
        <Link href="/" className="text-2xl font-black">
          e-<span className="text-primary">Solz</span>
        </Link>
        <p className="text-muted-foreground text-sm mt-1">Amazon Seller Intelligence</p>
      </div>

      <h1 className="text-xl font-bold mb-2">Reset your password</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Enter your account email and we&apos;ll send you a reset link.
      </p>

      <form onSubmit={handleReset} className="space-y-4">
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

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Sending…' : 'Send Reset Link'}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground mt-6">
        Remember your password?{' '}
        <Link href="/login" className="text-primary hover:underline font-medium">
          Sign in
        </Link>
      </p>
    </div>
  )
}
