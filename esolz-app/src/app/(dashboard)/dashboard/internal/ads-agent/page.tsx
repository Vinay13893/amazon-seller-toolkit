import { redirect } from 'next/navigation'
import { getInternalAccessContext } from '@/lib/internal-access'
import { ShadowReviewInbox } from './shadow-review-inbox'

export default async function AdsAgentReviewPage() {
  const access = await getInternalAccessContext()
  if (!access.authorized) redirect('/dashboard')
  return <ShadowReviewInbox />
}
