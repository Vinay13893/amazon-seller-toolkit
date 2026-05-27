'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { normalizeEmbed } from '@/lib/supabase/normalize'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  User, Building2, Palette, Bell, ShoppingBag,
  Shield, ChevronDown, Loader2, Check, Sun, Moon,
  LogOut, Key, Globe, MapPin, RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from 'next-themes'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  id: string
  full_name: string | null
  email: string | null
  company_name: string | null
}

interface Workspace {
  id: string
  name: string
  type: 'seller' | 'agency' | 'brand'
}

type WorkspaceType = 'seller' | 'agency' | 'brand'
type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

interface NotificationPrefs {
  email_alerts: boolean
  buybox_alerts: boolean
  bsr_alerts: boolean
  keyword_alerts: boolean
  pincode_alerts: boolean
}

// ─── Section card wrapper ─────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-muted/20">
        <Icon className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
        <div>
          <h2 className="font-semibold text-sm text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  )
}

// ─── Field row ────────────────────────────────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-start">
      <Label className="text-xs font-medium text-muted-foreground pt-2 sm:text-right">{label}</Label>
      <div className="sm:col-span-2">{children}</div>
    </div>
  )
}

// ─── Toggle switch ────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

// ─── Select ───────────────────────────────────────────────────────────────────

