'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Download, Loader2, Play, RefreshCw, ShoppingCart, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type JobStatus = 'queued' | 'running' | 'done' | 'failed'

type BuyBoxJob = {
  id: string
  jobType: string
  status: JobStatus
  progressCurrent: number
  progressTotal: number
  resultSummary: {
    total?: number
    buyBoxDetected?: number
    notDetected?: number
    unknown?: number
  } | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

type BuyBoxResult = {
  asin: string
  buy_box_detected: boolean | null
  price_detected: boolean | null
  price_text: string | null
  seller_name: string | null
  availability_status: string | null
  page_status: string | null
  error_code: string | null
  error_message: string | null
  checked_at: string | null
}

type JobResponse = {
  success: boolean
  job?: BuyBoxJob
  results?: BuyBoxResult[]
  errorCode?: string
  message?: string
}

type TriggerResponse = {
  success: boolean
  errorCode?: string
  message?: string
  workerStatus?: string | null
}

const MAX_ASINS = 10

function parseAsins(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\s,]+/)
      .map(item => item.trim().toUpperCase())
      .filter(item => /^[A-Z0-9]{10}$/.test(item)),
  ))
}

function resultTone(result: BuyBoxResult) {
  if (result.buy_box_detected === true) return 'text-emerald-500'
  if (result.buy_box_detected === false && result.page_status === 'product') return 'text-red-500'
  if (result.page_status === 'blocked') return 'text-amber-500'
  return 'text-muted-foreground'
}

function resultIcon(result: BuyBoxResult) {
  if (result.buy_box_detected === true) return CheckCircle2
  if (result.buy_box_detected === false && result.page_status === 'product') return XCircle
  if (result.page_status === 'blocked') return AlertTriangle
  return Clock
}

function cleanPipeSeparatedText(value: string | null): string | null {
  if (!value) return null
  const cleaned = Array.from(new Set(
    value
      .split('|')
      .map(part => part.trim())
      .filter(Boolean),
  )).join(' | ')
  return cleaned || null
}

function formatPrice(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/[₹$€£]/.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return `₹${Number(trimmed).toLocaleString('en-IN')}`
  }
  return trimmed
}

function reasonLabel(result: BuyBoxResult): string {
  if (result.error_code) return result.error_code
  if (result.page_status === 'blocked') return 'blocked_or_captcha'
  return 'No issue reported'
}

