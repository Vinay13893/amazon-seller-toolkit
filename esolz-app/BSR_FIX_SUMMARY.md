# BSR Extraction Fix — Summary Report

## Files Changed

1. **esolz-app/src/lib/integrations/amazon-bsr-adapter.ts**
   - Added full JSON logging in line 107
   - Now logs: `[bsr-adapter][5g] full JSON: {...}`

2. **esolz-app/src/app/api/asins/[asin]/refresh/route.ts**
   - Added full scraper result logging after line 71
   - Now logs: `[bsr-refresh][6] full result: {...}`

3. **esolz-app/test_bsr_flow.ps1** (NEW)
   - Test script to verify end-to-end BSR extraction

## Python Scraper Test Results

### Raw BSR Text Found
```
BSR regex matches: [('2,298', 'Baby Products '), ('60', 'Playmats & Floor Gyms')]
```

The scraper successfully extracts TWO BSR ranks from the Amazon page:
1. **Primary**: #2,298 in Baby Products
2. **Sub-category**: #60 in Playmats & Floor Gyms

### Normalization Process
```python
rank_raw = '2,298'
num = rank_raw.replace(",", "").strip()  # → '2298'
int(num)  # → 2298
```

### Final Scraper JSON Output
```json
{
  "asin": "B0822GYVNX",
  "marketplace": "IN",
  "bsr": 2298,
  "bsr_category": "Baby Products",
  "price": 2964.0,
  "rating": 3.9,
  "review_count": 277,
  "buy_box_owner": "EMOUNT VENTURES PRIVATE LIMITED",
  "buy_box_status": "lost",
  "availability_score": 90,
  "checked_at": "2026-05-26T15:38:25.693693+00:00",
  "scrape_status": "OK"
}
```

✅ **BSR extraction is working perfectly in the Python scraper**

## Expected Insert Payload (from route)

Based on the scraper output, the route should create this payload:

```json
{
  "workspace_id": "<workspace-uuid>",
  "tracked_asin_id": <tracked-asin-id>,
  "bsr": 2298,
  "price": 2964.0,
  "rating": 3.9,
  "review_count": 277,
  "buy_box_owner": "EMOUNT VENTURES PRIVATE LIMITED",
  "buy_box_status": "lost",
  "availability_score": 90,
  "checked_at": "2026-05-26T15:38:25.693693+00:00"
}
```

## How to Test Again

### Step 1: Restart Dev Server
The dev server needs to be restarted to pick up the new logging:

```powershell
cd e:\amazon-bsr-tracker\esolz-app
npm run dev
```

### Step 2: Trigger Refresh
1. Navigate to: http://localhost:3000/dashboard/asins/B0822GYVNX
2. Click **"Refresh Data"** button
3. Wait for scrape to complete (~30-60 seconds with Playwright fallback)

### Step 3: Check Console Logs
Look for these log sequences in the dev server console:

```
[bsr-adapter][5a] python   : C:\Python314\python.exe (exists=true)
[bsr-adapter][5b] script   : E:\amazon-bsr-tracker\esolz-app\scripts\scrape_bsr.py (exists=true)
[bsr-adapter][5d] exit code: 0
[bsr-adapter][5f] stdout   : {"asin": "B0822GYVNX", ...}
[bsr-adapter][5g] parsed   : bsr=2298 price=2964 status=OK
[bsr-adapter][5g] full JSON: {
  "asin": "B0822GYVNX",
  "bsr": 2298,
  ...
}
[bsr-refresh][6] OK   scraper: bsr=2298 price=2964 status=OK
[bsr-refresh][6] full result: {
  "bsr": 2298,
  ...
}
[bsr-refresh][7] insert payload: {
  "workspace_id": "...",
  "tracked_asin_id": ...,
  "bsr": 2298,           ← VERIFY THIS IS A NUMBER, NOT NULL
  "price": 2964,
  ...
}
[bsr-refresh][7] OK   snapshot inserted: id=... bsr=2298
```

### Step 4: Verify in UI
After refresh completes:
- **Current BSR card** should show: `#2,298`
- **Sub-Category Rank card** should show: `Baby Products`
- **BSR History chart** should have a data point

### Step 5: Verify in Database (Optional)
```sql
SELECT id, asin, bsr, bsr_category, price, rating, checked_at 
FROM asin_snapshots 
WHERE tracked_asin_id = (
  SELECT id FROM tracked_asins WHERE asin = 'B0822GYVNX'
)
ORDER BY checked_at DESC 
LIMIT 1;
```

Expected result:
```
bsr: 2298
bsr_category: "Baby Products"
price: 2964
rating: 3.9
```

## Current Status

✅ **Python scraper**: Extracting BSR correctly (2298)
✅ **Normalization**: Removing commas and converting to integer
✅ **JSON output**: Includes `"bsr": 2298` as number
✅ **TypeScript types**: BsrScrapeResult interface correctly defines `bsr: number | null`
✅ **Route mapping**: insertPayload includes `bsr: result.bsr`

🔄 **Next**: Need to verify actual logs when route is called via Refresh Data button
   - The Python scraper works standalone
   - Need to confirm the full flow through TypeScript adapter → route → DB

## If BSR is Still NULL in Database

If you see `bsr=null` in the insert payload logs, check:

1. **stderr from scraper** — Does it show "BSR regex matches: []"?
   - If yes: Amazon returned a stub page without BSR data
   - If no: The regex found matches but normalization failed

2. **stdout from scraper** — Does the JSON have `"bsr": null` or `"bsr": 2298`?
   - If null: Scraper couldn't extract BSR
   - If 2298: Issue is in TypeScript layer (adapter parsing)

3. **Adapter logs** — Does `[bsr-adapter][5g]` show `bsr=null` or `bsr=2298`?
   - If null: JSON parsing issue (unlikely — types are correct)
   - If 2298: Issue is between adapter and route

4. **Route logs** — Does `[bsr-refresh][6]` show `bsr=null` or `bsr=2298`?
   - If null: Adapter didn't return BSR
   - If 2298: Issue is in DB insert (unlikely with admin client)

## Known Working Test Case

**ASIN**: B0822GYVNX  
**Marketplace**: IN  
**Expected BSR**: 2298  
**Category**: Baby Products  
**Price**: ₹2,964  
**Rating**: 3.9  
**Reviews**: 277  

This ASIN is confirmed to work with the scraper. Use it for testing.
