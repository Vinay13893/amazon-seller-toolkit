// Bridges Amazon Ads Reporting API v3 JSON rows into the CSV text format the
// existing manual-upload parsers (ads-campaign-daily-parser, ads-deep-report-
// parser) already accept. The v3 JSON field names (e.g. "campaignName",
// "cost", "purchases7d") are already recognized column aliases in those
// parsers (lowercased, space-stripped) — see the alias comments there — so
// this is a pure format bridge, not new parsing/mapping logic.

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function jsonRowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => csvCell(row[h])).join(','))
  }
  return lines.join('\n')
}
