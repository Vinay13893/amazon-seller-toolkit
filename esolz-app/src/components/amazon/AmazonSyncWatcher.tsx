'use client'

/**
 * AmazonSyncWatcher
 *
 * Mounted in the dashboard layout so it keeps running while the user navigates
 * between pages. Reads amazon_listings_sync_job_id from localStorage, then:
 *   1. Calls /process until job is completed or failed
 *   2. Shows a non-intrusive progress toast while running
 *   3. Shows a success/failure toast when done
 *   4. Cleans up localStorage on finish
 *
 * No tokens, no secrets — only job_id and progress numbers are handled here.
 */

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ProcessResponse {
  ok?:            boolean
  job_id?:        string
  status?:        string
  pages?:         number
  items_fetched?: number
  items_upserted?:number
  has_more?:      boolean
  error?:         string
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const LS_KEY          = 'amazon_listings_sync_job_id'
const POLL_INTERVAL   = 5_000  // ms between process calls
const MAX_ERRORS      = 3      // give up after 3 consecutive network errors

// ─── Component ─────────────────────────────────────────────────────────────────

export function AmazonSyncWatcher() {
  const timerRef        = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastIdRef      = useRef<string | number | null>(null)
  const errorCountRef   = useRef(0)
  const runningRef      = useRef(false)   // prevent overlapping ticks

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function dismissProgressToast() {
    if (toastIdRef.current !== null) {
      toast.dismiss(toastIdRef.current)
      toastIdRef.current = null
    }
  }

  function cleanup(jobId: string) {
    clearTimer()
    dismissProgressToast()
    try { localStorage.removeItem(LS_KEY) } catch { /* SSR guard */ }
    console.log('[AmazonSyncWatcher] done for job', jobId)
  }

  async function tick(jobId: string) {
    if (runningRef.current) return
    runningRef.current = true

    try {
      const res  = await fetch('/api/amazon/sync/listings/process', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ job_id: jobId }),
      })

      const data: ProcessResponse = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Hard error from server
        const msg = data.error ?? `Sync error (HTTP ${res.status})`
        cleanup(jobId)
        toast.error(msg)
        return
      }

      errorCountRef.current = 0   // reset on success

      const pages     = data.pages          ?? 0
      const upserted  = data.items_upserted ?? 0
      const status    = data.status         ?? 'running'
      const hasMore   = data.has_more       ?? false

      // Update or create progress toast
      const progressMsg = `Syncing listings… ${upserted} imported across ${pages} page${pages !== 1 ? 's' : ''}`
      if (toastIdRef.current === null) {
        toastIdRef.current = toast.loading(progressMsg, { duration: Infinity })
      } else {
        toast.loading(progressMsg, { id: toastIdRef.current, duration: Infinity })
      }

      if (status === 'completed' || !hasMore) {
        // Done
        cleanup(jobId)
        toast.success(
          `Listings synced — ${upserted} product${upserted !== 1 ? 's' : ''} imported across ${pages} page${pages !== 1 ? 's' : ''}.`,
          { duration: 6000 }
        )
        // Dispatch a custom event so AmazonConnectionCard / ASIN page can refetch
        try { window.dispatchEvent(new CustomEvent('amazon:listings-synced')) } catch { /* SSR guard */ }
        return
      }

      if (status === 'failed') {
        cleanup(jobId)
        toast.error(`Listings sync failed. Check Settings → Amazon for details.`)
        return
      }

      // Still running — schedule next tick
      timerRef.current = setTimeout(() => tick(jobId), POLL_INTERVAL)

    } catch {
      // Network/parse error
      errorCountRef.current++
      if (errorCountRef.current >= MAX_ERRORS) {
        cleanup(jobId)
        toast.error('Listings sync lost connection. Please try again.')
      } else {
        // Retry after delay
        timerRef.current = setTimeout(() => tick(jobId), POLL_INTERVAL * 2)
      }
    } finally {
      runningRef.current = false
    }
  }

  useEffect(() => {
    // Guard against SSR
    if (typeof window === 'undefined') return

    let jobId: string | null = null
    try { jobId = localStorage.getItem(LS_KEY) } catch { /* SSR guard */ }

    if (jobId) {
      // Resume in-progress job from localStorage
      console.log('[AmazonSyncWatcher] resuming job', jobId)
      timerRef.current = setTimeout(() => tick(jobId!), 500)
    }

    // Listen for a new job started from AmazonConnectionCard
    function onJobStarted(e: Event) {
      const detail = (e as CustomEvent<{ job_id: string }>).detail
      if (!detail?.job_id) return
      clearTimer()
      dismissProgressToast()
      errorCountRef.current = 0
      runningRef.current    = false
      console.log('[AmazonSyncWatcher] new job', detail.job_id)
      timerRef.current = setTimeout(() => tick(detail.job_id), 200)
    }

    window.addEventListener('amazon:listings-sync-started', onJobStarted)

    return () => {
      clearTimer()
      window.removeEventListener('amazon:listings-sync-started', onJobStarted)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Renders nothing — it is purely a side-effect component
  return null
}
