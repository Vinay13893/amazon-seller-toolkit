'use client'

import { ChevronRight, Sheet as SheetIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WORKSHEET_GROUP_ORDER } from '@/lib/stock-intelligence/config'
import type { WorksheetSummary } from '@/lib/stock-intelligence/types'

type Props = {
  worksheets: WorksheetSummary[]
  selectedTitle: string
  onSelect: (title: string) => void
}

export function WorksheetNavigation({ worksheets, selectedTitle, onSelect }: Props) {
  return (
    <nav aria-label="Stock worksheets" className="space-y-2">
      {WORKSHEET_GROUP_ORDER.map(group => {
        const items = worksheets.filter(sheet => sheet.group === group)
        if (items.length === 0) return null
        return (
          <details key={group} open className="group border-b border-border pb-2 last:border-0">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[11px] font-bold uppercase text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
              <span>{group}</span>
              <span className="ml-auto font-normal tabular-nums">{items.length}</span>
            </summary>
            <div className="mt-1 space-y-0.5">
              {items.map(sheet => (
                <button
                  key={sheet.sheetId}
                  type="button"
                  onClick={() => onSelect(sheet.title)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    selectedTitle === sheet.title
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <SheetIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{sheet.title}</span>
                </button>
              ))}
            </div>
          </details>
        )
      })}
    </nav>
  )
}
