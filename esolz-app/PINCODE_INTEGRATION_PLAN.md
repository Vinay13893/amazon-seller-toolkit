# Pincode Checker Integration Plan

## 1. Existing Tool Analysis

### Location
- **Path**: `e:\amazon-bsr-tracker\amazon-pincode-checker\pincode_checker\amazon_pincode_checker.py`
- **Support files**: 
  - `README_amazon_pincode_checker.md` (documentation)
  - `amazon_profile/` (persistent browser profile directory)

### Language & Dependencies
- **Language**: Python 3
- **Framework**: Playwright (sync_api)
- **Key dependencies**:
  - `playwright` (with chromium browser)
  - Python stdlib: `csv`, `dataclasses`, `re`, `argparse`

### Current Input Format
**CLI-based with CSV files:**
```bash
python amazon_pincode_checker.py \
  --asins asins.csv \           # CSV with 'asin' column
  --pincodes pincodes.csv \     # CSV with 'pincode' column
  --output report.csv \
  --profile-dir ./amazon_profile
```

**Can be adapted to single ASIN + single pincode** by:
- Calling `check_asin(page, asin, pincode)` function directly
- Returns a `CheckResult` dataclass instance

### Output Format
**Python Dataclass: `CheckResult`**
```python
@dataclass
class CheckResult:
    asin: str
    pincode: str
    url: str                    # https://www.amazon.in/dp/{asin}
    title: str
    is_buyable: bool            # ✓ Maps to DB
    availability_text: str
    amazon_fulfilled: bool      # ✓ Maps to DB
    merchant_text: str          # ✓ Maps to DB
    delivery_type: str          # 'same_day'|'next_day'|'two_day'|'other'|'unknown'|'unavailable'|'error'
    delivery_text: str          # ✓ Maps to DB
    captcha_seen: bool
    error: str
```

**Conversion to dict**: `asdict(result)` returns JSON-serializable dict

### Key Functions
1. `check_asin(page, asin, pincode) -> CheckResult` — Main check function
2. `set_pincode(page, pincode) -> bool` — Sets delivery pincode
3. `classify_delivery(text, buyable) -> str` — Classifies delivery type

### Current Marketplace
- **Hardcoded**: Amazon.in (`https://www.amazon.in`)
- **Note**: Would need marketplace param for US/UK/DE support

---

## 2. Database Schema Mapping

### Target Table: `pincode_checks`

| DB Column | Type | Source Field | Mapping Logic |
|-----------|------|--------------|---------------|
| `id` | UUID | — | Auto-generated |
| `workspace_id` | UUID | — | From auth context |
| `tracked_asin_id` | UUID | — | From tracked_asins lookup |
| `pincode` | TEXT | `CheckResult.pincode` | Direct |
| `city` | TEXT | — | **NULL** (not extracted by tool) |
| `available` | BOOLEAN | `CheckResult.is_buyable` | Direct |
| `delivery_promise` | TEXT | `CheckResult.delivery_text` | Combine text + type |
| `price` | NUMERIC | — | **NULL** (not extracted by tool) |
| `buy_box_seller` | TEXT | `CheckResult.merchant_text` | Extract seller name |
| `fulfillment_type` | TEXT | `CheckResult.amazon_fulfilled` | 'FBA' if true else 'FBM' |
| `checked_at` | TIMESTAMPTZ | — | NOW() or CheckResult timestamp |

**Data enrichment needed:**
- `delivery_promise`: Combine `delivery_text` + `delivery_type` for rich display
  - Example: `"Same-Day Delivery by 9 PM (same_day)"`
- `buy_box_seller`: Extract seller name from `merchant_text` (may contain full sentence)
- `fulfillment_type`: Map boolean to string

---

## 3. Integration Architecture

### Option A: Subprocess Wrapper (RECOMMENDED)
**Why**: Keeps Python isolation, no code modification needed

