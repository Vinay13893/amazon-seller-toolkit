import Link from 'next/link'
import { Users } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function CompetitorsPage() {
  return (
    <div className="bg-card border border-border rounded-xl flex flex-col items-center justify-center gap-4 py-20 px-6 text-center">
      <div className="rounded-full bg-muted p-4">
        <Users className="w-8 h-8 text-muted-foreground" />
      </div>
      <div className="space-y-1.5 max-w-md">
        <h1 className="text-xl font-semibold text-foreground">Competitor Intelligence is coming soon</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Competitor analytics are not available yet. No placeholder metrics are shown.
        </p>
      </div>
      <Button type="button" size="sm" render={<Link href="/dashboard/asins" />}>
        Track My ASINs
      </Button>
    </div>
  )
}
