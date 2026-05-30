/**
 * Server-side only — NEVER import from client components.
 *
 * Queries real Supabase data, applies rule-based logic, and inserts new
 * alerts into the `alerts` table. Deduplication is enforced against
 * existing open (status='new') alerts with the same
 * (workspace_id, tracked_asin_id, module, title) combination.
 */
import { createAdminClient } from '@/lib/supabase/admin'

// ─── Internal types ───────────────────────────────────────────────────────────

type Severity = 'critical' | 'warning' | 'opportunity' | 'info'
type Module   = 'bsr' | 'buybox' | 'pincode' | 'keywords'

interface AlertInsert {
  workspace_id:      string
  tracked_asin_id:   string | null
  title:             string
  description:       string
  severity:          Severity
  module:            Module
  status:            'new'
  recommended_action: string
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generates rule-based alerts for a workspace and inserts them.
 * Returns the count of newly created alerts.
 */
export async function generateAlerts(workspaceId: string): Promise<number> {
  const admin = createAdminClient()

  // ── 1. Get all active tracked ASINs ──────────────────────────────────────
  const { data: asins, error: asinErr } = await admin
    .from('tracked_asins')
    .select('id, asin, product_title, marketplace')
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')

  if (asinErr || !asins?.length) return 0

  const asinIds = asins.map((a: { id: string }) => a.id)
  const asinById = new Map(asins.map((a: { id: string; asin: string; product_title: string | null; marketplace: string }) => [a.id, a]))

  // ── 2. Load existing open alerts (for dedup) ──────────────────────────────
  const { data: existingAlerts } = await admin
    .from('alerts')
    .select('tracked_asin_id, module, title')
    .eq('workspace_id', workspaceId)
    .eq('status', 'new')

  const existingSet = new Set<string>()
  for (const a of (existingAlerts ?? [])) {
    existingSet.add(`${a.tracked_asin_id ?? 'null'}|${a.module}|${a.title}`)
  }

  function isDupe(asinId: string | null, mod: Module, title: string): boolean {
    return existingSet.has(`${asinId ?? 'null'}|${mod}|${title}`)
  }
  function markSeen(asinId: string | null, mod: Module, title: string) {
    existingSet.add(`${asinId ?? 'null'}|${mod}|${title}`)
  }

  function label(id: string): string {
    const a = asinById.get(id)
    return a ? (a.product_title ?? a.asin) : id
  }

  const toInsert: AlertInsert[] = []

  // ── A. BSR alerts ─────────────────────────────────────────────────────────
  // Rule: latest BSR worse than prev by >20% → warning/critical
  //       latest BSR better than prev by >20% → opportunity
  {
    const { data: rows } = await admin
      .from('asin_snapshots')
      .select('tracked_asin_id, bsr, buy_box_owner, buy_box_status, checked_at')
      .eq('workspace_id', workspaceId)
      .in('tracked_asin_id', asinIds)
      .not('bsr', 'is', null)
      .order('checked_at', { ascending: false })

    // Group by ASIN, keep latest 2 per ASIN
    type BsrRow = { bsr: number; buy_box_owner: string | null; buy_box_status: string | null }
    const byAsin = new Map<string, BsrRow[]>()
    for (const r of (rows ?? [])) {
      if (!r.tracked_asin_id) continue
      const list = byAsin.get(r.tracked_asin_id) ?? []
      if (list.length < 2) {
        list.push({ bsr: r.bsr as number, buy_box_owner: r.buy_box_owner, buy_box_status: r.buy_box_status })
        byAsin.set(r.tracked_asin_id, list)
      }
    }

    for (const [asinId, snaps] of byAsin.entries()) {
      if (snaps.length < 2) continue
      const [latest, prev] = snaps

      // BSR change: positive = worsened (larger rank # = worse)
      const change = (latest.bsr - prev.bsr) / prev.bsr

      if (change > 0.20) {
        const pct = Math.round(change * 100)
        const severity: Severity = change > 0.50 ? 'critical' : 'warning'
        const title = severity === 'critical' ? 'BSR Dropped Sharply' : 'BSR Dropped'
        if (!isDupe(asinId, 'bsr', title)) {
          markSeen(asinId, 'bsr', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `${label(asinId)}: BSR worsened by ${pct}% — from #${prev.bsr.toLocaleString('en-IN')} to #${latest.bsr.toLocaleString('en-IN')}.`,
            severity,
            module: 'bsr',
            status: 'new',
            recommended_action:
              'Review pricing, inventory levels, and recent competitor activity. Check if a rival ASIN is gaining traction.',
          })
        }
      } else if (change < -0.20) {
        const pct = Math.round(Math.abs(change) * 100)
        const title = 'BSR Improved'
        if (!isDupe(asinId, 'bsr', title)) {
          markSeen(asinId, 'bsr', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `${label(asinId)}: BSR improved by ${pct}% — from #${prev.bsr.toLocaleString('en-IN')} to #${latest.bsr.toLocaleString('en-IN')}.`,
            severity: 'opportunity',
            module: 'bsr',
            status: 'new',
            recommended_action:
              'Great momentum! Consider increasing ad spend or running a promotion to capitalise on the improved ranking.',
          })
        }
      }

      // Buy Box status change derived from BSR snapshots (has won/lost/suppressed)
      const prevStatus   = prev.buy_box_status
      const latestStatus = latest.buy_box_status
      if (prevStatus && latestStatus && prevStatus !== latestStatus) {
        if (prevStatus === 'won' && latestStatus === 'lost') {
          const title = 'Buy Box Lost'
          if (!isDupe(asinId, 'buybox', title)) {
            markSeen(asinId, 'buybox', title)
            toInsert.push({
              workspace_id: workspaceId,
              tracked_asin_id: asinId,
              title,
              description: `${label(asinId)}: Buy Box status changed from "won" to "lost".`,
              severity: 'critical',
              module: 'buybox',
              status: 'new',
              recommended_action:
                'Lower your price, check competitor offers, and ensure your FBA stock is not running out.',
            })
          }
        } else if (prevStatus !== 'won' && latestStatus === 'won') {
          const title = 'Buy Box Regained'
          if (!isDupe(asinId, 'buybox', title)) {
            markSeen(asinId, 'buybox', title)
            toInsert.push({
              workspace_id: workspaceId,
              tracked_asin_id: asinId,
              title,
              description: `${label(asinId)}: You regained the Buy Box (was: ${prevStatus}).`,
              severity: 'opportunity',
              module: 'buybox',
              status: 'new',
              recommended_action:
                'Maintain current pricing and stock levels to keep the Buy Box.',
            })
          }
        }
      }
    }
  }

  // ── B. Buy Box alerts (from buybox_snapshots) ──────────────────────────────
  // Rule: seller name changes between latest two checks → warning
  {
    const { data: rows } = await admin
      .from('buybox_snapshots')
      .select('tracked_asin_id, buy_box_owner, checked_at')
      .eq('workspace_id', workspaceId)
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })

    type BbRow = { buy_box_owner: string | null }
    const byAsin = new Map<string, BbRow[]>()
    for (const r of (rows ?? [])) {
      if (!r.tracked_asin_id) continue
      const list = byAsin.get(r.tracked_asin_id) ?? []
      if (list.length < 2) {
        list.push({ buy_box_owner: r.buy_box_owner })
        byAsin.set(r.tracked_asin_id, list)
      }
    }

    for (const [asinId, snaps] of byAsin.entries()) {
      if (snaps.length < 2) continue
      const [latest, prev] = snaps
      if (
        prev.buy_box_owner &&
        latest.buy_box_owner &&
        prev.buy_box_owner !== latest.buy_box_owner
      ) {
        const title = 'Buy Box Seller Changed'
        if (!isDupe(asinId, 'buybox', title)) {
          markSeen(asinId, 'buybox', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `Buy Box for ${label(asinId)} changed from "${prev.buy_box_owner}" to "${latest.buy_box_owner}".`,
            severity: 'warning',
            module: 'buybox',
            status: 'new',
            recommended_action:
              'Check if the new seller is a competitor or reseller. Review your pricing and fulfillment to win back the Buy Box.',
          })
        }
      }
    }
  }

  // ── C. Pincode alerts ──────────────────────────────────────────────────────
  // Rule: >30% of pincodes unavailable → critical / warning
  //       any pincode unavailable → warning (if ≤30%)
  //       checker/runtime failures are excluded from availability ratio
  {
    const { data: rows } = await admin
      .from('pincode_checks')
      .select('tracked_asin_id, pincode, available, checked_at, delivery_promise')
      .eq('workspace_id', workspaceId)
      .in('tracked_asin_id', asinIds)
      .order('checked_at', { ascending: false })

    // Latest state per (asin, pincode)
    const seenKey  = new Set<string>()
    const pinStats = new Map<string, { total: number; unavailable: number; failed: number }>()

    for (const r of (rows ?? [])) {
      if (!r.tracked_asin_id) continue
      const k = `${r.tracked_asin_id}|${r.pincode}`
      if (seenKey.has(k)) continue
      seenKey.add(k)

      const entry = pinStats.get(r.tracked_asin_id) ?? { total: 0, unavailable: 0, failed: 0 }
      const isFailed = (r.delivery_promise ?? '').toLowerCase().startsWith('check failed:')
      if (isFailed) {
        entry.failed++
      } else {
        entry.total++
        if (r.available === false) entry.unavailable++
      }
      pinStats.set(r.tracked_asin_id, entry)
    }

    for (const [asinId, stats] of pinStats.entries()) {
      if (stats.total === 0 && stats.failed > 0) {
        const title = 'Pincode Checker Unavailable'
        if (!isDupe(asinId, 'pincode', title)) {
          markSeen(asinId, 'pincode', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `${label(asinId)}: latest pincode checks failed (${stats.failed} failed checks). Availability not calculated.`,
            severity: 'warning',
            module: 'pincode',
            status: 'new',
            recommended_action:
              'Retry pincode checks and verify checker stability before acting on pincode availability.',
          })
        }
        continue
      }

      if (stats.total === 0 || stats.unavailable === 0) continue
      const pct = stats.unavailable / stats.total

      if (pct > 0.30) {
        const pctStr = Math.round(pct * 100)
        const severity: Severity = pct > 0.60 ? 'critical' : 'warning'
        const title = 'High Pincode Unavailability'
        if (!isDupe(asinId, 'pincode', title)) {
          markSeen(asinId, 'pincode', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `${label(asinId)}: unavailable in ${stats.unavailable}/${stats.total} pincodes (${pctStr}%).`,
            severity,
            module: 'pincode',
            status: 'new',
            recommended_action:
              'Review FBA inventory levels and check for regional restrictions. Consider enabling pan-India delivery.',
          })
        }
      } else {
        const title = 'Pincode Availability Issue'
        if (!isDupe(asinId, 'pincode', title)) {
          markSeen(asinId, 'pincode', title)
          toInsert.push({
            workspace_id: workspaceId,
            tracked_asin_id: asinId,
            title,
            description: `${label(asinId)}: unavailable in ${stats.unavailable}/${stats.total} pincodes.`,
            severity: 'warning',
            module: 'pincode',
            status: 'new',
            recommended_action:
              'Check inventory for affected regions. Verify FBA shipment was received at regional fulfilment centres.',
          })
        }
      }
    }
  }

  // ── D. Keyword alerts ──────────────────────────────────────────────────────
  // Rule: page_status dropped from page_1 → warning/critical
  //       page_status entered page_1 → opportunity
  {
    const { data: keywords } = await admin
      .from('tracked_keywords')
      .select('id, keyword, tracked_asin_id')
      .eq('workspace_id', workspaceId)

    if (keywords?.length) {
      const kwIds = (keywords as { id: string; keyword: string; tracked_asin_id: string | null }[]).map(k => k.id)

      const { data: kwRows } = await admin
        .from('keyword_rank_snapshots')
        .select('tracked_keyword_id, page_status, checked_at')
        .eq('workspace_id', workspaceId)
        .in('tracked_keyword_id', kwIds)
        .order('checked_at', { ascending: false })

      // Latest 2 snapshots per keyword
      type KwRow = { page_status: string | null }
      const byKw = new Map<string, KwRow[]>()
      for (const r of (kwRows ?? [])) {
        const list = byKw.get(r.tracked_keyword_id) ?? []
        if (list.length < 2) {
          list.push({ page_status: r.page_status })
          byKw.set(r.tracked_keyword_id, list)
        }
      }

      const kwById = new Map(
        (keywords as { id: string; keyword: string; tracked_asin_id: string | null }[]).map(k => [k.id, k])
      )

      for (const [kwId, snaps] of byKw.entries()) {
        if (snaps.length < 2) continue
        const [latest, prev] = snaps
        if (!prev.page_status || !latest.page_status) continue
        if (prev.page_status === latest.page_status) continue

        const kw     = kwById.get(kwId)
        if (!kw) continue
        const asinId = kw.tracked_asin_id ?? null
        const asn    = asinId ? asinById.get(asinId) : null
        const prodLabel = asn ? (asn.product_title ?? asn.asin) : 'an ASIN'
        const statusLabel = (s: string) => s.replace('_', ' ').replace('page ', 'Page ')

        if (prev.page_status === 'page_1' && latest.page_status !== 'page_1') {
          const severity: Severity = latest.page_status === 'not_ranking' ? 'critical' : 'warning'
          const title = `"${kw.keyword}" Dropped from Page 1`
          if (!isDupe(asinId, 'keywords', title)) {
            markSeen(asinId, 'keywords', title)
            toInsert.push({
              workspace_id: workspaceId,
              tracked_asin_id: asinId,
              title,
              description: `Keyword "${kw.keyword}" for ${prodLabel} moved from Page 1 to ${statusLabel(latest.page_status)}.`,
              severity,
              module: 'keywords',
              status: 'new',
              recommended_action:
                'Review keyword campaign bids. Consider adding backend keywords and increasing sponsored products budget.',
            })
          }
        } else if (prev.page_status !== 'page_1' && latest.page_status === 'page_1') {
          const title = `"${kw.keyword}" Entered Page 1`
          if (!isDupe(asinId, 'keywords', title)) {
            markSeen(asinId, 'keywords', title)
            toInsert.push({
              workspace_id: workspaceId,
              tracked_asin_id: asinId,
              title,
              description: `Keyword "${kw.keyword}" for ${prodLabel} entered Page 1 (was: ${statusLabel(prev.page_status)}).`,
              severity: 'opportunity',
              module: 'keywords',
              status: 'new',
              recommended_action:
                'Boost momentum with additional sponsored ads and optimise listing title/bullets for this keyword.',
            })
          }
        }
      }
    }
  }

  // ── Insert ────────────────────────────────────────────────────────────────
  if (!toInsert.length) return 0

  const { data: inserted, error: insertErr } = await admin
    .from('alerts')
    .insert(toInsert)
    .select('id')

  if (insertErr) throw new Error(`Failed to insert alerts: ${insertErr.message}`)
  return inserted?.length ?? 0
}
