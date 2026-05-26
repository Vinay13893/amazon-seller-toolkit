'use client'

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
} from 'lucide-react'
import {
  REPORT_TEMPLATES,
  RECENT_REPORTS,
  REPORT_SUMMARY,
} from '@/lib/mock-reports'
import type { ReportModule, ReportTemplate, RecentReport, ReportFileType } from '@/lib/mock-reports'

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  'asin-performance': Package,
  'bsr-movement': BarChart2,
  'pincode-availability': MapPin,
  'buybox-health': ShoppingCart,
  'keyword-ranking': Tag,
  'alerts-summary': Bell,
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
      className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-none ${MODULE_COLORS[module]}`}
    >
      {module}
    </span>
  )
}

// ─── Template card ────────────────────────────────────────────────────────────

function TemplateCard({ template }: { template: ReportTemplate }) {
  const Icon = TEMPLATE_ICONS[template.id] ?? FileText
  const catColor = CATEGORY_COLORS[template.category] ?? 'bg-border text-muted-foreground'

  return (
    <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/40 transition-colors group">
      {/* Top row: icon + category + popular */}
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

      {/* Footer: est time + buttons */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1 mr-auto">
          <Clock className="size-3" />
          {fmtEstTime(template.estSeconds)}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled>
          <Eye className="size-3" />
          Preview
        </Button>
        <Button type="button" variant="outline" size="sm" disabled>
          <Plus className="size-3" />
          Generate
        </Button>
      </div>
    </div>
  )
}

// ─── File type badge ──────────────────────────────────────────────────────────

function FileTypeBadge({ type }: { type: ReportFileType }) {
  const styles: Record<ReportFileType, string> = {
    PDF:   'bg-red-500/15 text-red-400 border-red-500/25',
    Excel: 'bg-green-500/15 text-green-400 border-green-500/25',
    CSV:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  }
  const icons: Record<ReportFileType, LucideIcon> = {
    PDF:   FileType2,
    Excel: FileSpreadsheet,
    CSV:   FileText,
  }
  const Icon = icons[type]
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-none ${styles[type]}`}>
      <Icon className="size-2.5" />
      {type}
    </span>
  )
}

// ─── Recent report row ────────────────────────────────────────────────────────

function RecentReportRow({ report }: { report: RecentReport }) {
  const isReady = report.status === 'ready'

  const statusStyles: Record<string, string> = {
    ready:      'bg-green-500/15 text-green-400 border-green-500/25',
    generating: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
    failed:     'bg-red-500/15 text-red-400 border-red-500/25',
  }
  const statusLabel: Record<string, string> = {
    ready:      'Ready',
    generating: 'Processing',
    failed:     'Failed',
  }

  return (
    <tr className="border-b border-border last:border-0 hover:bg-border/10 transition-colors group">
      {/* Report name + type */}
      <td className="px-5 py-3">
        <p className="text-xs font-medium text-foreground">{report.name}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{report.templateTitle}</p>
      </td>
      {/* Date */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Clock className="size-3 flex-shrink-0" />
          {report.createdAt}
        </span>
      </td>
      {/* Generated by */}
      <td className="px-4 py-3 whitespace-nowrap hidden md:table-cell">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <User className="size-3 flex-shrink-0" />
          {report.generatedBy}
        </span>
      </td>
      {/* ASINs */}
      <td className="px-4 py-3 whitespace-nowrap hidden sm:table-cell">
        <span className="text-[11px] text-foreground font-medium">{report.asinCount}</span>
        <span className="text-[11px] text-muted-foreground ml-1">ASINs</span>
      </td>
      {/* File type */}
      <td className="px-4 py-3 whitespace-nowrap hidden sm:table-cell">
        <FileTypeBadge type={report.fileType} />
      </td>
      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${statusStyles[report.status]}`}>
          {statusLabel[report.status]}
        </span>
      </td>
      {/* Actions */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button type="button" variant="ghost" size="sm" disabled={!isReady} className="h-7 px-2 text-[11px]">
            <Eye className="size-3" />
            Preview
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!isReady} className="h-7 px-2 text-[11px]">
            <Download className="size-3" />
            Download
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled className="h-7 px-2 text-[11px]">
            <RefreshCw className="size-3" />
            Regenerate
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const summary = REPORT_SUMMARY

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Reports Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate client-ready reports for Amazon performance, rankings, availability and Buy Box health.
          </p>
        </div>
        <Button type="button" disabled>
          <Plus className="size-4" />
          Create Report
        </Button>
      </div>

      {/* ── 2. Summary cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Reports Generated</p>
          <p className="text-2xl font-black text-foreground leading-none">{summary.generated}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Scheduled Reports</p>
          <p className="text-2xl font-black text-foreground leading-none">{summary.scheduled}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Last Export</p>
          <p className="text-sm font-bold text-foreground leading-none mt-1">{summary.lastExport}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">Data Range</p>
          <p className="text-sm font-bold text-foreground leading-none mt-1">{summary.dataRange}</p>
        </div>
      </div>

      {/* ── 3. Report templates ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Report Templates</h2>
          <span className="text-xs text-muted-foreground">{REPORT_TEMPLATES.length} templates available</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {REPORT_TEMPLATES.map(template => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      </div>

      {/* ── 4. Recent reports ─────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Recent Reports</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Last 30 days · {RECENT_REPORTS.length} reports</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled>
            View All
          </Button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-border/20">
                <th className="px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Report</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Date Generated</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">Generated By</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">ASINs</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Format</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_REPORTS.map(report => (
                <RecentReportRow key={report.id} report={report} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
