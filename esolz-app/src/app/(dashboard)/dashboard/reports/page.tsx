'use client'

import { useState, useEffect, useCallback } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  FileText,
  Plus,
  BarChart2,
  ShoppingCart,
  Tag,
  MapPin,
  Bell,
  Package,
  Clock,
  Download,
  Eye,
  Sparkles,
  RefreshCw,
  User,
  FileSpreadsheet,
  FileType2,
  Loader2,
} from 'lucide-react'
import { REPORT_TEMPLATES } from '@/lib/mock-reports'
import type { ReportModule, ReportTemplate, ReportFileType } from '@/lib/mock-reports'
import { getWorkspaceId } from '@/lib/supabase/asins'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/format'
import type { ReportType } from '@/lib/reports/generate-report-data'
import { cn } from '@/lib/utils'

// ─── DB report shape ──────────────────────────────────────────────────────────

interface DbReport {
  id:          string
  report_name: string
  report_type: string
  status:      string   // 'ready' | 'processing' | 'failed'
  file_type:   string   // 'csv' | 'pdf' | 'excel'
  created_at:  string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  'asin-performance':     Package,
  'bsr-movement':         BarChart2,
  'pincode-availability': MapPin,
  'buybox-health':        ShoppingCart,
  'keyword-ranking':      Tag,
  'alerts-summary':       Bell,
}

const MODULE_COLORS: Record<ReportModule, string> = {
  'BSR':          'bg-amber-500/15 text-amber-400 border-amber-500/25',
  'Buy Box':      'bg-blue-500/15 text-blue-400 border-blue-500/25',
  'Keywords':     'bg-violet-500/15 text-violet-400 border-violet-500/25',
  'Pincode':      'bg-green-500/15 text-green-400 border-green-500/25',
  'Alerts':       'bg-red-500/15 text-red-400 border-red-500/25',
  'Pricing':      'bg-orange-500/15 text-orange-400 border-orange-500/25',
  'Rating':       'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  'Reviews':      'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
  'Availability': 'bg-teal-500/15 text-teal-400 border-teal-500/25',
  'Competitors':  'bg-pink-500/15 text-pink-400 border-pink-500/25',
}

const CATEGORY_COLORS: Record<string, string> = {
  Analytics:  'bg-amber-500/10 text-amber-400',
  Operations: 'bg-blue-500/10 text-blue-400',
  SEO:        'bg-violet-500/10 text-violet-400',
  Logistics:  'bg-green-500/10 text-green-400',
  Monitoring: 'bg-red-500/10 text-red-400',
  Audit:      'bg-orange-500/10 text-orange-400',
}

function fmtEstTime(seconds: number): string {
  if (seconds < 60) return `~${seconds} sec`
  return `~${Math.round(seconds / 60)} min`
}

// ─── Module badge ─────────────────────────────────────────────────────────────

function ModuleBadge({ module }: { module: ReportModule }) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-none',
        MODULE_COLORS[module],
      )}
    >
      {module}
    </span>
  )
}

