# Test BSR extraction flow end-to-end
# This demonstrates the complete flow: scraper → adapter → route → DB

Write-Host "`n=== 1. Testing Python Scraper ===" -ForegroundColor Cyan
Write-Host "Running: C:\Python314\python.exe scripts\scrape_bsr.py --asin B0822GYVNX --marketplace IN`n"

C:\Python314\python.exe scripts\scrape_bsr.py --asin B0822GYVNX --marketplace IN 2>&1

Write-Host "`n=== 2. Key Points ===" -ForegroundColor Yellow
Write-Host "✓ Check stderr output for [scrape_bsr] BSR regex matches"
Write-Host "✓ Final JSON should have bsr: 2298"
Write-Host "✓ If bsr is null in DB, the issue is in the TypeScript layer"

Write-Host "`n=== 3. Next Steps ===" -ForegroundColor Green
Write-Host "1. Restart dev server with npm run dev"
Write-Host "2. Click Refresh Data on ASIN detail page"
Write-Host "3. Check console for [bsr-adapter][5g] and [bsr-refresh][7] logs"
Write-Host "4. Verify insertPayload has bsr field with numeric value"
Write-Host ""
