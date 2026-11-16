'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, HelpCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type FeatureGuideStep = { title: string; description: string }

export function FeatureGuide({ guideKey, title, steps }: { guideKey: string; title: string; steps: FeatureGuideStep[] }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const storageKey = `brahmastra-guide:${guideKey}:v1`

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (window.localStorage.getItem(storageKey) !== 'done') setOpen(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [storageKey])

  const close = () => {
    window.localStorage.setItem(storageKey, 'done')
    setOpen(false)
  }

  return <>
    <Button type="button" variant="outline" size="sm" onClick={() => { setStep(0); setOpen(true) }} className="fixed bottom-5 right-5 z-40 gap-2 rounded-full bg-background shadow-lg">
      <HelpCircle className="size-4" /> How to use
    </Button>
    {open && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={`${title} guide`}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><HelpCircle className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">{title} · Step {step + 1} of {steps.length}</p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">{steps[step].title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{steps[step].description}</p>
          </div>
          <button type="button" onClick={close} aria-label="Close guide" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
        </div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {steps.map((item, index) => <span key={item.title} className={`h-1.5 rounded-full transition-all ${index === step ? 'w-6 bg-primary' : 'w-1.5 bg-muted-foreground/30'}`} />)}
          </div>
          <div className="flex gap-2">
            {step > 0 && <Button type="button" variant="outline" size="sm" onClick={() => setStep(current => current - 1)}><ChevronLeft className="mr-1 size-4" /> Back</Button>}
            {step < steps.length - 1
              ? <Button type="button" size="sm" onClick={() => setStep(current => current + 1)}>Next <ChevronRight className="ml-1 size-4" /></Button>
              : <Button type="button" size="sm" onClick={close}>Start using {title}</Button>}
          </div>
        </div>
      </div>
    </div>}
  </>
}
