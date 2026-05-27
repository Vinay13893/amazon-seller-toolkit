'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      setDone(true)
      setTimeout(() => router.push('/dashboard/asins'), 2500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="bg-card border border-border rounded-2xl p-8 shadow-xl text-center">
        <div className="flex justify-center mb-4">
          <CheckCircle className="w-12 h-12 text-primary" />
        </div>
        <h1 className="text-xl font-bold mb-2">Password updated</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Your password has been changed successfully.
          <br />
          Redirecting you to the dashboard…
        </p>
        <Link href="/dashboard/asins" className="text-sm text-primary hover:underline font-medium">
          Go to dashboard →
        </Link>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
      <div className="text-center mb-8">
        <Link href="/" className="text-2xl font-black">
          Socio<span className="text-primary">monkey</span>
        </Link>
        <p className="text-muted-foreground text-sm mt-1">Amazon Intelligence</p>
      </div>

      <h1 className="text-xl font-bold mb-2">Set a new password</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Choose a strong password for your account.
      </p>

      <form onSubmit={handleReset} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New Password</Label>
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
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm New Password</Label>
          <Input
            id="confirm"
            type="password"
            placeholder="Repeat your new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
        </div>

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Updating…' : 'Update Password'}
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
