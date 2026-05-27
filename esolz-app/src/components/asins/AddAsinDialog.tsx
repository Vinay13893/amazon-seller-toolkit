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
import { Plus, AlertCircle, Loader2 } from 'lucide-react'
import type { AddAsinInput } from '@/lib/supabase/asins'
import { Marketplace } from '@/types'

interface AddAsinDialogProps {
  onAdd: (data: AddAsinInput) => Promise<{ error?: string }>
  currentCount: number
  maxCount: number
}

const ASIN_REGEX = /^[A-Z0-9]{10}$/
const URL_REGEX  = /^https?:\/\/.+/i

const MARKETPLACES: { value: Marketplace; label: string }[] = [
  { value: 'IN', label: 'ðŸ‡®ðŸ‡³ Amazon India (IN)' },
  { value: 'US', label: 'ðŸ‡ºðŸ‡¸ Amazon US (US)' },
  { value: 'UK', label: 'ðŸ‡¬ðŸ‡§ Amazon UK (UK)' },
  { value: 'DE', label: 'ðŸ‡©ðŸ‡ª Amazon Germany (DE)' },
]

type FieldErrors = {
  asin?:         string
  productTitle?: string
  imageUrl?:     string
}

export function AddAsinDialog({ onAdd, currentCount, maxCount }: AddAsinDialogProps) {
  const [open,         setOpen]        = useState(false)
  const [asin,         setAsin]        = useState('')
  const [productTitle, setProductTitle]= useState('')
  const [marketplace,  setMarketplace] = useState<Marketplace>('IN')
  const [brand,        setBrand]       = useState('')
  const [category,     setCategory]    = useState('')
  const [imageUrl,     setImageUrl]    = useState('')
  const [errors,       setErrors]      = useState<FieldErrors>({})
  const [submitError,  setSubmitError] = useState('')
  const [submitting,   setSubmitting]  = useState(false)

  const atLimit = currentCount >= maxCount

  function resetForm() {
    setAsin('')
    setProductTitle('')
    setMarketplace('IN')
    setBrand('')
    setCategory('')
    setImageUrl('')
    setErrors({})
    setSubmitError('')
  }

  function validate(): boolean {
    const errs: FieldErrors = {}
    if (!asin.trim()) {
      errs.asin = 'ASIN is required'
    } else if (!ASIN_REGEX.test(asin.trim().toUpperCase())) {
      errs.asin = 'ASIN must be exactly 10 uppercase alphanumeric characters (e.g. B0BN5NZCGH)'
    }
    if (!productTitle.trim()) {
      errs.productTitle = 'Product title is required'
    } else if (productTitle.trim().length > 150) {
      errs.productTitle = 'Title must be 150 characters or fewer'
    }
    if (imageUrl.trim() && !URL_REGEX.test(imageUrl.trim())) {
      errs.imageUrl = 'Must be a valid URL starting with http:// or https://'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    setSubmitError('')
    setSubmitting(true)
    const result = await onAdd({
      asin:         asin.trim().toUpperCase(),
      productTitle: productTitle.trim(),
      marketplace,
      brand:        brand.trim(),
      category:     category.trim(),
      imageUrl:     imageUrl.trim(),
    })
    setSubmitting(false)
    if (result.error) {
      setSubmitError(result.error)
    } else {
      resetForm()
      setOpen(false)
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm()
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button disabled={atLimit} className="gap-1.5" />}
      >
        <Plus className="size-4" />
        Add ASIN
      </DialogTrigger>

      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Track a New ASIN</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Enter the Amazon ASIN you want to monitor. We&apos;ll start tracking its
            BSR, category, and rank history immediately.
          </p>
        </DialogHeader>

        {atLimit ? (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3">
              <AlertCircle className="size-4 shrink-0 text-destructive mt-0.5" />
              <p className="text-sm text-foreground">
                You have reached your ASIN limit. Upgrade your plan to add more ASINs.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-2">

            {/* Submit error banner */}
            {submitError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                <AlertCircle className="size-3.5 shrink-0 text-destructive mt-0.5" />
                <p className="text-xs text-destructive">{submitError}</p>
              </div>
            )}

            {/* ASIN */}
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
                  <AlertCircle className="size-3 shrink-0" />{errors.asin}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  10-character Amazon product identifier. Found in the product URL or detail page.
                </p>
              )}
            </div>

            {/* Product Title */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="title-input">
                Product Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title-input"
                placeholder="e.g. Daily Herbs A2 Ghee 1L"
                value={productTitle}
                onChange={e => {
                  setProductTitle(e.target.value)
                  if (errors.productTitle) setErrors(prev => ({ ...prev, productTitle: undefined }))
                }}
                maxLength={150}
              />
              {errors.productTitle ? (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="size-3 shrink-0" />{errors.productTitle}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A friendly name to identify this listing in your dashboard.
                </p>
              )}
            </div>

            {/* Marketplace */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="marketplace-select">Marketplace</Label>
              <select
                id="marketplace-select"
                value={marketplace}
                onChange={e => setMarketplace(e.target.value as Marketplace)}
                className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 py-1 text-sm text-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {MARKETPLACES.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* Brand */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-input">
                Brand <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="brand-input"
                placeholder="e.g. Daily Herbs"
                value={brand}
                onChange={e => setBrand(e.target.value)}
                maxLength={80}
              />
            </div>

            {/* Category */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category-input">
                Category <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="category-input"
                placeholder="e.g. Grocery &amp; Gourmet Foods"
                value={category}
                onChange={e => setCategory(e.target.value)}
                maxLength={80}
              />
            </div>

            {/* Image URL */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="image-url-input">
                Image URL <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="image-url-input"
                placeholder="https://m.media-amazon.com/images/I/..."
                value={imageUrl}
                onChange={e => {
                  setImageUrl(e.target.value)
                  if (errors.imageUrl) setErrors(prev => ({ ...prev, imageUrl: undefined }))
                }}
                type="url"
              />
              {errors.imageUrl && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="size-3 shrink-0" />{errors.imageUrl}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" className="w-full sm:w-auto" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Addingâ€¦
                  </>
                ) : (
                  'Start Tracking'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

