'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getBuyBoxDisplayLabel } from '@/lib/checkers/buy-box-display'

type Row = {
  id:string; asin?:string; keyword?:string; paused?:boolean; claimed_at?:string|null;
  next_check_at?:string; last_checked_at?:string|null; last_status?:string|null; last_error?:string|null;
  checked_at?:string; buy_box_detected?:boolean|null; page_status?:string|null; error_code?:string|null; price_text?:string|null;
  seller_name?:string|null; scrape_status?:string; organic_rank?:number|null; sponsored_rank?:number|null;
  tracked_keywords?:{keyword:string}|null;
}
const stamp=(value?:string|null)=>value ? new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : 'Not checked yet'
const words=(value?:string|null)=>(value??'Not confirmed').replaceAll('_',' ')
const field='rounded-md border border-input bg-background px-3 py-2 text-sm'

export function DailyTrackerPanel({kind,selectedAsins=[]}:{kind:'buybox'|'keyword';selectedAsins?:string[]}) {
  const [view,setView]=useState<'watchlist'|'history'>('watchlist')
  const [rows,setRows]=useState<Row[]>([])
  const [total,setTotal]=useState(0)
  const [observedAt,setObservedAt]=useState(0)
  const [offset,setOffset]=useState(0)
  const [search,setSearch]=useState('')
  const [from,setFrom]=useState(''),[through,setThrough]=useState('')
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false)
  const [enabled,setEnabled]=useState(false),[canEdit,setCanEdit]=useState(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState('')
  const load=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true)
    try {
      const p=new URLSearchParams({kind,view,offset:String(offset),search})
      if(from) p.set('from',new Date(`${from}T00:00:00`).toISOString())
      if(through){const end=new Date(`${through}T00:00:00`);end.setDate(end.getDate()+1);p.set('to',end.toISOString())}
      const response=await fetch(`/api/tracking-monitor?${p}`,{cache:'no-store',signal})
      const body=await response.json()
      if(!response.ok)throw new Error(body.error??'Could not load monitoring')
      if(signal?.aborted)return
      setRows(body.items??[]);setTotal(body.total??0);setObservedAt(Date.now());setEnabled(body.enabled);setCanEdit(body.canEdit);setError('')
    }catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'Could not load monitoring')}
    finally{if(!signal?.aborted)setLoading(false)}
  },[kind,view,offset,search,from,through])
  useEffect(()=>{
    const controller=new AbortController()
    const delay=setTimeout(()=>void load(controller.signal),250)
    const timer=setInterval(()=>{if(!document.hidden)void load(controller.signal)},120000)
    return()=>{controller.abort();clearTimeout(delay);clearInterval(timer)}
  },[load])
  async function change(body:object,method='PATCH'){
    setBusy(true);setError('');setNotice('')
    try{const response=await fetch('/api/tracking-monitor',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not save')
      setNotice(method==='POST'?'Saved for daily checks. The first check is queued.':'Tracking updated. Previous history is retained.')
      await load()
    }catch(e){setError(e instanceof Error?e.message:'Could not save')}finally{setBusy(false)}
  }
  const result=(r:Row)=>view==='watchlist'?words(r.last_status):kind==='keyword'?words(r.scrape_status):r.error_code?'Check failed':getBuyBoxDisplayLabel({buy_box_detected:r.buy_box_detected??null,page_status:r.page_status??null})
  function exportRows(){
    const cell=(value:unknown)=>{let s=String(value??'');if(/^[=+@\-\t\r\n]/.test(s))s=`'${s}`;return `"${s.replaceAll('"','""')}"`}
    const csv=[['Product / keyword','Checked at','Result','Organic rank','Sponsored rank','Price','Seller'],...rows.map(r=>[r.keyword??r.asin,r.checked_at,result(r),r.organic_rank,r.sponsored_rank,r.price_text,r.seller_name])].map(r=>r.map(cell).join(',')).join('\r\n')
    const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`${kind}-history.csv`;a.click();URL.revokeObjectURL(url)
  }
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Daily monitoring & history</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{enabled?'Checks run every 24 hours with the browser closed. New requests are picked up within 15 minutes.':'Daily monitoring is not enabled for this workspace.'} {kind==='keyword'?'Adding a tracked keyword also starts daily monitoring.':'Select products above, then save them for daily checks.'}</p>
      {kind==='buybox'&&<p className="mt-1 text-xs text-muted-foreground">A detected Buy Box does not mean your seller account won it. Seller and price observations are saved in History.</p>}</div>
      <Button variant="outline" disabled={loading} onClick={()=>{setNotice('');void load()}}>Refresh saved data</Button></div>
    <div className="flex flex-wrap gap-2"><Button variant={view==='watchlist'?'default':'outline'} onClick={()=>{setView('watchlist');setOffset(0)}}>Daily watchlist</Button><Button variant={view==='history'?'default':'outline'} onClick={()=>{setView('history');setOffset(0)}}>History</Button>
      {kind==='buybox'&&canEdit&&enabled&&<Button disabled={busy||!selectedAsins.length} onClick={()=>void change({asins:selectedAsins},'POST')}>Save selected for daily checks</Button>}</div>
    {error&&<p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm">{error}</p>}
    {notice&&<p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm">{notice}</p>}
    {view==='history'&&<div className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs">{kind==='buybox'?'ASIN':'Keyword'}<input className={field} value={search} onChange={e=>{setSearch(e.target.value);setOffset(0)}} /></label><label className="grid gap-1 text-xs">From<input className={field} type="date" value={from} onChange={e=>{setFrom(e.target.value);setOffset(0)}} /></label><label className="grid gap-1 text-xs">Through<input className={field} type="date" min={from} value={through} onChange={e=>{setThrough(e.target.value);setOffset(0)}} /></label><Button variant="outline" onClick={()=>{setSearch('');setFrom('');setThrough('');setOffset(0)}}>All dates</Button><Button variant="outline" disabled={loading||!rows.length} onClick={exportRows}>Export this page</Button></div>}
    <p className="text-xs text-muted-foreground">{total} {view==='history'?'saved results · newest first':'saved targets'} · times in your local timezone</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[750px] text-left text-sm"><thead className="bg-muted/50"><tr>{[kind==='keyword'?'Keyword / product':'Product',view==='history'?'Checked at':'Last checked','Result',view==='history'?'Details':'Next check',view==='history'?'':'Actions'].map((h,i)=><th key={i} className="p-3 text-xs font-medium">{h}</th>)}</tr></thead><tbody>
      {rows.map(r=><tr key={r.id} className="border-t align-top"><td className="max-w-60 break-words p-3">{r.tracked_keywords?.keyword??r.keyword??r.asin}{r.tracked_keywords&&<p className="text-xs text-muted-foreground">{r.asin}</p>}</td><td className="p-3 text-xs">{stamp(view==='history'?r.checked_at:r.last_checked_at)}</td><td className="p-3 capitalize">{result(r)}{r.last_error&&<p className="max-w-60 text-xs text-muted-foreground">{r.last_error}</p>}</td>
        <td className="p-3 text-xs">{view==='watchlist'?(r.claimed_at?'Checking now':r.paused?'Paused':r.next_check_at&&Date.parse(r.next_check_at)<=observedAt?'Queued for next available run':stamp(r.next_check_at)):kind==='keyword'?`Organic: ${r.organic_rank??'Not confirmed'} · Sponsored: ${r.sponsored_rank??'Not confirmed'}`:`${r.price_text??'Price not confirmed'} · ${r.seller_name??'Seller not confirmed'}`}</td>
        <td className="p-3">{view==='watchlist'&&canEdit&&enabled&&<div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy||!!r.claimed_at} onClick={()=>void change({id:r.id,action:r.paused?'resume':'pause'})}>{r.paused?'Resume':'Pause'}</Button><Button variant="outline" size="sm" disabled={busy||!!r.claimed_at||r.paused} onClick={()=>void change({id:r.id,action:'check'})}>Check now</Button></div>}</td></tr>)}
    </tbody></table>{!rows.length&&<p className="p-6 text-center text-sm text-muted-foreground">{loading?'Loading…':view==='history'?'No saved results match these filters.':kind==='keyword'?'Add a keyword to a product to start daily tracking.':'Select products above and save them for daily checks.'}</p>}</div>
    <div className="flex justify-between"><Button variant="outline" disabled={loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</Button><span className="text-xs">Page {offset/50+1}</span><Button variant="outline" disabled={loading||offset+50>=total} onClick={()=>setOffset(offset+50)}>Next</Button></div>
  </section>
}

