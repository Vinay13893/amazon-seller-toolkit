import { cn } from '@/lib/utils'
import { Insight } from '@/types'

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const dotColor: Record<string, string> = {
  success: 'bg-green-400',
  warning: 'bg-yellow-400',
  error:   'bg-red-400',
  info:    'bg-blue-400',
}

interface InsightFeedProps {
  insights: Insight[]
}

export function InsightFeed({ insights }: InsightFeedProps) {
  if (!insights.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No recent activity
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {insights.map(insight => (
        <div
          key={insight.id}
          className="flex items-start gap-3 px-2 py-2.5 rounded-lg hover:bg-muted/30 transition-colors"
        >
          <div className="mt-1.5 flex-shrink-0">
            <span
              className={cn(
                'block w-2 h-2 rounded-full',
                dotColor[insight.severity ?? 'info']
              )}
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-snug">{insight.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{insight.description}</p>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0 mt-0.5 whitespace-nowrap">
            {timeAgo(insight.timestamp)}
          </span>
        </div>
      ))}
    </div>
  )
}
