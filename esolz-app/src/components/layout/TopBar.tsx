'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Bell, Search, Menu } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import { ThemeToggle } from '@/components/ui/theme-toggle'

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard':           'Dashboard',
  '/dashboard/asins':     'ASIN Tracking',
  '/dashboard/bsr':       'BSR Tracker',
  '/dashboard/keywords':  'Keywords',
  '/dashboard/brand-analytics/search-terms': 'Brand Analytics',
  '/dashboard/pincode':   'Pincode Checker (Paused)',
  '/dashboard/pincode-checker': 'Pincode Availability Checker',
  '/dashboard/buy-box':   'Buy Box Monitor',
  '/dashboard/buybox':    'Buy Box',
  '/dashboard/competitors': 'Competitors',
  '/dashboard/alerts':    'Alerts',
  '/dashboard/reports':   'Reports',
  '/dashboard/billing':   'Billing',
  '/dashboard/settings':  'Settings',
}
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'

interface TopBarProps {
  title?: string
  onMenuClick?: () => void
}

export function TopBar({ title, onMenuClick }: TopBarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const displayTitle = title ?? ROUTE_TITLES[pathname] ?? (/^\/dashboard\/asins\/[^/]+$/.test(pathname) ? 'ASIN Detail' : 'Dashboard')

  const [userInfo, setUserInfo] = useState<{ name: string; email: string } | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUserInfo({
          email: user.email ?? '',
          name: (user.user_metadata?.full_name as string) || user.email || 'User',
        })
      }
    })
  }, [])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="h-14 border-b border-border/50 bg-background/95 backdrop-blur sticky top-0 z-40 flex items-center px-4 gap-3 flex-shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden text-muted-foreground"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </Button>

      <h1 className="font-bold text-lg flex-1 truncate">{displayTitle}</h1>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" aria-label="Search">
          <Search className="w-4 h-4" />
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground relative" aria-label="Notifications">
          <Bell className="w-4 h-4" />
          <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-primary rounded-full ring-1 ring-background" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center justify-center rounded-full w-8 h-8 ml-1 hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Account menu"
          >
            <Avatar className="w-8 h-8">
              <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                {userInfo ? userInfo.name.charAt(0).toUpperCase() : '?'}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="font-semibold text-sm text-foreground">{userInfo?.name ?? 'My Account'}</div>
                {userInfo?.email && (
                  <div className="text-xs text-muted-foreground truncate max-w-[160px] mt-0.5">{userInfo.email}</div>
                )}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/dashboard/settings" />}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/dashboard/billing" />}>
              Billing
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="text-destructive focus:text-destructive cursor-pointer"
            >
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
