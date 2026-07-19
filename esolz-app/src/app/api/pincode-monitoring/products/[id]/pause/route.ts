import { NextRequest } from 'next/server'
import { handlePauseResume } from '@/lib/pincode-monitoring/pause-resume-handler'

export const runtime = 'nodejs'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handlePauseResume(request, id, 'pause')
}