```
Next.js API Route
    ↓ spawn
Python Wrapper Script (NEW: scripts/check_pincode.py)
    ↓ import
Existing Tool (amazon_pincode_checker.py)
    ↓ Playwright
Amazon.in
```

**Wrapper script responsibilities:**
1. Accept CLI args: `--asin B0XX --pincode 110001 --marketplace IN --profile-dir ...`
2. Import existing tool's `check_asin()` function
3. Initialize Playwright browser with persistent profile
4. Call `set_pincode()` then `check_asin()`
5. Output JSON to stdout: `asdict(result)`
6. Exit with status code 0 (success) or 1 (error)

**Advantages:**
- No modification to existing tool
- TypeScript adapter (similar to BSR adapter) handles spawn/parse
- Reuses battle-tested scraping logic
- Profile persistence works same as current tool

**Disadvantages:**
- Slower than in-memory (browser launch overhead)
- Each check needs fresh browser instance OR persistent connection pool

---

### Option B: REST Service Wrapper
**Why**: Better for high-frequency checks, connection pooling

```
Next.js API Route
    ↓ HTTP
Python FastAPI Service (NEW: separate service)
    ↓ in-memory
Existing Tool (as library)
    ↓ Playwright (persistent browser pool)
Amazon.in
```

**Not recommended for MVP** — adds service management complexity

---

## 4. Implementation Plan (Step-by-Step)

### Phase 1: Python Wrapper Script
**File**: `esolz-app/scripts/check_pincode.py`

**Inputs (CLI args):**
```bash
python check_pincode.py \
  --asin B0822GYVNX \
  --pincode 110001 \
  --marketplace IN \
  --profile-dir ../amazon-pincode-checker/pincode_checker/amazon_profile
```

**Outputs (stdout JSON):**
```json
{
  "asin": "B0822GYVNX",
  "pincode": "110001",
  "marketplace": "IN",
  "url": "https://www.amazon.in/dp/B0822GYVNX",
  "title": "Product Title",
  "is_buyable": true,
  "availability_text": "In stock",
  "amazon_fulfilled": true,
  "merchant_text": "Ships from Amazon | Sold by Seller Name",
  "delivery_type": "same_day",
  "delivery_text": "FREE Same-Day Delivery by 9 PM",
  "captcha_seen": false,
  "error": "",
  "checked_at": "2026-05-26T16:00:00+00:00"
}
```

**Implementation:**
1. Use `argparse` for CLI
2. Import from `../../amazon-pincode-checker/pincode_checker/amazon_pincode_checker.py`
3. Initialize Playwright browser with persistent profile
4. Call `set_pincode(page, pincode)`
5. Call `check_asin(page, asin, pincode)`
6. Convert result to dict with `asdict()`
7. Add `marketplace` and `checked_at` fields
8. Print JSON to stdout
9. Handle errors gracefully (exit code 1 with error JSON)

---

### Phase 2: TypeScript Adapter
**File**: `esolz-app/src/lib/integrations/amazon-pincode-adapter.ts`

**Similar to**: `amazon-bsr-adapter.ts` (spawn subprocess, parse JSON)

**Interface:**
```typescript
export interface PincodeCheckResult {
  asin: string
  pincode: string
  marketplace: string
  url: string
  title: string
  is_buyable: boolean
  availability_text: string
  amazon_fulfilled: boolean
  merchant_text: string
  delivery_type: 'same_day' | 'next_day' | 'two_day' | 'other' | 'unknown' | 'unavailable' | 'error'
  delivery_text: string
  captcha_seen: boolean
  error: string
  checked_at: string
}

export function checkPincode(
  asin: string,
  pincode: string,
  marketplace: string
): Promise<PincodeCheckResult>
```

