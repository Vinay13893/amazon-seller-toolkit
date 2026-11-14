import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import Link from 'next/link'

export default async function InternalDashboardPage() {
  const access = await getInternalAccessContext()

  if (!access.authorized) {
    redirect('/dashboard')
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold">Brahmastra Internal Dashboard</h1>
        <p className="mt-2 text-muted-foreground">Amazon performance and stock reconciliation, with a clear source for every result.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/dashboard/internal/easyhome-diagnostic" className="rounded-xl border bg-card p-6 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
          <h2 className="text-lg font-semibold">Ads &amp; Sales</h2>
          <p className="mt-2 text-sm text-muted-foreground">Review Amazon Ads performance, Sales &amp; Traffic, and automatic sync status.</p>
          <p className="mt-4 font-medium text-primary">Open Ads &amp; Sales →</p>
        </Link>
        <Link href="/dashboard/internal/stock-intelligence" className="rounded-xl border bg-card p-6 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
          <h2 className="text-lg font-semibold">Stock Reconciliation</h2>
          <p className="mt-2 text-sm text-muted-foreground">Open the existing worksheet-based reconciliation, claims and run health. Results remain read-only.</p>
          <p className="mt-4 font-medium text-primary">Open Stock Reconciliation →</p>
        </Link>
      </div>
      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-semibold">Business-owned data: Unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">Purchase costs, supplier bills and stock outside Amazon do not have a connected source. Profit calculations and off-Amazon replenishment recommendations are unavailable. Historical worksheet records may still be visible; they are not a verified current source for these decisions.</p>
      </section>
    </div>
  )
}
