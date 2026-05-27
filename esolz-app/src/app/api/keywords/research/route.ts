import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * POST /api/keywords/research
 *
 * Returns keyword suggestions using Amazon's autocomplete API.
 * search_volume, cpc_estimate, difficulty are null — there is no
 * existing keyword-research tool in this workspace that provides those metrics.
 *
 * Body: { seedKeyword: string, marketplace?: "amazon.in" | "amazon.com", category?: string }
 */

const AUTOCOMPLETE_URLS: Record<string, string> = {
  'amazon.in':  'https://completion.amazon.in/api/2017/suggestions',
  'amazon.com': 'https://completion.amazon.com/api/2017/suggestions',
}
const MARKETPLACE_IDS: Record<string, string> = {
  'amazon.in':  'A21TJRUUN4KGV',
  'amazon.com': 'ATVPDKIKX0DER',
}

export interface KeywordResearchResult {
  keyword:           string
  search_volume:     number | null
  cpc_estimate:      number | null
  competition_score: number | null
  difficulty:        number | null
  intent:            string | null
  top_ranking_asin:  string | null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  console.log('[keywords/research] auth:', user?.id ?? null, authErr?.message ?? null)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    seedKeyword:  string
    marketplace?: string
    category?:    string
  }

  const { seedKeyword, marketplace = 'amazon.in' } = body
  console.log('[keywords/research] body:', { seedKeyword, marketplace })

  if (!seedKeyword?.trim()) {
    return NextResponse.json({ error: 'seedKeyword is required' }, { status: 400 })
  }

  const baseUrl = AUTOCOMPLETE_URLS[marketplace] ?? AUTOCOMPLETE_URLS['amazon.in']
  const mid     = MARKETPLACE_IDS[marketplace]    ?? MARKETPLACE_IDS['amazon.in']
  const url     = `${baseUrl}?limit=11&prefix=${encodeURIComponent(seedKeyword.trim())}&suggestion-type=KEYWORD&mid=${mid}`

  console.log('[keywords/research] fetching autocomplete from:', url)
  let suggestions: string[] = []

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': marketplace === 'amazon.in' ? 'en-IN,en;q=0.9' : 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.ok) {
      const data = await res.json() as { suggestions?: { value: string }[] }
      suggestions = (data.suggestions ?? [])
        .map(s => s.value?.trim())
        .filter(Boolean) as string[]
      console.log('[keywords/research] autocomplete returned', suggestions.length, 'suggestions')
    }
  } catch {
    // Autocomplete unreachable — fall through to seed-only response
  }

  // Deduplicate; ensure seed keyword is always first
  const seen = new Set<string>()
  const allKws: string[] = []
  for (const kw of [seedKeyword.trim(), ...suggestions]) {
    const norm = kw.toLowerCase()
    if (!seen.has(norm)) {
      seen.add(norm)
      allKws.push(kw)
    }
  }

  const results: KeywordResearchResult[] = allKws.map(kw => ({
    keyword:           kw,
    search_volume:     null,
    cpc_estimate:      null,
    competition_score: null,
    difficulty:        null,
    intent:            null,
    top_ranking_asin:  null,
  }))

  return NextResponse.json({
    results,
    note: 'Keyword suggestions from Amazon autocomplete. Metrics (volume/CPC/difficulty) require a third-party data source and are not available from the existing toolset.',
  })
}