// ─── Template card ────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  onGenerate,
  isGenerating,
}: {
  template:    ReportTemplate
  onGenerate:  (id: ReportType) => void
  isGenerating: boolean
}) {
  const Icon     = TEMPLATE_ICONS[template.id] ?? FileText
  const catColor = CATEGORY_COLORS[template.category] ?? 'bg-border text-muted-foreground'

  return (
    <div className={cn(
      'bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/40 transition-colors group',
      isGenerating && 'opacity-75',
    )}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/15 transition-colors">
          <Icon className="size-5 text-primary" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {template.popular && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-primary/15 text-primary border-primary/25 leading-none">
              <Sparkles className="size-2.5" />
              Popular
            </span>
          )}
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full leading-none ${catColor}`}>
            {template.category}
          </span>
        </div>
      </div>

      {/* Title + description */}
      <div className="flex-1">
        <p className="text-sm font-semibold text-foreground">{template.title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{template.description}</p>
      </div>

      {/* Module badges */}
      <div className="flex flex-wrap gap-1">
        {template.modules.map(m => (
          <ModuleBadge key={m} module={m} />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1 mr-auto">
          <Clock className="size-3" />
          {fmtEstTime(template.estSeconds)}
          <span className="text-muted-foreground/50">· CSV</span>
        </span>
        <Button type="button" variant="ghost" size="sm" disabled>
          <Eye className="size-3" />
          Preview
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onGenerate(template.id as ReportType)}
          disabled={isGenerating}
        >
          {isGenerating
            ? <Loader2 className="size-3 animate-spin" />
            : <Download className="size-3" />}
          {isGenerating ? 'Generating…' : 'Generate'}
        </Button>
      </div>
    </div>
  )
}

// ─── File type badge ──────────────────────────────────────────────────────────

function FileTypeBadge({ type }: { type: string }) {
  const normalized = type.toUpperCase() as ReportFileType
  const styles: Record<string, string> = {
    PDF:   'bg-red-500/15 text-red-400 border-red-500/25',
    EXCEL: 'bg-green-500/15 text-green-400 border-green-500/25',
    CSV:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  }
  const icons: Record<string, LucideIcon> = {
    PDF:   FileType2,
    EXCEL: FileSpreadsheet,
    CSV:   FileText,
  }
  const Icon  = icons[normalized] ?? FileText
  const style = styles[normalized] ?? styles.CSV
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-none', style)}>
      <Icon className="size-2.5" />
      {normalized}
    </span>
  )
}

// ─── Recent report row ────────────────────────────────────────────────────────

function RecentReportRow({
  report,
  onDownload,
  isDownloading,
}: {
  report:       DbReport
  onDownload:   (reportType: string) => void
  isDownloading: boolean
}) {
  const isReady = report.status === 'ready'
  const templateTitle = REPORT_TEMPLATES.find(t => t.id === report.report_type)?.title ?? report.report_type

  const statusStyles: Record<string, string> = {
    ready:      'bg-green-500/15 text-green-400 border-green-500/25',
    processing: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
    failed:     'bg-red-500/15 text-red-400 border-red-500/25',
  }
  const statusLabels: Record<string, string> = {
    ready:      'Ready',
    processing: 'Processing',
    failed:     'Failed',
  }

  return (
    <tr className="border-b border-border last:border-0 hover:bg-border/10 transition-colors group">
      {/* Report name */}
      <td className="px-5 py-3">
        <p className="text-xs font-medium text-foreground">{report.report_name}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{templateTitle}</p>
      </td>
      {/* Date */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Clock className="size-3 flex-shrink-0" />
          {timeAgo(report.created_at)}
        </span>
      </td>
      {/* Generated by */}
      <td className="px-4 py-3 whitespace-nowrap hidden md:table-cell">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <User className="size-3 flex-shrink-0" />
          You
        </span>
      </td>
      {/* File type */}
      <td className="px-4 py-3 whitespace-nowrap hidden sm:table-cell">
        <FileTypeBadge type={report.file_type} />
      </td>
      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span
          className={cn(
            'text-[11px] font-medium px-2 py-0.5 rounded-full border',
            statusStyles[report.status] ?? statusStyles.ready,
          )}
        >
          {statusLabels[report.status] ?? 'Ready'}
        </span>
      </td>
      {/* Actions */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isReady || isDownloading}
            onClick={() => onDownload(report.report_type)}
            className="h-7 px-2 text-[11px]"
          >
            {isDownloading
              ? <Loader2 className="size-3 animate-spin" />
              : <RefreshCw className="size-3" />}
            Regenerate
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [recentReports, setRecentReports] = useState<DbReport[]>([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [workspaceId, setWorkspaceId]       = useState<string | null>(null)
  /** Template ID currently being generated */
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  /** Report row currently being re-downloaded */
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  // ── Load recent reports from DB ───────────────────────────────────────────

  const loadReports = useCallback(async (wid?: string) => {
    const id = wid ?? workspaceId
    if (!id) return
    const supabase = createClient()
    const { data } = await supabase
      .from('reports')
      .select('id, report_name, report_type, status, file_type, created_at')
      .eq('workspace_id', id)
      .order('created_at', { ascending: false })
      .limit(50)
    setRecentReports((data ?? []) as DbReport[])
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    async function init() {
      setLoadingReports(true)
      const wid = await getWorkspaceId()
      if (cancelled) return
      setWorkspaceId(wid)
      if (wid) await loadReports(wid)
      setLoadingReports(false)
    }
    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generate + download ───────────────────────────────────────────────────

  async function doGenerate(reportType: ReportType) {
    try {
      const res = await fetch('/api/reports/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reportType, fileType: 'csv' }),
      })

      if (!res.ok) {
        let errMsg = 'Failed to generate report'
        try {
          const body = await res.json()
          if (body?.error) errMsg = body.error
        } catch { /* ignore */ }
        toast.error(errMsg)
        return
      }

      // Trigger browser download from blob
      const blob     = await res.blob()
      const url      = URL.createObjectURL(blob)
      const filename = (res.headers.get('Content-Disposition') ?? '')
        .match(/filename="([^"]+)"/)?.[1]
        ?? `${reportType}-report.csv`

      const a = document.createElement('a')
      a.href     = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast.success('Report downloaded.')
      await loadReports()
    } catch {
      toast.error('Network error while generating report')
    }
  }

  async function handleGenerate(reportType: ReportType) {
    setGeneratingId(reportType)
    await doGenerate(reportType)
    setGeneratingId(null)
  }

  async function handleRedownload(reportType: string, rowId: string) {
    setDownloadingId(rowId)
    await doGenerate(reportType as ReportType)
    setDownloadingId(null)
  }

  // ── Summary values ────────────────────────────────────────────────────────
  const totalGenerated = recentReports.length
  const lastExport     = recentReports[0]
    ? timeAgo(recentReports[0].created_at)
    : 'Never'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Reports Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate exportable reports for Amazon performance, rankings, availability and Buy Box health. Next: pick a template and click Generate. Data source: tracked ASIN snapshots and checks.
          </p>
        </div>
      </div>

      {/* ── 2. Summary cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Reports Generated</p>
          <p className="text-2xl font-black text-foreground leading-none">
            {loadingReports ? '—' : totalGenerated}
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Scheduled Reports</p>
          <p className="text-2xl font-black text-foreground leading-none">0</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Last Export</p>
          <p className="text-sm font-bold text-foreground leading-none mt-1">
            {loadingReports ? '—' : lastExport}
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Data Range</p>
          <p className="text-sm font-bold text-foreground leading-none mt-1">All time</p>
        </div>
      </div>

      {/* ── 3. Report templates ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Report Templates</h2>
          <span className="text-xs text-muted-foreground">{REPORT_TEMPLATES.length} templates · CSV export</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {REPORT_TEMPLATES.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              onGenerate={handleGenerate}
              isGenerating={generatingId === template.id}
            />
          ))}
        </div>
      </div>

      {/* ── 4. Recent reports ─────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Recent Reports</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {loadingReports ? 'Loading…' : `${recentReports.length} report${recentReports.length !== 1 ? 's' : ''}`}
            </p>
          </div>
        </div>

        {/* Loading state */}
        {loadingReports && (
          <div className="flex items-center justify-center py-12 gap-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading reports…</span>
          </div>
        )}

        {/* Empty state */}
        {!loadingReports && recentReports.length === 0 && (
          <div className="flex flex-col items-center justify-center py-14 gap-3 text-center px-6">
            <FileText className="size-8 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground">No reports generated yet</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Choose a template above and click <strong>Generate</strong> to export your first CSV report.
            </p>
          </div>
        )}

        {/* Table */}
        {!loadingReports && recentReports.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-border/20">
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Report</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Date Generated</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">Generated By</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Format</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recentReports.map(report => (
                  <RecentReportRow
                    key={report.id}
                    report={report}
                    onDownload={type => handleRedownload(type, report.id)}
                    isDownloading={downloadingId === report.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
