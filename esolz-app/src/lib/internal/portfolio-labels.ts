// Display-only portfolio label mapping. The underlying stored/matched
// portfolio key (e.g. "BPM") never changes — this only controls what text
// is shown to the team. Keep this map in sync with EasyhomePortfolio.
const PORTFOLIO_DISPLAY_LABELS: Record<string, string> = {
  BPM: 'Baby Play Mat (BPM)',
}

export function portfolioDisplayLabel(portfolio: string): string {
  return PORTFOLIO_DISPLAY_LABELS[portfolio] ?? portfolio
}
