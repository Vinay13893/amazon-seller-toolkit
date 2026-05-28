'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard error boundary]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <p className="text-sm text-muted-foreground">Something went wrong loading this page.</p>
      {error.digest && (
        <p className="text-xs text-muted-foreground/60 font-mono">Error ID: {error.digest}</p>
      )}
      <Button type="button" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
