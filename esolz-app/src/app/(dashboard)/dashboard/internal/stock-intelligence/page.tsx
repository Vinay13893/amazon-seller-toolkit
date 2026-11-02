import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import { StockIntelligenceDashboard } from './stock-intelligence-dashboard'

export default async function StockIntelligencePage() {
  const access = await getInternalAccessContext()
  if (!access.authorized) redirect('/dashboard')
  return <StockIntelligenceDashboard />
}
