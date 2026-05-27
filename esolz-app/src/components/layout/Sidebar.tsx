'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, Package, TrendingUp, Tag, MapPin,
  ShoppingCart, Users, Bell, FileText, CreditCard,
  Settings,
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
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { href: '/dashboard/pincode',     icon: MapPin,         label: 'Pincode Checker', badge: 'Starter+' },
      { href: '/dashboard/buybox',      icon: ShoppingCart,   label: 'Buy Box',         badge: 'Pro+' },
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

  return (
    <div className={cn('flex flex-col h-full bg-sidebar border-r border-sidebar-border', className)}>
      {/* Logo */}
      <div className="p-5 border-b border-sidebar-border flex-shrink-0">
        <Link href="/dashboard" className="text-xl font-black block">
          Socio<span className="text-primary">monkey</span>
        </Link>
        <p className="text-xs text-muted-foreground mt-0.5">Amazon Intelligence</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {navSections.map(section => (
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
