'use client'

import { ArrowRight, CircleAlert, Clock3, IndianRupee, PackageSearch, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { parseTodaySections } from '@/lib/stock-intelligence/config'
import { TODAY_SHIPMENT_METRIC_LABEL } from '@/lib/stock-intelligence/presentation'
import { SourceTable } from './source-table'

type Props = {
  rows: Array<Array<string | null>>
  onNavigate: (title: string) => void
}

const SECTION_DESTINATIONS: Array<[string, string]> = [
  ['Running out', 'Stock Summary'],
  ['FBA shipments', 'FBA Shipments'],
  ['Stock Amazon lost', 'Stock Reconciliation'],
  ['Claims to check', 'Claims to Check'],
]

function findCount(sections: ReturnType<typeof parseTodaySections>, phrase: string): number | null {
  return sections.find(section => section.heading.includes(phrase))?.count ?? null
}

function Metric({ label, value, icon: Icon }: { label: string; value: number | null; icon: typeof Clock3 }) {
  return (
    <div className="border-b border-r border-border p-4 last:border-r-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value === null ? 'Unavailable' : value}</p>
    </div>
  )
}

export function TodayView({ rows, onNavigate }: Props) {
  const sections = parseTodaySections(rows)
  const runSection = sections.find(section => section.heading.includes('Run problems'))
  const runMessage = runSection?.rows.flat().find(Boolean) ?? null

  return (
    <div className="space-y-6">
      <div className="grid border border-border sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Under 7 days" value={findCount(sections, 'under 7 days')} icon={Clock3} />
        <Metric label="7–15 days" value={findCount(sections, '7-15 days')} icon={PackageSearch} />
        <Metric label={TODAY_SHIPMENT_METRIC_LABEL} value={findCount(sections, 'shipments needing attention')} icon={CircleAlert} />
        <Metric label="Reconciliation exceptions" value={findCount(sections, 'Stock Amazon lost')} icon={RefreshCw} />
        <Metric label="Claim opportunities" value={findCount(sections, 'Claims to check')} icon={IndianRupee} />
      </div>

      <div className="border-l-4 border-primary bg-muted/40 px-4 py-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Data synchronization health</p>
        <p className="mt-1 text-sm">{runMessage ?? 'Source status is unavailable.'}</p>
      </div>

      {sections.filter(section => !section.heading.includes('Run problems')).map(section => {
        const destination = SECTION_DESTINATIONS.find(([phrase]) => section.heading.includes(phrase))?.[1]
        return (
          <section key={section.heading} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{section.heading}</h2>
              {destination && (
                <Button variant="outline" size="sm" onClick={() => onNavigate(destination)}>
                  Open {destination}
                  <ArrowRight />
                </Button>
              )}
            </div>
            {section.rows.length === 0 ? (
              <p className="border-y border-border py-8 text-center text-sm text-muted-foreground">
                No source records are displayed in this section.
              </p>
            ) : section.headers.length > 0 ? (
              <SourceTable headers={section.headers} rows={section.rows} compact />
            ) : (
              <div className="space-y-1 border-y border-border py-3 text-sm">
                {section.rows.map((row, index) => <p key={index}>{row.filter(Boolean).join(' · ')}</p>)}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
