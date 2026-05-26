export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account preferences, notifications, and API access.
        </p>
      </div>
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed border-border text-muted-foreground text-sm">
        Settings module coming soon
      </div>
    </div>
  )
}
