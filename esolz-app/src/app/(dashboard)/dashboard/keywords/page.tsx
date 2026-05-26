import { Badge } from '@/components/ui/badge'
import { Lock } from 'lucide-react'
import Link from 'next/link'

export default function KeywordsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">Keyword Rank Tracker</h1>
            <Badge className="bg-primary/15 text-primary border-primary/20 text-xs">Starter+</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Track where your ASINs rank for important search keywords.
          </p>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center h-64 rounded-lg border border-dashed border-border gap-4">
        <Lock className="size-8 text-muted-foreground/40" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Starter plan required</p>
          <p className="text-sm text-muted-foreground mt-1">
            <Link href="/dashboard/billing" className="text-primary hover:underline">
              Upgrade to Starter
            </Link>{' '}
            to access Keyword Rank Tracking.
          </p>
        </div>
      </div>
    </div>
  )
}
