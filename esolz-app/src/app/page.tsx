import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  TrendingUp, Package, MapPin, Users, Bell, BarChart3,
  CheckCircle2, ArrowRight, Zap, Shield, Globe,
} from 'lucide-react'

const features = [
  {
    icon: TrendingUp,
    title: 'Real-Time BSR Tracking',
    desc: 'Monitor Best Seller Rank across all categories with up to 15-minute refresh cycles. Never miss a rank change.',
  },
  {
    icon: MapPin,
    title: 'Pincode Delivery Checker',
    desc: "Verify Amazon's delivery coverage for any pincode in India. Optimise inventory placement for maximum reach.",
  },
  {
    icon: Users,
    title: 'Competitor Intelligence',
    desc: 'Track competitor ASINs, monitor BSR movements, pricing changes, and review velocity in real time.',
  },
  {
    icon: Package,
    title: 'Buy Box Monitor',
    desc: 'Get alerted instantly when you win or lose the Buy Box. Understand exactly what drives eligibility.',
  },
  {
    icon: BarChart3,
    title: 'Keyword Rank Tracker',
    desc: 'Track search rankings for critical keywords. Measure the impact of your PPC and SEO efforts.',
  },
  {
    icon: Bell,
    title: 'Smart Alerts',
    desc: 'Set threshold-based alerts for BSR drops, buy box losses, and competitor movements. Stay ahead always.',
  },
]

const plans = [
  {
    name: 'Free',
    price: 0,
    features: ['5 ASINs', '7-day history', 'BSR tracking', 'Manual refresh'],
    cta: 'Get Started',
    highlight: false,
    href: '/signup',
  },
  {
    name: 'Starter',
    price: 999,
    features: ['25 ASINs', '30-day history', '4-hour refresh', 'Pincode Checker', 'Keyword Tracker', '5 Alerts'],
    cta: 'Start Trial',
    highlight: false,
    href: '/signup',
  },
  {
    name: 'Pro',
    price: 2499,
    features: ['100 ASINs', '90-day history', '1-hour refresh', 'All tools', 'Buy Box Monitor', '20 Alerts', 'Reports'],
    cta: 'Go Pro',
    highlight: true,
    href: '/signup',
  },
  {
    name: 'Agency',
    price: 7999,
    features: ['500 ASINs', '1-year history', '15-min refresh', 'API access', 'White-label', 'Unlimited Alerts', 'Priority support'],
    cta: 'Contact Sales',
    highlight: false,
    href: '/signup',
  },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navbar */}
      <nav className="border-b border-border/50 sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="text-xl font-black flex-shrink-0">
            e-<span className="text-primary">Solz</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <Link href="#features" className="hover:text-foreground transition-colors">Features</Link>
            <Link href="#pricing" className="hover:text-foreground transition-colors">Pricing</Link>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" render={<Link href="/login" />}>
              Sign In
            </Button>
            <Button size="sm" render={<Link href="/signup" />}>
              Get Started Free
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 pb-16 text-center">
        <Badge variant="secondary" className="mb-6 gap-1.5 border-primary/20 bg-primary/10 text-primary">
          <Zap className="w-3 h-3" />
          Built for Amazon India Sellers
        </Badge>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight mb-6 leading-tight">
          The Amazon Intelligence
          <br />
          <span className="text-primary">Platform for Indian Sellers</span>
        </h1>
        <p className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-10">
          Track BSR in real-time, monitor competitors, check delivery pincodes &amp; optimise your
          Amazon strategy — all in one powerful dashboard.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
          <Button size="lg" render={<Link href="/signup" />} className="text-base px-8">
            Start Free — No Credit Card <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
          <Button size="lg" variant="outline" render={<Link href="/login" />} className="text-base px-8">
            View Demo Dashboard
          </Button>
        </div>
        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-3xl mx-auto">
          {[
            { n: '500+',  l: 'Active Sellers' },
            { n: '50K+',  l: 'ASINs Tracked' },
            { n: '99.9%', l: 'Uptime SLA' },
            { n: '15min', l: 'Fastest Refresh' },
          ].map(s => (
            <div key={s.l} className="text-center">
              <div className="text-2xl font-black text-primary">{s.n}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">
            Everything you need to <span className="text-primary">win on Amazon</span>
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            From rank tracking to competitor analysis — built specifically for Amazon India sellers.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map(f => (
            <div
              key={f.title}
              className="bg-card border border-border rounded-xl p-6 hover:border-primary/40 transition-colors group"
            >
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                <f.icon className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-bold mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">
            Simple, <span className="text-primary">transparent pricing</span>
          </h2>
          <p className="text-muted-foreground">Pay monthly, cancel anytime. All plans include free setup.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {plans.map(p => (
            <div
              key={p.name}
              className={`relative bg-card border rounded-xl p-6 flex flex-col ${
                p.highlight
                  ? 'border-primary shadow-[0_0_40px_rgba(255,153,0,0.12)]'
                  : 'border-border'
              }`}
            >
              {p.highlight && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground border-0 whitespace-nowrap">
                  Most Popular
                </Badge>
              )}
              <div className="mb-6">
                <h3 className="font-bold text-lg mb-1">{p.name}</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black text-primary">
                    {p.price === 0 ? 'Free' : `₹${p.price.toLocaleString('en-IN')}`}
                  </span>
                  {p.price > 0 && <span className="text-muted-foreground text-sm">/mo</span>}
                </div>
              </div>
              <ul className="space-y-2.5 flex-1 mb-6">
                {p.features.map(f => (
                  <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button variant={p.highlight ? 'default' : 'outline'} render={<Link href={p.href} />} className="w-full">
                {p.cta}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <div className="bg-card border border-primary/20 rounded-2xl p-10 sm:p-14 text-center shadow-[0_0_80px_rgba(255,153,0,0.06)]">
          <Shield className="w-12 h-12 text-primary mx-auto mb-4" />
          <h2 className="text-3xl sm:text-4xl font-black mb-3">
            Ready to grow your <span className="text-primary">Amazon business?</span>
          </h2>
          <p className="text-muted-foreground mb-8 max-w-lg mx-auto">
            Join hundreds of Amazon India sellers who use e-Solz to track, optimise, and scale.
          </p>
          <Button size="lg" render={<Link href="/signup" />} className="px-10 text-base">
            Create Free Account <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50 py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <div className="font-black text-foreground">
            e-<span className="text-primary">Solz</span>
            <span className="font-normal text-muted-foreground ml-2 text-sm">Amazon Intelligence</span>
          </div>
          <div className="flex gap-6">
            <Link href="#pricing" className="hover:text-foreground transition-colors">Pricing</Link>
            <Link href="#" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link href="#" className="hover:text-foreground transition-colors">Terms</Link>
          </div>
          <p>© 2025 e-Solz. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
