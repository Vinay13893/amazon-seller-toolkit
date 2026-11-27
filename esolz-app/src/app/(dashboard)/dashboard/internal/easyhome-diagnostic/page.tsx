import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getInternalAccessContext } from '@/lib/internal-access'
import { EasyhomeDiagnosticDashboard } from './easyhome-diagnostic-dashboard'

export default async function EasyhomeDiagnosticPage() {
  const access = await getInternalAccessContext()

  if (!access.authorized) {
    redirect('/dashboard')
  }

  return <>
    <div className="mx-auto max-w-7xl px-6 pt-4">
      <Link className="text-sm text-blue-700 underline" href="/dashboard/internal/ads-agent">Review Ads shadow recommendations</Link>
    </div>
    <EasyhomeDiagnosticDashboard />
  </>
}
