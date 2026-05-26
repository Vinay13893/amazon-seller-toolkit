import { PlanTier, PlanLimits } from '@/types'

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    max_asins: 5,
    history_days: 7,
    refresh_interval_minutes: 720,
    keywords: false,
    pincode: false,
    buybox: false,
    competitors: false,
    alerts: 0,
    reports: false,
    api_access: false,
  },
  starter: {
    max_asins: 25,
    history_days: 30,
    refresh_interval_minutes: 240,
    keywords: true,
    pincode: true,
    buybox: false,
    competitors: false,
    alerts: 5,
    reports: false,
    api_access: false,
  },
  pro: {
    max_asins: 100,
    history_days: 90,
    refresh_interval_minutes: 60,
    keywords: true,
    pincode: true,
    buybox: true,
    competitors: true,
    alerts: 20,
    reports: true,
    api_access: false,
  },
  agency: {
    max_asins: 500,
    history_days: 365,
    refresh_interval_minutes: 15,
    keywords: true,
    pincode: true,
    buybox: true,
    competitors: true,
    alerts: 100,
    reports: true,
    api_access: true,
  },
}

export const PLAN_PRICES: Record<PlanTier, { monthly: number; label: string; colorClass: string }> = {
  free:    { monthly: 0,    label: 'Free',    colorClass: 'text-blue-400' },
  starter: { monthly: 999,  label: 'Starter', colorClass: 'text-green-400' },
  pro:     { monthly: 2499, label: 'Pro',     colorClass: 'text-purple-400' },
  agency:  { monthly: 7999, label: 'Agency',  colorClass: 'text-primary' },
}
