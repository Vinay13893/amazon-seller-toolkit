import { Badge } from '@/components/ui/badge'
import { Lock } from 'lucide-react'
import Link from 'next/link'

export default function BuyboxPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">Buy Box Monitor</h1>
          <Badge className="bg-orange-500/15 text-orange-400 border-orange-500/20 text-xs">Pro+</Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Get instant alerts when you win or lose the Buy Box.
        </p>
      </div>
      <div className="flex flex-col items-center justify-center h-64 rounded-lg border border-dashed border-border gap-4">
        <Lock className="size-8 text-muted-foreground/40" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Pro plan required</p>
          <p className="text-sm text-muted-foreground mt-1">
            <Link href="/dashboard/billing" className="text-primary hover:underline">
              Upgrade to Pro
            </Link>{' '}
            to access Buy Box monitoring.
          </p>
        </div>
      </div>
    </div>
  )
}
