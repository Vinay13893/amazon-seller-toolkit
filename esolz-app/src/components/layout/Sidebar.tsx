'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, Package, TrendingUp, Tag, MapPin,
  ShoppingCart, Users, Bell, FileText, CreditCard,
  Settings, BarChart3, FlaskConical, Megaphone, Activity,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { SidebarPlanCard } from '@/components/layout/SidebarPlanCard'

const navSections = [
  {
    section: 'Analytics',
    items: [
      { href: '/dashboard',           icon: LayoutDashboard, label: 'Overview' },
      { href: '/dashboard/asins',     icon: Package,         label: 'ASINs' },
      { href: '/dashboard/bsr',       icon: TrendingUp,      label: 'BSR Tracker' },
      { href: '/dashboard/keywords',  icon: Tag,             label: 'Keywords',       badge: 'Starter+' },
      { href: '/dashboard/brand-analytics/search-terms', icon: BarChart3, label: 'Brand Analytics', badge: 'Pro+' },
      { href: '/dashboard/sku-performance', icon: Activity,   label: 'SKU Performance' },
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { href: '/dashboard/pincode-checker', icon: MapPin,     label: 'Pincode Checker', badge: 'Queue' },
      { href: '/dashboard/buy-box',     icon: ShoppingCart,   label: 'Buy Box',         badge: 'Queue' },
      { href: '/dashboard/competitors', icon: Users,          label: 'Competitors',     badge: 'Pro+' },
      { href: '/dashboard/alerts',      icon: Bell,           label: 'Alerts' },
    ],
  },
  {
    section: 'Reports',
    items: [
      { href: '/dashboard/reports', icon: FileText, label: 'Reports', badge: 'Pro+' },
    ],
  },
  {
    section: 'Account',
    items: [
      { href: '/dashboard/billing',  icon: CreditCard, label: 'Billing' },
      { href: '/dashboard/settings', icon: Settings,   label: 'Settings' },
    ],
  },
]

interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const pathname = usePathname()
  const [showInternalDashboard, setShowInternalDashboard] = useState(false)

  useEffect(() => {
    let active = true

    void fetch('/api/entitlements', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (active) setShowInternalDashboard(data?.internalTest === true)
      })
      .catch(() => {
        if (active) setShowInternalDashboard(false)
      })

    return () => {
      active = false
    }
  }, [])

  const visibleSections = showInternalDashboard
    ? [
        {
          section: 'Internal',
          items: [
            { href: '/dashboard/internal', icon: FlaskConical, label: 'Internal Dashboard' },
            { href: '/dashboard/internal/easyhome-diagnostic', icon: Megaphone, label: 'EasyHOME Brahmastra' },
          ],
        },
        ...navSections,
      ]
    : navSections

  return (
    <div className={cn('flex flex-col h-full bg-sidebar border-r border-sidebar-border', className)}>
      {/* Logo */}
      <div className="p-5 border-b border-sidebar-border flex-shrink-0">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <Image src="/logo.svg" alt="Sociomonkey" width={30} height={30} className="flex-shrink-0" />
          <div>
            <span className="text-xl font-black block leading-none">
              Socio<span className="text-primary">monkey</span>
            </span>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-none">Amazon Intelligence</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {visibleSections.map(section => (
          <div key={section.section}>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-3 mb-1">
              {section.section}
            </p>
            <ul className="space-y-0.5">
              {section.items.map(item => {
                const isActive = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150',
                        isActive
                          ? 'bg-primary text-primary-foreground font-semibold shadow-sm'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
                      )}
                    >
                      <item.icon className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && !isActive && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] py-0 px-1.5 h-4 font-medium flex-shrink-0"
                        >
                          {item.badge}
                        </Badge>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Upgrade CTA */}
      <div className="p-3 border-t border-sidebar-border flex-shrink-0">
        <SidebarPlanCard />
      </div>
    </div>
  )
}
