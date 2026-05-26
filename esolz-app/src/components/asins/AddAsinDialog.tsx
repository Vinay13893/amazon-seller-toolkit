'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Plus, AlertCircle } from 'lucide-react'
import { Marketplace } from '@/types'

interface AddAsinDialogProps {
  onAdd: (asin: string, label: string, marketplace: Marketplace) => void
  currentCount: number
  maxCount: number
}

const ASIN_REGEX = /^[A-Z0-9]{10}$/

const MARKETPLACES: { value: Marketplace; label: string }[] = [
  { value: 'IN', label: '🇮🇳 Amazon India (IN)' },
  { value: 'US', label: '🇺🇸 Amazon US (US)' },
  { value: 'UK', label: '🇬🇧 Amazon UK (UK)' },
  { value: 'DE', label: '🇩🇪 Amazon Germany (DE)' },
]

export function AddAsinDialog({ onAdd, currentCount, maxCount }: AddAsinDialogProps) {
  const [open, setOpen] = useState(false)
  const [asin, setAsin] = useState('')
  const [label, setLabel] = useState('')
  const [marketplace, setMarketplace] = useState<Marketplace>('IN')
  const [errors, setErrors] = useState<{ asin?: string; label?: string }>({})

  const atLimit = currentCount >= maxCount

  function validate(): boolean {
    const errs: { asin?: string; label?: string } = {}
    const trimmedAsin = asin.trim().toUpperCase()
    if (!trimmedAsin) {
      errs.asin = 'ASIN is required'
    } else if (!ASIN_REGEX.test(trimmedAsin)) {
      errs.asin = 'ASIN must be exactly 10 uppercase alphanumeric characters (e.g. B0BN5NZCGH)'
    }
    if (!label.trim()) {
      errs.label = 'Product label is required'
    } else if (label.trim().length > 80) {
      errs.label = 'Label must be 80 characters or fewer'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    onAdd(asin.trim().toUpperCase(), label.trim(), marketplace)
    // Reset form
    setAsin('')
    setLabel('')
    setMarketplace('IN')
    setErrors({})
    setOpen(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setAsin('')
      setLabel('')
      setMarketplace('IN')
      setErrors({})
    }
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button disabled={atLimit} className="gap-1.5" />
        }
      >
        <Plus className="size-4" />
        Add ASIN
      </DialogTrigger>

      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Track a New ASIN</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Enter the Amazon ASIN you want to monitor. We'll start tracking its
            BSR, category, and rank history immediately.
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-2">
          {/* ASIN field */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asin-input">
              ASIN <span className="text-destructive">*</span>
            </Label>
            <Input
              id="asin-input"
              placeholder="B0BN5NZCGH"
              value={asin}
              onChange={e => {
                setAsin(e.target.value.toUpperCase())
                if (errors.asin) setErrors(prev => ({ ...prev, asin: undefined }))
              }}
              maxLength={10}
              className="font-mono tracking-wider uppercase"
              autoComplete="off"
              spellCheck={false}
            />
            {errors.asin ? (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="size-3 shrink-0" />
                {errors.asin}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                10-character Amazon product identifier. Found in the product URL or detail page.
              </p>
            )}
          </div>

          {/* Label field */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="label-input">
              Product Label <span className="text-destructive">*</span>
            </Label>
            <Input
              id="label-input"
              placeholder="e.g. Ghee 1L – Main Listing"
              value={label}
              onChange={e => {
                setLabel(e.target.value)
                if (errors.label) setErrors(prev => ({ ...prev, label: undefined }))
              }}
              maxLength={80}
            />
            {errors.label ? (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="size-3 shrink-0" />
                {errors.label}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                A friendly name to identify this listing in your dashboard.
              </p>
            )}
          </div>

          {/* Marketplace select */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="marketplace-select">Marketplace</Label>
            <select
              id="marketplace-select"
              value={marketplace}
              onChange={e => setMarketplace(e.target.value as Marketplace)}
              className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 py-1 text-sm text-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {MARKETPLACES.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button type="submit" className="w-full sm:w-auto">
              Start Tracking
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