**Implementation:**
1. Resolve Python binary (same as BSR adapter)
2. Resolve script path: `scripts/check_pincode.py`
3. Resolve profile directory: `../../amazon-pincode-checker/pincode_checker/amazon_profile`
4. Spawn subprocess with timeout (90s — Playwright can be slow)
5. Collect stdout/stderr
6. Parse JSON from stdout
7. Log checkpoints: `[pincode-adapter][1-7]`
8. Return typed result

---

### Phase 3: API Route
**File**: `esolz-app/src/app/api/asins/[asin]/pincode/route.ts`

**Endpoint**: `POST /api/asins/{asin}/pincode`

**Request body:**
```json
{
  "pincode": "110001"
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "asin": "B0822GYVNX",
    "pincode": "110001",
    "available": true,
    "delivery_promise": "Same-Day Delivery by 9 PM",
    "fulfillment_type": "FBA",
    "buy_box_seller": "Seller Name",
    "checked_at": "2026-05-26T16:00:00+00:00"
  }
}
```

**Flow:**
1. Auth check (same as BSR refresh route)
2. Validate workspace membership
3. Lookup tracked_asins for asin + workspace
4. Call `checkPincode(asin, pincode, marketplace)`
5. Map result to DB fields:
   - `available` = `is_buyable`
   - `delivery_promise` = `${delivery_text} (${delivery_type})`
   - `fulfillment_type` = `amazon_fulfilled ? 'FBA' : 'FBM'`
   - `buy_box_seller` = extract from `merchant_text`
6. Insert into `pincode_checks` using admin client (bypass RLS)
7. Return success + enriched result

---

### Phase 4: UI Integration

#### 4a. ASIN Detail Page — Pincode Check Section
**File**: `esolz-app/src/app/(dashboard)/dashboard/asins/[asin]/page.tsx`

