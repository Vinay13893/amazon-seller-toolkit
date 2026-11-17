import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { marketplaceFromMarketplaceId } from '@/lib/asins/product-separation'
import { resolveAsinProductDomains } from '@/lib/asins/product-domain'

export const runtime = 'nodejs'
async function context(write = false) {
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return null
  const { data } = await db.from('workspace_members').select('workspace_id,role').eq('user_id', user.id).limit(1).maybeSingle()
  if (!data || !['owner','admin','member','viewer'].includes(data.role) || (write && data.role === 'viewer')) return null
  return { workspaceId: data.workspace_id, canEdit: data.role !== 'viewer' }
}
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status })
const allowed = (workspace: string) => (process.env.DAILY_TRACKER_WORKSPACE_IDS ?? '').split(',').map(s=>s.trim()).includes(workspace)

export async function GET(request: NextRequest) {
  const ctx = await context()
  if (!ctx) return fail('Unauthorized', 401)
  const p = request.nextUrl.searchParams
  const kind = p.get('kind')
  if (kind !== 'buybox' && kind !== 'keyword') return fail('Invalid tracker')
  const offset = Math.min(100000,Math.max(0,Number.parseInt(p.get('offset') ?? '0',10)||0))
  const db = createAdminClient()
  if (p.get('view') === 'history') {
    const search = (p.get('search') ?? '').trim().slice(0,100).replace(/[%_]/g,'')
    const from = p.get('from'), to = p.get('to')
    if ([from,to].some(x=>x && !Number.isFinite(Date.parse(x)))) return fail('Invalid date')
    let query = kind === 'buybox'
      ? db.from('buy_box_results').select('id,asin,checked_at,buy_box_detected,price_text,seller_name,error_code,page_status',{count:'exact'}).eq('workspace_id',ctx.workspaceId)
      : db.from('keyword_rank_snapshots').select('id,keyword,checked_at,organic_rank,sponsored_rank,scrape_status,error_message',{count:'exact'}).eq('workspace_id',ctx.workspaceId)
    if (search) query = query.ilike(kind === 'buybox' ? 'asin' : 'keyword',`%${search}%`)
    if (from) query = query.gte('checked_at',new Date(from).toISOString())
    if (to) query = query.lt('checked_at',new Date(to).toISOString())
    const { data,error,count } = await query.order('checked_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+49)
    if (error) return fail('History could not be loaded',503)
    return NextResponse.json({ items:data,total:count,canEdit:ctx.canEdit,enabled:allowed(ctx.workspaceId) },{headers:{'Cache-Control':'no-store'}})
  }
  const { data,error,count } = await db.from('daily_tracker_targets')
    .select('id,asin,source_key,marketplace_id,paused,next_check_at,last_checked_at,last_status,last_error,claimed_at,tracked_keywords(keyword)',{count:'exact'})
    .eq('workspace_id',ctx.workspaceId).eq('kind',kind).order('created_at').range(offset,offset+49)
  if (error) return fail('Daily tracking could not be loaded',503)
  const targets = data ?? []
  if (!targets.length) {
    return NextResponse.json({items:targets,total:count,canEdit:ctx.canEdit,enabled:allowed(ctx.workspaceId)},{headers:{'Cache-Control':'no-store'}})
  }

  const asins = [...new Set(targets.map(row=>row.asin))]
  const marketplaceIds = [...new Set(targets.map(row=>row.marketplace_id))]
  const [catalogResult,trackedResult] = await Promise.all([
    db.from('amazon_listing_items')
      .select('id,asin,marketplace_id,sku,item_name,brand,product_type,image_url')
      .eq('workspace_id',ctx.workspaceId).in('asin',asins).in('marketplace_id',marketplaceIds),
    db.from('tracked_asins')
      .select('id,asin,marketplace,status,product_title,brand,category,image_url')
      .eq('workspace_id',ctx.workspaceId).in('asin',asins).neq('status','archived'),
  ])
  const products = resolveAsinProductDomains({
    catalogRows: catalogResult.data ?? [],
    trackedRows: trackedResult.data ?? [],
    catalogUnavailable: Boolean(catalogResult.error),
    trackedUnavailable: Boolean(trackedResult.error),
  })
  const ownByKey = new Map(products.myProducts.map(product=>[`${product.marketplaceId}:${product.asin}`,product]))
  const competitorByKey = new Map(products.competitorProducts.map(product=>[`${product.marketplace}:${product.asin}`,product]))
  const items = targets.map(target=>{
    const own = ownByKey.get(`${target.marketplace_id}:${target.asin}`)
    const competitor = competitorByKey.get(`${marketplaceFromMarketplaceId(target.marketplace_id)}:${target.asin}`)
    const product = own ?? competitor
    return {
      ...target,
      product_title: product?.title ?? null,
      product_image_url: product?.imageUrl ?? null,
      product_source: product?.domain ?? null,
      skus: product?.domain === 'my' ? product.skus : [],
      product_identity_status: catalogResult.error || (!own && trackedResult.error) ? 'unavailable' : product ? 'found' : 'not_found',
    }
  })
  return NextResponse.json({items,total:count,canEdit:ctx.canEdit,enabled:allowed(ctx.workspaceId)},{headers:{'Cache-Control':'no-store'}})
}

export async function POST(request: NextRequest) {
  const ctx = await context(true)
  if (!ctx) return fail('You do not have permission to change tracking',403)
  if (!allowed(ctx.workspaceId)) return fail('Daily monitoring is not enabled for this workspace',403)
  const body = await request.json().catch(()=>null)
  if (!body || !Array.isArray(body.asins) || body.asins.length<1 || body.asins.length>10 ||
    body.asins.some((a: unknown)=>typeof a!=='string' || !/^[A-Z0-9]{10}$/.test(a))) return fail('Select 1–10 valid products')
  const asins: string[] = Array.from(new Set(body.asins))
  const db = createAdminClient()
  const [own,other] = await Promise.all([
    db.from('amazon_listing_items').select('asin').eq('workspace_id',ctx.workspaceId).eq('marketplace_id','A21TJRUUN4KGV').in('asin',asins),
    db.from('tracked_asins').select('asin').eq('workspace_id',ctx.workspaceId).in('marketplace',['IN','amazon.in','A21TJRUUN4KGV']).neq('status','archived').in('asin',asins),
  ])
  if (own.error || other.error) return fail('Could not verify products',503)
  const verified = new Set([...(own.data??[]),...(other.data??[])].map(r=>r.asin))
  if (asins.some(a=>!verified.has(a))) return fail('Products must belong to your catalogue or tracked competitor list',403)
  // Repeated saves do not unpause a seller-paused target or reset its schedule.
  const { error } = await db.from('daily_tracker_targets').upsert(asins.map(asin=>({workspace_id:ctx.workspaceId,kind:'buybox',source_key:asin,asin})),
    {onConflict:'workspace_id,kind,source_key',ignoreDuplicates:true})
  return error ? fail('Could not save daily tracking',503) : NextResponse.json({saved:true})
}

export async function PATCH(request: NextRequest) {
  const ctx = await context(true)
  if (!ctx) return fail('You do not have permission to change tracking',403)
  if (!allowed(ctx.workspaceId)) return fail('Daily monitoring is not enabled for this workspace',403)
  const body = await request.json().catch(()=>null)
  if (!body || typeof body.id!=='string' || !/^[0-9a-f-]{36}$/i.test(body.id) || !['pause','resume','check'].includes(body.action)) return fail('Invalid action')
  const db = createAdminClient()
  const {data:target,error:readError} = await db.from('daily_tracker_targets').select('id,paused,claimed_at,last_checked_at')
    .eq('id',body.id).eq('workspace_id',ctx.workspaceId).maybeSingle()
  if(readError) return fail('Could not load tracking',503)
  if(!target) return fail('Tracking not found',404)
  if(target.claimed_at) return fail('A check is running. Try again after it finishes.',409)
  if(body.action==='check' && (target.paused || (target.last_checked_at && Date.now()-Date.parse(target.last_checked_at)<300000))) return fail('Resume tracking or wait five minutes after the last check',429)
  const update = body.action==='pause' ? {paused:true} : {paused:false,next_check_at:new Date().toISOString()}
  const {data,error} = await db.from('daily_tracker_targets').update(update).eq('id',target.id).eq('workspace_id',ctx.workspaceId).is('claimed_at',null).select('id')
  return error ? fail('Could not update tracking',503) : !data?.length ? fail('A check just started. Try again shortly.',409) : NextResponse.json({saved:true})
}
