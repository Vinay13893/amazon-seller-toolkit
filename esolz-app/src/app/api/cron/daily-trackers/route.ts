import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { POST as refreshKeywords } from '@/app/api/keywords/refresh/route'

export const runtime = 'nodejs'
export const maxDuration = 240

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const actual = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret ?? ''}`
  if (!secret || Buffer.byteLength(actual)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) {
    return NextResponse.json({error:'Unauthorized'},{status:401})
  }
  const workspaces = (process.env.DAILY_TRACKER_WORKSPACE_IDS ?? '').split(',').map(s=>s.trim()).filter(s=>/^[0-9a-f-]{36}$/i.test(s))
  if (!workspaces.length) return NextResponse.json({status:'disabled'})
  if (!process.env.CHECKER_WORKER_URL || !process.env.CHECKER_WORKER_SECRET || !process.env.BACKGROUND_WORKER_SECRET) {
    return NextResponse.json({error:'Checker configuration unavailable'},{status:503})
  }
  const db = createAdminClient()
  const started = Date.now()
  let processed=0, confirmed=0
  try {
    while(processed<4 && Date.now()-started<140000) {
      const {data:claims,error} = await db.rpc('claim_daily_tracker',{p_workspaces:workspaces})
      if(error) throw error
      const target=claims?.[0]
      if(!target) break
      let status='failed'
      try {
        if(target.kind==='keyword') {
          const result=await refreshKeywords(new NextRequest('https://internal.invalid/api/keywords/refresh',{
            method:'POST',headers:{'content-type':'application/json','x-background-worker-secret':process.env.BACKGROUND_WORKER_SECRET},
            body:JSON.stringify({workspaceId:target.workspace_id,keywordIds:[target.tracked_keyword_id]}),
          }))
          const body=await result.json()
          const scan=body.results?.[0]?.scan_status
          if(result.ok && ['success','not_found'].includes(scan)) status=scan
        } else {
          let jobId=target.job_id
          const previous=jobId ? await db.from('scraping_jobs').select('status,completed_at,locked_at').eq('id',jobId).eq('workspace_id',target.workspace_id).maybeSingle() : null
          if(previous?.error) throw previous.error
          if(previous?.data?.status==='running' && previous.data.locked_at && Date.parse(previous.data.locked_at)<Date.now()-600000) {
            const {error:recoverError}=await db.from('scraping_jobs').update({status:'queued',locked_at:null,locked_by:null})
              .eq('id',jobId).eq('workspace_id',target.workspace_id).eq('status','running').lt('locked_at',new Date(Date.now()-600000).toISOString())
            if(recoverError) throw recoverError
          }
          if(!previous?.data || (previous.data.completed_at && target.last_checked_at && Date.parse(previous.data.completed_at)<=Date.parse(target.last_checked_at))) {
            const {data:job,error:jobError}=await db.from('scraping_jobs').insert({workspace_id:target.workspace_id,job_type:'BUY_BOX_CHECK',status:'queued',
              payload:{marketplaceId:target.marketplace_id,asins:[target.asin]},progress_current:0,progress_total:1}).select('id').single()
            if(jobError) throw jobError
            jobId=job.id
            const {error:saveError}=await db.from('daily_tracker_targets').update({job_id:jobId}).eq('id',target.id).eq('claim_token',target.claim_token)
            if(saveError) throw saveError
          }
          // The worker atomically locks jobs; retries of this dispatch do not duplicate a completed job.
          await fetch(`${process.env.CHECKER_WORKER_URL.replace(/\/$/,'')}/scraping/run-next`,{
            method:'POST',headers:{'content-type':'application/json','x-checker-secret':process.env.CHECKER_WORKER_SECRET},
            body:JSON.stringify({jobId}),signal:AbortSignal.timeout(80000),
          }).catch(()=>null)
          const {data:result,error:resultError}=await db.from('buy_box_results').select('buy_box_detected,page_status,error_code')
            .eq('workspace_id',target.workspace_id).eq('job_id',jobId).order('checked_at',{ascending:false}).limit(1).maybeSingle()
          if(resultError) throw resultError
          if(result && !result.error_code && result.page_status==='product' && typeof result.buy_box_detected==='boolean') status=result.buy_box_detected ? 'detected' : 'not_detected'
          if(!result) {
            const {error:historyError}=await db.from('buy_box_results').insert({job_id:jobId,workspace_id:target.workspace_id,
              marketplace_id:target.marketplace_id,asin:target.asin,buy_box_detected:null,price_detected:null,
              page_status:'failed',error_code:'checker_unavailable',error_message:'The scheduled check did not confirm a result.',checked_at:new Date().toISOString()})
            if(historyError) throw historyError
          }
        }
      } catch { /* Store an honest failure; never interpret infrastructure errors as lost rank or Buy Box. */ }
      const now=new Date()
      const {data:updated,error:saveError}=await db.from('daily_tracker_targets').update({
        last_checked_at:now.toISOString(),last_status:status,last_error:status==='failed'?'The check could not confirm a result. Previous history is retained.':null,
        next_check_at:new Date(now.getTime()+86400000).toISOString(),claim_token:null,claimed_at:null,
      }).eq('id',target.id).eq('claim_token',target.claim_token).select('id')
      if(saveError || !updated?.length) throw new Error('finalize_failed')
      processed++; if(status!=='failed') confirmed++
    }
    console.info('[daily-trackers]',{processed,confirmed})
    return NextResponse.json({status:'ok',processed,confirmed})
  } catch {
    console.error('[daily-trackers] scheduler_failed')
    return NextResponse.json({error:'Scheduled check failed',processed,confirmed},{status:503})
  }
}
