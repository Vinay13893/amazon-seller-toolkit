import { notFound } from 'next/navigation'
import { getStockIntelligenceAccessContext } from '@/lib/stock-intelligence/access'
import { StockIntelligenceDashboard } from './stock-intelligence-dashboard'

export default async function StockIntelligencePage() {
  const access = await getStockIntelligenceAccessContext()
  if (!access.authorized) notFound()
  return <StockIntelligenceDashboard />
}
