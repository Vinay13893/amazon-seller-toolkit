'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { getOrCreateCurrentUsageCounter, type UsageCounter } from '@/lib/supabase/usage'
import { Button } from '@/components/ui/button'
import { Loader2, CheckCircle2, Lock, Zap, Crown, Building2, Star, FlaskConical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string
  name: string
  price_monthly: number
  asin_limit: number
  keyword_limit: number
  pincode_check_limit: number
  competitor_limit: number
  report_limit: number
  features: Record<string, boolean | number>
}

interface Subscription {
  status: string
  current_period_start: string
  current_period_end: string
  plan: Plan
}

// ─── Razorpay ────────────────────────────────────────────────────────────────

interface RazorpayPaymentResponse {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}

interface RazorpayOptions {
  key: string
  amount: number | string
  currency: string
  order_id: string
  name: string
  description: string
  handler: (response: RazorpayPaymentResponse) => void
  theme?: { color?: string }
  modal?: { ondismiss?: () => void }
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => { open(): void }
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') { resolve(false); return }
    if (document.getElementById('razorpay-checkout-js')) { resolve(true); return }
    const script = document.createElement('script')
    script.id  = 'razorpay-checkout-js'
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload  = () => resolve(true)
    script.onerror = () => resolve(false)
    document.body.appendChild(script)
  })
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string
  used: number
  limit: number
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const isWarning = pct >= 80
  const isCritical = pct >= 95
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium tabular-nums', isCritical ? 'text-destructive' : isWarning ? 'text-yellow-500' : 'text-foreground')}>
          {used.toLocaleString('en-IN')} / {limit.toLocaleString('en-IN')}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            isCritical ? 'bg-destructive' : isWarning ? 'bg-yellow-500' : 'bg-primary'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ─── Plan icon ────────────────────────────────────────────────────────────────

const PLAN_ICONS: Record<string, React.ElementType> = {
  Free: Lock, Starter: Zap, Growth: Star, Pro: Crown, Agency: Building2,
  'Internal Tester': FlaskConical,
}

// ─── Feature row ─────────────────────────────────────────────────────────────

