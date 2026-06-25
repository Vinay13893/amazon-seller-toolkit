import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import { EasyhomeDiagnosticDashboard } from './easyhome-diagnostic-dashboard'

export default async function EasyhomeDiagnosticPage() {
  const access = await getInternalAccessContext()

  if (!access.authorized) {
    redirect('/dashboard')
  }

  return <EasyhomeDiagnosticDashboard />
}
