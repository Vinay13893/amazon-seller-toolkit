import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import { AdsExplorer } from './ads-explorer'

export default async function AdsExplorerPage() {
  const access = await getInternalAccessContext()
  if (!access.authorized) redirect('/dashboard')
  return <AdsExplorer />
}
