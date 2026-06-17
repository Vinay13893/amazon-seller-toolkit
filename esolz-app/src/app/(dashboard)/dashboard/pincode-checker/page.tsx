'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, MapPin, Play, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type JobStatus = 'queued' | 'running' | 'done' | 'failed'

type PincodeJob = {
  id: string
  jobType: string
  status: JobStatus
  progressCurrent: number
  progressTotal: number
  resultSummary: {
    total?: number
    available?: number
    unavailable?: number
    unknown?: number
  } | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

type PincodeResult = {
  asin: string
  pincode: string
  availability_status: string | null
  delivery_message_category: string | null
  delivery_message: string | null
  price_detected: boolean | null
  buy_box_detected: boolean | null
  seller_name: string | null
  checked_at: string | null
  error_code: string | null
  error_message: string | null
}

type JobResponse = {
  success: boolean
  job?: PincodeJob
  results?: PincodeResult[]
  errorCode?: string
  message?: string
}

type TriggerResponse = {
  success: boolean
  errorCode?: string
  message?: string
  workerStatus?: string | null
}

const DEFAULT_PINCODES = '110001\n560001'

function parseAsins(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\s,]+/)
      .map(item => item.trim().toUpperCase())
      .filter(item => /^[A-Z0-9]{10}$/.test(item)),
  )).slice(0, 3)
}

function parsePincodes(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\s,]+/)
      .map(item => item.trim())
      .filter(item => /^\d{6}$/.test(item)),
  )).slice(0, 5)
}

function statusTone(status: string | null) {
  if (status === 'available') return 'text-emerald-500'
  if (status === 'unavailable') return 'text-red-500'
  if (status === 'blocked') return 'text-amber-500'
  return 'text-muted-foreground'
}

function statusIcon(status: string | null) {
  if (status === 'available') return CheckCircle2
  if (status === 'unavailable') return XCircle
  if (status === 'blocked') return AlertTriangle
  return Clock
}

export default function PincodeCheckerPage() {
  const [asinText, setAsinText] = useState('')
  const [pincodeText, setPincodeText] = useState(DEFAULT_PINCODES)
  const [job, setJob] = useState<PincodeJob | null>(null)
  const [results, setResults] = useState<PincodeResult[]>([])
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const asins = useMemo(() => parseAsins(asinText), [asinText])
  const pincodes = useMemo(() => parsePincodes(pincodeText), [pincodeText])
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
      const res = await fetch(`/api/scraping/pincode-availability/jobs/${jobId}`)
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
      const res = await fetch('/api/scraping/pincode-availability/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: 'A21TJRUUN4KGV',
          asins,
          pincodes,
        }),
      })
      const body = await readJson(res)
      if (!res.ok || !body.success || !body.job) {
        setError(body.errorCode ?? body.message ?? 'job_create_failed')
        return
      }
      setJob(body.job)

      const triggerRes = await fetch(`/api/scraping/pincode-availability/jobs/${body.job.id}/run`, {
        method: 'POST',
      })
      const triggerBody = await readJson(triggerRes) as TriggerResponse
      if (!triggerRes.ok || !triggerBody.success) {
        if (triggerBody.errorCode === 'worker_trigger_not_configured') {
          setNotice('Job queued. Worker trigger is not configured yet.')
        } else {
          setNotice('Job queued. Worker trigger failed safely; refresh after the worker runs.')
        }
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

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <MapPin className="size-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Pincode Availability Checker</h1>
          <Badge variant="secondary" className="h-5 text-[10px]">Queue beta</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Create a small availability job, let the Render worker process it safely, then review structured results without raw page data.
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">ASINs</span>
              <textarea
                value={asinText}
                onChange={event => setAsinText(event.target.value)}
                rows={5}
                placeholder="Enter up to 3 ASINs"
                className="min-h-32 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <span className="text-xs text-muted-foreground">{asins.length}/3 valid ASINs</span>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Pincodes</span>
              <textarea
                value={pincodeText}
                onChange={event => setPincodeText(event.target.value)}
                rows={5}
                placeholder="Enter up to 5 pincodes"
                className="min-h-32 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <span className="text-xs text-muted-foreground">{pincodes.length}/5 valid pincodes</span>
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={startJob}
              disabled={loading || asins.length === 0 || pincodes.length === 0}
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
            <span className="text-xs text-muted-foreground">Limits: 3 ASINs, 5 pincodes, worker concurrency 1.</span>
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
            <Badge
              variant="outline"
              className={cn(
                'capitalize',
                job?.status === 'done' && 'border-emerald-500/30 text-emerald-500',
                job?.status === 'failed' && 'border-red-500/30 text-red-500',
                job?.status === 'running' && 'border-primary/30 text-primary',
              )}
            >
              {job?.status ?? 'idle'}
            </Badge>
          </div>
          <div className="mt-4 h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="font-semibold text-foreground">{job?.resultSummary?.available ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unavailable</p>
              <p className="font-semibold text-foreground">{job?.resultSummary?.unavailable ?? 0}</p>
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
          Pincode queue API failed: {error}
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
            <h2 className="font-semibold text-foreground">Structured Results</h2>
            <p className="text-xs text-muted-foreground">No raw HTML, screenshots, cookies, or page dumps are stored.</p>
          </div>
          <Badge variant="secondary">{results.length} rows</Badge>
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
                  <th className="px-4 py-3 text-left font-medium">Pincode</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Delivery</th>
                  <th className="px-4 py-3 text-left font-medium">Price</th>
                  <th className="px-4 py-3 text-left font-medium">Buy Box</th>
                  <th className="px-5 py-3 text-left font-medium">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {results.map((result, index) => {
                  const Icon = statusIcon(result.availability_status)
                  return (
                    <tr key={`${result.asin}-${result.pincode}-${index}`} className="hover:bg-muted/20">
                      <td className="px-5 py-3 font-mono text-xs text-foreground">{result.asin}</td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">{result.pincode}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium capitalize', statusTone(result.availability_status))}>
                          <Icon className="size-3.5" />
                          {result.availability_status ?? 'unknown'}
                        </span>
                      </td>
                      <td className="max-w-[320px] px-4 py-3 text-xs text-muted-foreground">
                        {result.delivery_message ?? result.delivery_message_category ?? 'Not available'}
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{result.price_detected ? 'Detected' : 'Not detected'}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{result.buy_box_detected ? 'Detected' : 'Not detected'}</td>
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