function FeatureRow({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <li className={cn('flex items-center gap-1.5 text-xs', enabled ? 'text-foreground' : 'text-muted-foreground/50 line-through')}>
      <CheckCircle2 className={cn('w-3 h-3 flex-shrink-0', enabled ? 'text-primary' : 'text-muted-foreground/30')} />
      {label}
    </li>
  )
}

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  isCurrent,
  onUpgrade,
  isUpgrading,
}: {
  plan: Plan
  isCurrent: boolean
  onUpgrade?: () => void
  isUpgrading?: boolean
}) {
  const Icon = PLAN_ICONS[plan.name] ?? Zap
  const f = plan.features ?? {}

  return (
    <div
      className={cn(
        'relative rounded-xl border flex flex-col gap-4 p-5 transition-all',
        isCurrent
          ? 'border-primary/50 bg-primary/5 shadow-sm'
          : 'border-border bg-card hover:border-border/80'
      )}
    >
      {isCurrent && (
        <span className="absolute -top-2.5 left-4 text-[10px] font-bold uppercase tracking-widest bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
          Current
        </span>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-4 h-4', isCurrent ? 'text-primary' : 'text-muted-foreground')} />
          <span className="font-bold text-sm text-foreground">{plan.name}</span>
        </div>
        <div className="text-right">
          <span className="text-xl font-black text-foreground">
            {plan.price_monthly === 0 ? 'Free' : `₹${plan.price_monthly.toLocaleString('en-IN')}`}
          </span>
          {plan.price_monthly > 0 && (
            <span className="text-xs text-muted-foreground block">/month</span>
          )}
        </div>
      </div>

      {/* Limits */}
      <ul className="flex flex-col gap-1.5">
        <FeatureRow enabled={true} label={`${plan.asin_limit} ASINs`} />
        <FeatureRow enabled={true} label={`${plan.keyword_limit.toLocaleString('en-IN')} keywords`} />
        <FeatureRow enabled={true} label={`${plan.pincode_check_limit.toLocaleString('en-IN')} pincode checks/mo`} />
        <FeatureRow enabled={true} label={`${plan.competitor_limit} competitors`} />
        <FeatureRow enabled={true} label={`${plan.report_limit} reports/mo`} />
      </ul>

      <hr className="border-border" />

      {/* Features */}
      <ul className="flex flex-col gap-1.5">
        <FeatureRow enabled={!!f.bsr_tracker}      label="BSR Tracker" />
        <FeatureRow enabled={!!f.pincode_checker}  label="Pincode Checker" />
        <FeatureRow enabled={!!f.buy_box}          label="Buy Box Monitor" />
        <FeatureRow enabled={!!f.keywords}         label="Keyword Tracking" />
        <FeatureRow enabled={!!f.competitors}      label="Competitor Intel" />
        <FeatureRow enabled={!!f.reports}          label="Reports" />
        <FeatureRow enabled={!!f.api_access}       label="API Access" />
        <FeatureRow enabled={!!f.white_label}      label="White Label" />
      </ul>

      {/* CTA */}
      <div className="mt-auto pt-1">
        {isCurrent ? (
          <div className="h-8 flex items-center justify-center rounded-lg border border-primary/30 bg-primary/5 text-xs font-medium text-primary">
            Active plan
          </div>
        ) : plan.name === 'Agency' ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            Contact Sales
          </Button>
        ) : plan.price_monthly === 0 ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            Downgrade
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            className="w-full"
            onClick={onUpgrade}
            disabled={isUpgrading || !onUpgrade}
          >
            {isUpgrading ? (
              <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Processing…</>
            ) : (
              `Upgrade to ${plan.name}`
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse bg-muted rounded-lg', className)} />
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [sub, setSub] = useState<Subscription | null>(null)
  const [allPlans, setAllPlans] = useState<Plan[]>([])
  const [usage, setUsage] = useState<UsageCounter | null>(null)
  const [asinUsage, setAsinUsage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [upgradingPlanId, setUpgradingPlanId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()

      // ── Auth ──────────────────────────────────────────────────────────
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      // ── Workspace ─────────────────────────────────────────────────────
      const { data: mem } = await supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .limit(1)
        .single()

      if (!mem?.workspace_id) {
        setError('No workspace found for your account.')
        return
      }
      const workspaceId = mem.workspace_id

      // ── Run queries in parallel; usage handled separately ────────────
      const [subRes, plansRes, trackedAsinCountRes] = await Promise.all([
        supabase
          .from('workspace_subscriptions')
          .select(`
            status, current_period_start, current_period_end,
            subscription_plans(id, name, price_monthly, asin_limit, keyword_limit, pincode_check_limit, competitor_limit, report_limit, features)
          `)
          .eq('workspace_id', workspaceId)
          .single(),

        supabase
          .from('subscription_plans')
          .select('id, name, price_monthly, asin_limit, keyword_limit, pincode_check_limit, competitor_limit, report_limit, features')
          .order('price_monthly', { ascending: true }),

        supabase
          .from('tracked_asins')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('status', 'archived'),
      ])

      const liveAsinCount = trackedAsinCountRes.count ?? 0
      setAsinUsage(liveAsinCount)

      // ── Usage: creates row if missing for older accounts ─────────────
      const usageData = await getOrCreateCurrentUsageCounter(workspaceId)
      if (usageData) {
        setUsage({
          ...usageData,
          // Use tracked_asins as source of truth for ASIN usage to avoid stale counter values.
          asin_count: liveAsinCount,
        })

        if (usageData.asin_count !== liveAsinCount) {
          fetch('/api/usage/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...usageData,
              workspace_id: workspaceId,
              asin_count: liveAsinCount,
            }),
          }).catch(() => {
            // Non-blocking reconciliation.
          })
        }
      }

      // ── Subscription ──────────────────────────────────────────────────
      if (subRes.data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = subRes.data as any
        const plan = normalizeEmbed<Plan>(raw.subscription_plans)
        if (plan) {
          setSub({
            status: raw.status,
            current_period_start: raw.current_period_start,
            current_period_end: raw.current_period_end,
            plan,
          })
        }
      }

      // ── All plans ─────────────────────────────────────────────────────
      if (plansRes.data) {
        setAllPlans(plansRes.data as Plan[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  const handleUpgrade = useCallback(async (planId: string) => {
    setUpgradingPlanId(planId)
    try {
      // 1. Create Razorpay order server-side (price validated there)
      const orderRes = await fetch('/api/billing/create-order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ plan_id: planId }),
      })
      const orderData = await orderRes.json() as {
        order_id?: string; amount?: number; currency?: string
        key_id?: string; plan_name?: string; error?: string
      }
      if (!orderRes.ok) {
        toast.error(orderData.error ?? 'Failed to create order')
        return
      }

      // 2. Load Razorpay checkout.js from CDN
      const loaded = await loadRazorpayScript()
      if (!loaded) {
        toast.error('Failed to load payment gateway. Check your internet connection.')
        return
      }

      // 3. Clear spinner — modal is about to open
      setUpgradingPlanId(null)

      // 4. Open Razorpay checkout modal
      const rzp = new window.Razorpay({
        key:         orderData.key_id!,
        amount:      orderData.amount!,
        currency:    orderData.currency!,
        order_id:    orderData.order_id!,
        name:        'Sociomonkey',
        description: `${orderData.plan_name} Plan · Monthly`,
        handler:     async (response: RazorpayPaymentResponse) => {
          const verifyRes = await fetch('/api/billing/verify-payment', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
              plan_id:             planId,
            }),
          })
          const verifyData = await verifyRes.json() as { success?: boolean; error?: string }
          if (verifyRes.ok && verifyData.success) {
            toast.success(`Upgraded to ${orderData.plan_name} plan!`)
            load()
          } else {
            toast.error(verifyData.error ?? 'Payment verification failed. Contact support.')
          }
        },
        theme: { color: '#6366f1' },
        modal: { ondismiss: () => setUpgradingPlanId(null) },
      })
      rzp.open()
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setUpgradingPlanId(null)
    }
  }, [load])

  // ── Derived ────────────────────────────────────────────────────────────
  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  const periodStart = usage?.period_start
    ? new Date(usage.period_start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : null
  const periodEndUsage = usage?.period_end
    ? new Date(usage.period_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : null

  const asinLimit = sub?.plan.name === 'Internal Tester'
    ? Math.max(sub?.plan.asin_limit ?? 0, 1000)
    : (sub?.plan.asin_limit ?? 5)

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-7xl">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">Billing & Plans</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View your current plan, usage, and available upgrades.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Current plan banner ───────────────────────────────────────── */}
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : sub ? (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            {(() => {
              const Icon = PLAN_ICONS[sub.plan.name] ?? Zap
              return <Icon className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            })()}
            <div>
              <p className="font-bold text-foreground">
                {sub.plan.name} Plan
                <span className={cn(
                  'ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-full',
                  sub.status === 'active' ? 'bg-green-500/15 text-green-600 dark:text-green-400' :
                  sub.status === 'trial'  ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' :
                  'bg-yellow-500/15 text-yellow-600'
                )}>
                  {sub.status}
                </span>
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {sub.plan.name === 'Internal Tester'
                  ? 'Internal testing access enabled'
                  : sub.plan.price_monthly === 0
                    ? '₹0 / month — free tier'
                    : `₹${sub.plan.price_monthly.toLocaleString('en-IN')} / month`}
                {sub.plan.name !== 'Internal Tester' && periodEnd && ` · renews ${periodEnd}`}
              </p>
            </div>
          </div>

        </div>
      ) : null}

      {/* ── Usage this period ─────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-sm text-foreground">Usage</h2>
            {periodStart && periodEndUsage && (
              <p className="text-xs text-muted-foreground mt-0.5">Period: {periodStart} – {periodEndUsage}</p>
            )}
          </div>
        </div>
        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col gap-4">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <UsageBar
                label="ASINs tracked"
                used={asinUsage}
                limit={asinLimit}
              />
              <UsageBar
                label="Keywords tracked"
                used={usage?.keyword_count ?? 0}
                limit={sub?.plan.keyword_limit ?? 20}
              />
              <UsageBar
                label="Pincode checks this month"
                used={usage?.pincode_checks_used ?? 0}
                limit={sub?.plan.pincode_check_limit ?? 100}
              />
              <UsageBar
                label="Competitors tracked"
                used={usage?.competitor_count ?? 0}
                limit={sub?.plan.competitor_limit ?? 3}
              />
              <UsageBar
                label="Reports generated this month"
                used={usage?.reports_generated ?? 0}
                limit={sub?.plan.report_limit ?? 3}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Plan cards ────────────────────────────────────────────────── */}
      <div>
        <h2 className="font-semibold text-sm text-foreground mb-4">All Plans</h2>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-96 w-full" />)}
          </div>
        ) : allPlans.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {allPlans.filter(p => p.name !== 'Internal Tester').map(plan => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isCurrent={sub?.plan.id === plan.id}
                onUpgrade={() => handleUpgrade(plan.id)}
                isUpgrading={upgradingPlanId === plan.id}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No plans found in database.</p>
        )}
      </div>

    </div>
  )
}