function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  disabled?: boolean
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        disabled={disabled}
        className={cn(
          'h-8 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-50',
          'dark:bg-input/30'
        )}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  // ── Data state ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [role, setRole] = useState<MemberRole>('member')

  // ── Edit state ──────────────────────────────────────────────────────────
  const [fullName, setFullName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [wsName, setWsName] = useState('')
  const [wsType, setWsType] = useState<WorkspaceType>('seller')

  // ── Notification prefs (local only — no db table yet) ───────────────────
  const [notifs, setNotifs] = useState<NotificationPrefs>({
    email_alerts: true,
    buybox_alerts: true,
    bsr_alerts: true,
    keyword_alerts: false,
    pincode_alerts: false,
  })

  // ── Amazon tool prefs (local placeholder) ──────────────────────────────
  const [defaultMarketplace, setDefaultMarketplace] = useState<'IN' | 'US'>('IN')
  const [defaultPincodes, setDefaultPincodes] = useState('')

  // ── Save states ─────────────────────────────────────────────────────────
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingWorkspace, setSavingWorkspace] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  // ── Load data ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      setUserEmail(user.email ?? '')

      // Profile
      const { data: prof } = await supabase
        .from('profiles')
        .select('id, full_name, email, company_name')
        .eq('id', user.id)
        .single()

      if (prof) {
        setProfile(prof)
        setFullName(prof.full_name ?? '')
        setCompanyName(prof.company_name ?? '')
      }

      // Workspace + role
      const { data: mem } = await supabase
        .from('workspace_members')
        .select('role, workspaces(id, name, type)')
        .eq('user_id', user.id)
        .limit(1)
        .single()

      if (mem) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const memAny = mem as any
        setRole(memAny.role as MemberRole)
        const ws = normalizeEmbed<Workspace>(memAny.workspaces)
        if (ws) {
          setWorkspace(ws)
          setWsName(ws.name ?? '')
          setWsType(ws.type ?? 'seller')
        }
      }
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  // ── Save profile ────────────────────────────────────────────────────────
  async function handleSaveProfile() {
    if (!profile) return
    setSavingProfile(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('profiles')
        .update({ full_name: fullName.trim() || null, company_name: companyName.trim() || null })
        .eq('id', profile.id)
      if (error) throw error
      toast.success('Profile saved')
    } catch (err) {
      toast.error('Failed to save profile: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSavingProfile(false)
    }
  }

  // ── Save workspace ──────────────────────────────────────────────────────
  async function handleSaveWorkspace() {
    if (!workspace) return
    setSavingWorkspace(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('workspaces')
        .update({ name: wsName.trim(), type: wsType })
        .eq('id', workspace.id)
      if (error) throw error
      toast.success('Workspace updated')
    } catch (err) {
      toast.error('Failed to update workspace: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSavingWorkspace(false)
    }
  }

  // ── Change password ─────────────────────────────────────────────────────
  async function handleChangePassword() {
    if (!userEmail) return
    setSendingReset(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
        redirectTo: `${window.location.origin}/auth/callback?next=/dashboard/settings`,
      })
      if (error) throw error
      toast.success('Password reset email sent — check your inbox')
    } catch (err) {
      toast.error('Failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSendingReset(false)
    }
  }

  // ── Logout ──────────────────────────────────────────────────────────────
  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const canEditWorkspace = role === 'owner' || role === 'admin'
  const isDark = theme === 'dark'

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, workspace, and app preferences.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading settings…
        </div>
      ) : (
        <>
          {/* ── 1. Profile Settings ──────────────────────────────────────── */}
          <Section icon={User} title="Profile" description="Your public identity on Sociomonkey">
            <div className="flex flex-col gap-4">
              <FieldRow label="Full name">
                <Input
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="Your full name"
                />
              </FieldRow>
              <FieldRow label="Email">
                <Input value={userEmail} readOnly disabled className="cursor-not-allowed" />
                <p className="text-xs text-muted-foreground mt-1">Email cannot be changed here.</p>
              </FieldRow>
              <FieldRow label="Company / Brand">
                <Input
                  value={companyName}
                  onChange={e => setCompanyName(e.target.value)}
                  placeholder="e.g. eHomekart India"
                />
              </FieldRow>
              <div className="flex justify-end pt-1">
                <Button onClick={handleSaveProfile} disabled={savingProfile} size="sm">
                  {savingProfile ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : <><Check className="w-3.5 h-3.5" /> Save changes</>}
                </Button>
              </div>
            </div>
          </Section>

          {/* ── 2. Workspace Settings ────────────────────────────────────── */}
          <Section icon={Building2} title="Workspace" description="Settings for your Amazon seller workspace">
            <div className="flex flex-col gap-4">
              <FieldRow label="Workspace name">
                <Input
                  value={wsName}
                  onChange={e => setWsName(e.target.value)}
                  placeholder="My Workspace"
                  disabled={!canEditWorkspace}
                />
              </FieldRow>
              <FieldRow label="Workspace type">
                <Select<WorkspaceType>
                  value={wsType}
                  onChange={setWsType}
                  disabled={!canEditWorkspace}
                  options={[
                    { value: 'seller', label: 'Seller' },
                    { value: 'agency', label: 'Agency' },
                    { value: 'brand', label: 'Brand' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Your role">
                <div className="flex items-center h-8">
                  <span className="text-sm capitalize text-foreground font-medium">{role}</span>
                  {!canEditWorkspace && (
                    <span className="ml-2 text-xs text-muted-foreground">(only owners/admins can edit workspace)</span>
                  )}
                </div>
              </FieldRow>
              {canEditWorkspace && (
                <div className="flex justify-end pt-1">
                  <Button onClick={handleSaveWorkspace} disabled={savingWorkspace} size="sm">
                    {savingWorkspace ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : <><Check className="w-3.5 h-3.5" /> Save changes</>}
                  </Button>
                </div>
              )}
            </div>
          </Section>

          {/* ── 3. Theme Preferences ────────────────────────────────────── */}
          <Section icon={Palette} title="Theme" description="Visual appearance of the dashboard">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isDark
                  ? <Moon className="w-4 h-4 text-primary" />
                  : <Sun className="w-4 h-4 text-primary" />}
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {isDark ? 'Dark mode' : 'Light mode'} is active
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Use the <span className="font-medium text-foreground">☀ / ☾ toggle in the top bar</span> to switch modes.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTheme(isDark ? 'light' : 'dark')}
              >
                Switch to {isDark ? 'light' : 'dark'}
              </Button>
            </div>
          </Section>

          {/* ── 4. Notification Preferences ──────────────────────────────── */}
          <Section icon={Bell} title="Notifications" description="Choose which alerts you receive by email">
            <div className="flex flex-col gap-4">
              {(
                [
                  { key: 'email_alerts',   label: 'Email alerts',              desc: 'Receive all alerts via email' },
                  { key: 'buybox_alerts',  label: 'Buy Box alerts',            desc: 'Notify when Buy Box ownership changes' },
                  { key: 'bsr_alerts',     label: 'BSR alerts',                desc: 'Notify on significant BSR rank changes' },
                  { key: 'keyword_alerts', label: 'Keyword rank alerts',       desc: 'Notify when keyword positions shift' },
                  { key: 'pincode_alerts', label: 'Pincode availability alerts', desc: 'Notify when product availability changes by pincode' },
                ] as { key: keyof NotificationPrefs; label: string; desc: string }[]
              ).map(item => (
                <div key={item.key} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                  <Toggle
                    checked={notifs[item.key]}
                    onChange={v => setNotifs(prev => ({ ...prev, [item.key]: v }))}
                  />
                </div>
              ))}
              <p className="text-xs text-muted-foreground border-t border-border pt-3 mt-1">
                Notification delivery is not yet connected to a backend. Settings are saved locally for now.
              </p>
            </div>
          </Section>

          {/* ── 5. Amazon Tool Settings ──────────────────────────────────── */}
          <Section icon={ShoppingBag} title="Amazon Tool Settings" description="Default configuration for scraping and tracking tools">
            <div className="flex flex-col gap-4">
              <FieldRow label="Default marketplace">
                <Select<'IN' | 'US'>
                  value={defaultMarketplace}
                  onChange={setDefaultMarketplace}
                  options={[
                    { value: 'IN', label: 'Amazon India (amazon.in)' },
                    { value: 'US', label: 'Amazon US (amazon.com)' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Default pincodes">
                <Input
                  value={defaultPincodes}
                  onChange={e => setDefaultPincodes(e.target.value)}
                  placeholder="e.g. 110001, 400001, 560001"
                />
                <p className="text-xs text-muted-foreground mt-1">Comma-separated pincodes used in pincode availability checks.</p>
              </FieldRow>
              <FieldRow label="Refresh frequency">
                <div className="flex items-center gap-2 h-8">
                  <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Determined by your plan. Upgrade to increase frequency.</span>
                </div>
              </FieldRow>
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 flex items-start gap-2.5 mt-1">
                <Globe className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium text-foreground">Amazon Scraper Credentials</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Seller account credentials and Amazon SP-API keys will be configured here in a future update.
                    No credentials are stored at this time.
                  </p>
                </div>
              </div>
            </div>
          </Section>

          {/* ── 6. Security ──────────────────────────────────────────────── */}
          <Section icon={Shield} title="Security" description="Manage your account security and session">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Change password</p>
                  <p className="text-xs text-muted-foreground">A reset link will be sent to {userEmail || 'your email'}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangePassword}
                  disabled={sendingReset}
                >
                  {sendingReset
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
                    : <><Key className="w-3.5 h-3.5" /> Send reset email</>}
                </Button>
              </div>
              <div className="border-t border-border pt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Sign out</p>
                  <p className="text-xs text-muted-foreground">End your current session on this device</p>
                </div>
                <Button variant="destructive" size="sm" onClick={handleLogout}>
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </Button>
              </div>
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
