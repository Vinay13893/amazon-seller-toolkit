import { cn } from '@/lib/utils'
import { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: string | number
  sub?: string
  icon?: LucideIcon
  trend?: { value: number; label: string }
  className?: string
}

export function KpiCard({ label, value, sub, icon: Icon, trend, className }: KpiCardProps) {
  const isPositive = trend && trend.value < 0 // lower rank number = improvement
  const isNegative = trend && trend.value > 0

  return (
    <div className={cn('bg-card border border-border rounded-xl p-5 hover:border-border/80 transition-colors', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest mb-1.5">
            {label}
          </p>
          <p className="text-2xl font-black text-foreground leading-none">{value}</p>
          {sub && (
            <p className="text-xs text-muted-foreground mt-1.5 truncate">{sub}</p>
          )}
          {trend && (
            <p
              className={cn(
                'text-xs mt-1.5 font-medium',
                isPositive ? 'text-green-400' : isNegative ? 'text-red-400' : 'text-muted-foreground'
              )}
            >
              {isPositive ? '↑' : isNegative ? '↓' : '→'} {Math.abs(trend.value)} {trend.label}
            </p>
          )}
        </div>
        {Icon && (
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Icon className="w-5 h-5 text-primary" />
          </div>
        )}
      </div>
    </div>
  )
}
