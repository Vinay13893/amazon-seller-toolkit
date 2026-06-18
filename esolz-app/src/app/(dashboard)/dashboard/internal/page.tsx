import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import { InternalStockDashboard } from './stock-dashboard'

export default async function InternalDashboardPage() {
  const access = await getInternalAccessContext()

  if (!access.authorized) {
    redirect('/dashboard')
  }

  return <InternalStockDashboard />
}