**New section after BSR/Price cards:**
```tsx
<div className="pincode-check-section">
  <h2>Pincode Availability</h2>
  <div>
    <input 
      type="text" 
      placeholder="Enter pincode (e.g., 110001)"
      value={pincodeInput}
      onChange={e => setPincodeInput(e.target.value)}
    />
    <button onClick={handleCheckPincode} disabled={checking}>
      {checking ? 'Checking...' : 'Check Availability'}
    </button>
  </div>
  {latestCheck && (
    <div className="check-result">
      <p>Availability: {latestCheck.available ? '✓ Available' : '✗ Not Available'}</p>
      <p>Delivery: {latestCheck.delivery_promise}</p>
      <p>Seller: {latestCheck.buy_box_seller}</p>
      <p>Fulfillment: {latestCheck.fulfillment_type}</p>
      <p className="text-muted">Checked: {formatDistanceToNow(latestCheck.checked_at)}</p>
    </div>
  )}
  <div className="check-history">
    <h3>Recent Checks</h3>
    <table>
      <thead>
        <tr>
          <th>Pincode</th>
          <th>Available</th>
          <th>Delivery</th>
          <th>Checked</th>
        </tr>
      </thead>
      <tbody>
        {pincodeHistory.map(check => (
          <tr key={check.id}>
            <td>{check.pincode}</td>
            <td>{check.available ? '✓' : '✗'}</td>
            <td>{check.delivery_promise}</td>
            <td>{formatDistanceToNow(check.checked_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

**State:**
```typescript
const [pincodeInput, setPincodeInput] = useState('')
const [checking, setChecking] = useState(false)
const [latestCheck, setLatestCheck] = useState<PincodeCheck | null>(null)
const [pincodeHistory, setPincodeHistory] = useState<PincodeCheck[]>([])
```

**Handler:**
```typescript
const handleCheckPincode = async () => {
  if (!pincodeInput.match(/^\d{6}$/)) {
    toast.error('Invalid pincode format')
    return
  }
  setChecking(true)
  try {
    const res = await fetch(`/api/asins/${asin}/pincode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pincode: pincodeInput })
    })
    if (!res.ok) throw new Error('Check failed')
    const data = await res.json()
    setLatestCheck(data.result)
    toast.success('Pincode check completed')
    await loadPincodeHistory() // Refetch history
  } catch (err) {
    toast.error('Failed to check pincode')
  } finally {
    setChecking(false)
  }
}
```

#### 4b. ASIN List Page — Quick Check Modal
**Optional enhancement**: Add "Check Pincodes" button to table actions

---

## 5. Data Flow Diagram

```
User clicks "Check Availability" on ASIN detail page
    ↓
POST /api/asins/B0822GYVNX/pincode { pincode: "110001" }
    ↓
Route: Auth check → workspace lookup → tracked_asin lookup
    ↓
TypeScript Adapter: checkPincode(asin, pincode, marketplace)
    ↓
Spawn: python check_pincode.py --asin B0822GYVNX --pincode 110001 --marketplace IN
    ↓
Python Wrapper: Import existing tool → Initialize Playwright → set_pincode() → check_asin()
    ↓
Existing Tool: Navigate to Amazon.in → Extract availability/delivery/seller
    ↓
Python Wrapper: Output JSON to stdout → Exit 0
    ↓
TypeScript Adapter: Parse JSON → Return PincodeCheckResult
    ↓
Route: Map to DB fields → INSERT into pincode_checks using admin client
    ↓
Response: { success: true, result: {...} }
    ↓
UI: Update latestCheck state → Show result card → Refresh history table
```

---

## 6. Field Mapping Details

### Delivery Promise Enrichment
```typescript
function buildDeliveryPromise(result: PincodeCheckResult): string {
  if (!result.is_buyable) return 'Not available'
  if (!result.delivery_text) return 'Delivery info not available'
  
  const typeLabel = {
    'same_day': 'Same-Day',
    'next_day': 'Next-Day',
    'two_day': 'Two-Day',
    'other': 'Standard',
    'unknown': '',
    'unavailable': 'Not available',
    'error': 'Error'
  }[result.delivery_type]
  
  return typeLabel 
    ? `${typeLabel} — ${result.delivery_text}` 
    : result.delivery_text
}
```

### Buy Box Seller Extraction
```typescript
function extractSellerName(merchantText: string): string {
  // merchant_text examples:
  // "Ships from Amazon | Sold by Seller Name"
  // "Fulfilled by Amazon"
  // "Sold by Seller Name"
  
  const soldByMatch = merchantText.match(/Sold by\s+([^|]+)/i)
  if (soldByMatch) return soldByMatch[1].trim()
  
  const shipsMatch = merchantText.match(/Ships from\s+([^|]+)/i)
  if (shipsMatch) return shipsMatch[1].trim()
  
  return merchantText.trim().slice(0, 100) // fallback: truncate
}
```

### Fulfillment Type
```typescript
function getFulfillmentType(amazonFulfilled: boolean): string {
  return amazonFulfilled ? 'FBA' : 'FBM'
}
```

---

## 7. Environment Variables

**New env vars needed:**

```bash
# .env.local
PINCODE_PYTHON_BIN=C:\Python314\python.exe  # Or reuse BSR_PYTHON_BIN
PINCODE_PROFILE_DIR=../amazon-pincode-checker/pincode_checker/amazon_profile
```

---

## 8. Constraints & Notes

### Do NOT Implement (per user requirements):
- ❌ Billing/usage tracking (not in MVP)
- ❌ Buy Box connection (separate module)
- ❌ Keyword tracking connection (separate module)
- ❌ Batch checks UI (start with single pincode)
- ❌ City auto-detect from pincode (not extracted by tool)
- ❌ Price from pincode check (tool doesn't extract it)

### DO Implement:
- ✅ Single pincode check from ASIN detail page
- ✅ Save results to `pincode_checks` table
- ✅ Show latest check result + history
- ✅ Reuse existing Python tool (no rewrites)
- ✅ Use service-role admin client for DB writes (like BSR)

### Known Limitations:
1. **Marketplace**: Current tool hardcoded to Amazon.in
   - For US/UK/DE support, need to pass AMAZON_BASE as param
2. **CAPTCHA**: Tool handles it interactively (headful mode)
   - For automation, may need CAPTCHA solver or manual intervention
3. **Speed**: Playwright is slow (~30-60s per check)
   - Consider showing progress indicator in UI
4. **Browser profile**: Shared across all checks
   - First-time setup requires manual login (headful mode)
   - Subsequent checks reuse session

---

## 9. Testing Strategy

### Unit Tests (Python wrapper)
```bash
cd esolz-app/scripts
python check_pincode.py --asin B0822GYVNX --pincode 110001 --marketplace IN
```

Expected output:
```json
{
  "asin": "B0822GYVNX",
  "pincode": "110001",
  "is_buyable": true,
  "delivery_type": "same_day",
  ...
}
```

### Integration Tests (API route)
```bash
curl -X POST http://localhost:3000/api/asins/B0822GYVNX/pincode \
  -H "Content-Type: application/json" \
  -d '{"pincode":"110001"}'
```

### E2E Tests (UI flow)
1. Navigate to ASIN detail page
2. Enter pincode "110001"
3. Click "Check Availability"
4. Wait for result (~30-60s)
5. Verify result card appears
6. Verify history table updates

---

## 10. File Changes Summary

### New Files (to be created):
1. `esolz-app/scripts/check_pincode.py` — Python wrapper for existing tool
2. `esolz-app/src/lib/integrations/amazon-pincode-adapter.ts` — TypeScript adapter
3. `esolz-app/src/app/api/asins/[asin]/pincode/route.ts` — API route handler

### Modified Files (to be updated):
1. `esolz-app/src/app/(dashboard)/dashboard/asins/[asin]/page.tsx` — Add pincode check UI
2. `esolz-app/.env.local` — Add PINCODE_PYTHON_BIN (or reuse BSR_PYTHON_BIN)
3. `esolz-app/.env.local.example` — Document new vars

### No Changes Needed:
- ✅ Existing pincode checker tool (used as-is)
- ✅ Database schema (already has `pincode_checks` table)
- ✅ RLS policies (already defined for pincode_checks)

---

## 11. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Browser profile login required | Medium | Document setup in README, show friendly error if not logged in |
| Slow check time (30-60s) | Medium | Show progress indicator, set realistic user expectations |
| CAPTCHA blocks automation | High | Use persistent profile to reduce frequency, consider headful mode |
| Concurrent checks interfere | Low | Playwright profile can handle it, but may add queue if needed |
| Marketplace hardcoded to IN | Low | Add marketplace param to wrapper script (future enhancement) |

---

## 12. Success Criteria

**MVP is complete when:**
- ✅ User can enter pincode on ASIN detail page
- ✅ Click "Check Availability" triggers API call
- ✅ Python wrapper successfully calls existing tool
- ✅ Result saves to `pincode_checks` table in Supabase
- ✅ Latest result displays in UI with formatted data
- ✅ History table shows past checks for this ASIN
- ✅ No modifications to existing pincode checker Python code
- ✅ No billing/usage tracking implemented (deferred)

**Done when user can:**
1. Navigate to ASIN detail page
2. Enter a pincode (e.g., 110001)
3. Click "Check Availability"
4. Wait ~30-60s
5. See result: "✓ Available — Same-Day Delivery by 9 PM — FBA — Seller Name"
6. See history table update with new check

---

## 13. Next Steps (After Plan Approval)

1. Create Python wrapper script (`check_pincode.py`)
2. Test wrapper in isolation (verify JSON output)
3. Create TypeScript adapter
4. Test adapter (spawn → parse → return)
5. Create API route
6. Test route with Postman/curl
7. Add UI section to ASIN detail page
8. Test full E2E flow
9. Document setup in README
10. Update .env.local.example

**Estimated implementation time**: 3-4 hours
