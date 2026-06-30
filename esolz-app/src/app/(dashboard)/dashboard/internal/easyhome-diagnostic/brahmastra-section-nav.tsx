'use client'

// Phase R5: tab-style navigation between Brahmastra analysis sections via the
// `?view=` query param on the SAME route — no nested pages, no extra fetch.
// The parent dashboard keeps `data` in React state regardless of which tab is
// active, so switching tabs never re-triggers the API call.
import Link from 'next/link'

export type BrahmastraView =
  | 'overview'
  | 'actions'
  | 'good-working'
  | 'findings'
  | 'trends'
  | 'category'
  | 'data-health'
  | 'change-history'
  | 'settings'
  | 'thresholds'

export const BRAHMASTRA_VIEWS: Array<{ id: BrahmastraView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'actions', label: 'Actions & Review' },
  { id: 'good-working', label: 'Good Working' },
  { id: 'findings', label: 'Findings' },
  { id: 'trends', label: 'Trends & Charts' },
  { id: 'category', label: 'Category Performance' },
  { id: 'data-health', label: 'Data Health & Imports' },
  { id: 'change-history', label: 'Change History' },
  { id: 'settings', label: 'Settings / Mapping' },
  { id: 'thresholds', label: 'Thresholds & Assumptions' },
]

export function isBrahmastraView(value: string | null): value is BrahmastraView {
  return Boolean(value) && BRAHMASTRA_VIEWS.some(v => v.id === value)
}

export function BrahmastraSectionNav({ active }: { active: BrahmastraView }) {
  return (
    <nav className="flex flex-wrap gap-1.5 border-b border-border pb-3" aria-label="Brahmastra sections">
      {BRAHMASTRA_VIEWS.map(v => {
        const isActive = v.id === active
        return (
          <Link
            key={v.id}
            href={`/dashboard/internal/easyhome-diagnostic?view=${v.id}`}
            className={
              isActive
                ? 'inline-flex items-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold whitespace-nowrap'
                : 'inline-flex items-center rounded-md border border-border text-foreground px-3 py-1.5 text-xs font-medium whitespace-nowrap hover:bg-muted'
            }
          >
            {v.label}
          </Link>
        )
      })}
    </nav>
  )
}