export default function BuyBoxMonitorPage() {
  const [asinText, setAsinText] = useState('')
  const [job, setJob] = useState<BuyBoxJob | null>(null)
  const [results, setResults] = useState<BuyBoxResult[]>([])
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const asins = useMemo(() => parseAsins(asinText), [asinText])
  const limitError = asins.length > MAX_ASINS ? `Use ${MAX_ASINS} ASINs or fewer.` : null
  const progressPercent = job?.progressTotal
    ? Math.round((job.progressCurrent / job.progressTotal) * 100)
    : 0

  async function readJson(res: Response): Promise<JobResponse> {
    const body = await res.json().catch(() => null)
    return body && typeof body === 'object' ? body as JobResponse : { success: false, message: `HTTP ${res.status}` }
  }

  async function pollJob(jobId = job?.id) {
    if (!jobId) return
    setPolling(true)
    setError(null)
    try {
      const res = await fetch(`/api/scraping/buy-box/jobs/${jobId}`)
      const body = await readJson(res)
      if (!res.ok || !body.success || !body.job) {
        setError(body.errorCode ?? body.message ?? 'job_status_failed')
        return
      }
      setJob(body.job)
      setResults(body.results ?? [])
    } catch {
      setError('job_status_failed')
    } finally {
      setPolling(false)
    }
  }

  async function startJob() {
    setLoading(true)
    setError(null)
    setNotice(null)
    setResults([])

    try {
      const res = await fetch('/api/scraping/buy-box/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: 'A21TJRUUN4KGV',
          asins,
        }),
      })
      const body = await readJson(res)
      if (!res.ok || !body.success || !body.job) {
        setError(body.errorCode ?? body.message ?? 'job_create_failed')
        return
      }
      setJob(body.job)

      const triggerRes = await fetch(`/api/scraping/buy-box/jobs/${body.job.id}/run`, {
        method: 'POST',
      })
      const triggerBody = await readJson(triggerRes) as TriggerResponse
      if (!triggerRes.ok || !triggerBody.success) {
        setNotice(triggerBody.errorCode === 'worker_trigger_not_configured'
          ? 'Job queued. Worker trigger is not configured yet.'
          : 'Job queued. Worker trigger failed safely; refresh after the worker runs.')
      } else {
        setNotice('Job queued and worker trigger accepted.')
      }

      await pollJob(body.job.id)
    } catch {
      setError('job_create_failed')
    } finally {
      setLoading(false)
    }
  }

  async function downloadCsv() {
    if (!job?.id) return
    setExporting(true)
    setError(null)

    try {
      const res = await fetch(`/api/scraping/buy-box/jobs/${job.id}/export`)
      if (!res.ok) {
        const body = await readJson(res)
        setError(body.errorCode ?? body.message ?? 'csv_export_failed')
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `buy-box-${job.id.slice(0, 8)}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError('csv_export_failed')
    } finally {
      setExporting(false)
    }
  }

  async function clearCurrentResults() {
    if (!job?.id) return
    setClearing(true)
    setError(null)
    setNotice(null)

    try {
      const res = await fetch(`/api/scraping/buy-box/jobs/${job.id}`, {
        method: 'DELETE',
      })
      const body = await readJson(res)
      if (!res.ok || !body.success) {
        setError(body.errorCode ?? body.message ?? 'clear_job_failed')
        return
      }
      setJob(null)
      setResults([])
      setNotice('Current Buy Box results cleared.')
    } catch {
      setError('clear_job_failed')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShoppingCart className="size-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Buy Box Monitor</h1>
          <Badge variant="secondary" className="h-5 text-[10px]">Queue beta</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Check whether tracked Amazon products show a buy box, visible price, seller, and availability signal.
        </p>
        <p className="max-w-3xl text-xs text-muted-foreground">
          Max 10 ASINs per job. No raw HTML, screenshots, cookies, or page dumps are stored.
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-border bg-card p-5">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">ASINs</span>
            <textarea
              value={asinText}
              onChange={event => setAsinText(event.target.value)}
              rows={6}
              placeholder="Enter up to 10 ASINs"
              className="min-h-36 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <span className={cn('text-xs', limitError ? 'text-red-400' : 'text-muted-foreground')}>
              {asins.length}/{MAX_ASINS} valid ASINs
            </span>
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={startJob}
              disabled={loading || asins.length === 0 || Boolean(limitError)}
              className="gap-2"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Start check
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => pollJob()}
              disabled={polling || !job?.id}
              className="gap-2"
            >
              {polling ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh status
            </Button>
            <span className="text-xs text-muted-foreground">Worker concurrency stays conservative.</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs font-medium uppercase text-muted-foreground">Job progress</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-2xl font-semibold text-foreground">{job?.status ?? 'not started'}</p>
              <p className="text-sm text-muted-foreground">
                {job ? `${job.progressCurrent} of ${job.progressTotal} checks processed` : 'Create a queue job to begin.'}
              </p>
            </div>
            <Badge variant="outline" className="capitalize">{job?.status ?? 'idle'}</Badge>
          </div>
          <div className="mt-4 h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Processed</p>
              <p className="font-semibold text-foreground">{job ? `${job.progressCurrent}/${job.progressTotal}` : '0/0'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Detected</p>
              <p className="font-semibold text-foreground">{job?.resultSummary?.buyBoxDetected ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Not detected</p>
              <p className="font-semibold text-foreground">{job?.resultSummary?.notDetected ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unknown</p>
              <p className="font-semibold text-foreground">{job?.resultSummary?.unknown ?? 0}</p>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Buy Box API failed: {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="font-semibold text-foreground">Results</h2>
            <p className="text-xs text-muted-foreground">Structured fields only. No raw HTML, screenshots, cookies, or page dumps are stored.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={downloadCsv}
              disabled={exporting || !job?.id || results.length === 0}
              className="gap-2"
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Download CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearCurrentResults}
              disabled={clearing || !job?.id}
              className="gap-2"
            >
              {clearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Clear current results
            </Button>
            <Badge variant="secondary">{results.length} rows</Badge>
          </div>
        </div>

        {results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Clock className="size-7 opacity-40" />
            <p className="text-sm">Results will appear after the worker processes the queued job.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-5 py-3 text-left font-medium">ASIN</th>
                  <th className="px-4 py-3 text-left font-medium">Buy Box</th>
                  <th className="px-4 py-3 text-left font-medium">Price</th>
                  <th className="px-4 py-3 text-left font-medium">Seller</th>
                  <th className="px-4 py-3 text-left font-medium">Availability</th>
                  <th className="px-4 py-3 text-left font-medium">Reason</th>
                  <th className="px-5 py-3 text-left font-medium">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {results.map((result, index) => {
                  const Icon = resultIcon(result)
                  return (
                    <tr key={`${result.asin}-${index}`} className="hover:bg-muted/20">
                      <td className="px-5 py-3 font-mono text-xs text-foreground">{result.asin}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', resultTone(result))}>
                          <Icon className="size-3.5" />
                          {result.buy_box_detected === true ? 'Detected' : result.buy_box_detected === false ? 'Not detected' : 'Unknown'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{result.price_detected ? formatPrice(result.price_text) ?? 'Detected' : 'Not detected'}</td>
                      <td className="max-w-[260px] px-4 py-3 text-xs text-muted-foreground">{cleanPipeSeparatedText(result.seller_name) ?? 'Not detected'}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground capitalize">{result.availability_status ?? 'unknown'}</td>
                      <td className="max-w-[280px] px-4 py-3 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{reasonLabel(result)}</span>
                        {result.error_message && <span className="mt-1 line-clamp-2 block">{result.error_message}</span>}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">
                        {result.checked_at ? new Date(result.checked_at).toLocaleString() : 'Not checked'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
