// ─── Types ────────────────────────────────────────────────────────────────────

export type ReportModule =
  | 'BSR'
  | 'Buy Box'
  | 'Keywords'
  | 'Pincode'
  | 'Alerts'
  | 'Pricing'
  | 'Rating'
  | 'Reviews'
  | 'Availability'
  | 'Competitors'

export type ReportCategory =
  | 'Analytics'
  | 'Operations'
  | 'SEO'
  | 'Logistics'
  | 'Monitoring'
  | 'Audit'

export type ReportStatus = 'ready' | 'generating' | 'failed'

export type ReportFileType = 'PDF' | 'Excel' | 'CSV'

export interface ReportTemplate {
  id: string
  title: string
  description: string
  category: ReportCategory
  modules: ReportModule[]
  /** Estimated generation time in seconds */
  estSeconds: number
  popular?: boolean
}

export interface RecentReport {
  id: string
  name: string
  templateId: string
  templateTitle: string
  createdAt: string
  generatedBy: string
  status: ReportStatus
  fileType: ReportFileType
  asinCount: number
}

export interface ReportSummary {
  generated: number
  scheduled: number
  lastExport: string
  dataRange: string
}

// ─── Templates ────────────────────────────────────────────────────────────────

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'asin-performance',
    title: 'ASIN Performance Report',
    description:
      'Per-ASIN snapshot of BSR, current price, Buy Box status, star rating, review count and metro availability. Ideal for weekly client updates.',
    category: 'Analytics',
    modules: ['BSR', 'Pricing', 'Rating', 'Reviews', 'Buy Box', 'Availability'],
    estSeconds: 45,
    popular: true,
  },
  {
    id: 'bsr-movement',
    title: 'BSR Movement Report',
    description:
      'Rank history over 30/60/90 days, category-wise breakdown, biggest gainers and biggest losers with competitor rank overlays.',
    category: 'Analytics',
    modules: ['BSR', 'Competitors'],
    estSeconds: 30,
  },
  {
    id: 'pincode-availability',
    title: 'Pincode Availability Report',
    description:
      'City-wise availability matrix, delivery promise dates, and Buy Box status by pincode across top 20 metro areas.',
    category: 'Logistics',
    modules: ['Pincode', 'Availability', 'Buy Box'],
    estSeconds: 60,
  },
  {
    id: 'buybox-health',
    title: 'Buy Box Health Report',
    description:
      'Buy Box win/loss history, seller change log, price gap vs. competitors, hijacker risk flags and fulfillment-method breakdown.',
    category: 'Operations',
    modules: ['Buy Box', 'Pricing', 'Competitors'],
    estSeconds: 40,
    popular: true,
  },
  {
    id: 'keyword-ranking',
    title: 'Keyword Ranking Report',
    description:
      'Organic and sponsored rank trends for all tracked keywords, page-one visibility rate, new entries, rank drops and indexation status.',
    category: 'SEO',
    modules: ['Keywords', 'BSR'],
    estSeconds: 35,
  },
  {
    id: 'alerts-summary',
    title: 'Alerts Summary Report',
    description:
      'Weekly digest of all critical alerts, warnings and opportunities across BSR, Buy Box, keywords, pincode and pricing — with resolution status.',
    category: 'Monitoring',
    modules: ['Alerts', 'BSR', 'Buy Box', 'Keywords', 'Pincode'],
    estSeconds: 20,
  },
]

// ─── Recent reports ───────────────────────────────────────────────────────────

export const RECENT_REPORTS: RecentReport[] = [
  {
    id: 'r1',
    name: 'ASIN Performance — May 2026',
    templateId: 'asin-performance',
    templateTitle: 'ASIN Performance Report',
    createdAt: '26 May 2026',
    generatedBy: 'Rahul Sharma',
    status: 'ready',
    fileType: 'PDF',
    asinCount: 5,
  },
  {
    id: 'r2',
    name: 'Buy Box Health — Week 21',
    templateId: 'buybox-health',
    templateTitle: 'Buy Box Health Report',
    createdAt: '25 May 2026',
    generatedBy: 'Rahul Sharma',
    status: 'ready',
    fileType: 'Excel',
    asinCount: 5,
  },
  {
    id: 'r3',
    name: 'Full BSR Movement — May 2026',
    templateId: 'bsr-movement',
    templateTitle: 'BSR Movement Report',
    createdAt: '25 May 2026',
    generatedBy: 'Priya Menon',
    status: 'generating',
    fileType: 'PDF',
    asinCount: 5,
  },
  {
    id: 'r4',
    name: 'Keyword Ranking — Apr 2026',
    templateId: 'keyword-ranking',
    templateTitle: 'Keyword Ranking Report',
    createdAt: '30 Apr 2026',
    generatedBy: 'Rahul Sharma',
    status: 'ready',
    fileType: 'CSV',
    asinCount: 3,
  },
  {
    id: 'r5',
    name: 'Pincode Availability — Apr 2026',
    templateId: 'pincode-availability',
    templateTitle: 'Pincode Availability Report',
    createdAt: '28 Apr 2026',
    generatedBy: 'Priya Menon',
    status: 'ready',
    fileType: 'Excel',
    asinCount: 4,
  },
  {
    id: 'r6',
    name: 'Alerts Summary — Week 20',
    templateId: 'alerts-summary',
    templateTitle: 'Alerts Summary Report',
    createdAt: '24 Apr 2026',
    generatedBy: 'Rahul Sharma',
    status: 'failed',
    fileType: 'PDF',
    asinCount: 5,
  },
]

// ─── Summary stats ────────────────────────────────────────────────────────────

export const REPORT_SUMMARY: ReportSummary = {
  generated: 24,
  scheduled: 3,
  lastExport: '26 May 2026',
  dataRange: 'Last 90 days',
}

// ─── Integration placeholder ──────────────────────────────────────────────────

/** Future: generate a report via API and poll for completion. */
export async function generateReport(
  _templateId: string,
  _options: { asins?: string[]; dateRange?: string },
): Promise<{ jobId: string }> {
  await new Promise(r => setTimeout(r, 1000))
  return { jobId: `mock-job-${Date.now()}` }
}
