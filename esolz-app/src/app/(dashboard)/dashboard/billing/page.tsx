export default function BillingPage() {
  const plans = [
    { name: 'Free', price: '₹0', asins: 5, refresh: 'Manual', current: true },
    { name: 'Starter', price: '₹999', asins: 25, refresh: '4 hours', current: false },
    { name: 'Pro', price: '₹2,499', asins: 100, refresh: '1 hour', current: false },
    { name: 'Agency', price: '₹7,999', asins: 500, refresh: '15 min', current: false },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Billing & Plans</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your subscription and upgrade for more features.
        </p>
      </div>

      {/* Current plan banner */}
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-medium text-foreground">Current Plan: <span className="text-primary">Free</span></p>
          <p className="text-sm text-muted-foreground mt-0.5">5 ASINs · Manual refresh · 7-day history</p>
        </div>
        <p className="text-xs text-muted-foreground">Razorpay payments coming soon</p>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.map(plan => (
          <div
            key={plan.name}
            className={`rounded-lg border p-4 flex flex-col gap-3 ${
              plan.current
                ? 'border-primary/40 bg-primary/5'
                : 'border-border bg-card'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">{plan.name}</span>
              {plan.current && (
                <span className="text-xs text-primary font-medium">Current</span>
              )}
            </div>
            <p className="text-2xl font-bold text-foreground">
              {plan.price}
              {plan.price !== '₹0' && <span className="text-sm font-normal text-muted-foreground">/mo</span>}
            </p>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              <li>{plan.asins} ASINs</li>
              <li>{plan.refresh} refresh</li>
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
