import Link from 'next/link'
import { Mail } from 'lucide-react'

interface Props {
  searchParams: Promise<{ email?: string }>
}

export default async function CheckEmailPage({ searchParams }: Props) {
  const { email } = await searchParams

  return (
    <div className="bg-card border border-border rounded-2xl p-8 shadow-xl text-center max-w-sm mx-auto">
      <div className="mb-6">
        <Link href="/" className="text-2xl font-black">
          Socio<span className="text-primary">monkey</span>
        </Link>
        <p className="text-muted-foreground text-sm mt-1">Amazon Intelligence</p>
      </div>

      <div className="flex justify-center mb-4">
        <div className="bg-primary/10 rounded-full p-4">
          <Mail className="w-8 h-8 text-primary" />
        </div>
      </div>

      <h1 className="text-xl font-bold mb-3">Check your email</h1>

      <p className="text-muted-foreground text-sm mb-2">
        We sent a confirmation link to:
      </p>
      {email && (
        <p className="font-semibold text-sm mb-4 break-all">{email}</p>
      )}
      <p className="text-muted-foreground text-sm mb-6">
        Click the link in that email to activate your account and access your dashboard.
      </p>

      <p className="text-xs text-muted-foreground">
        Already confirmed?{' '}
        <Link href="/login" className="text-primary hover:underline font-medium">
          Sign in
        </Link>
      </p>
    </div>
  )
}
