'use client'

import { useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { AmazonSyncWatcher } from '@/components/amazon/AmazonSyncWatcher'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Background sync watcher — stays alive across all dashboard routes */}
      <AmazonSyncWatcher />

      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-60 md:flex-shrink-0">
        <Sidebar className="w-full" />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="p-0 w-60 border-r border-sidebar-border">
          <Sidebar className="h-full" />
        </SheetContent>
      </Sheet>

      {/* Main area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
