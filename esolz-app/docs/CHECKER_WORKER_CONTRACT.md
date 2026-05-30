# Checker Worker Contract

This document defines the expected HTTP API that an external checker worker must
implement to integrate with the esolz-app SaaS platform.

The worker handles computationally heavy checks (Playwright scraping, pincode
verification, buy box probing) that cannot run inside Vercel serverless functions
in production.

---

## Configuration (esolz-app env)

| Variable | Required | Description |
|---|---|---|
| `CHECKER_WORKER_URL` | Yes (prod) | Base URL of the worker, no trailing slash. e.g. `https://checker.example.com` |
| `CHECKER_WORKER_SECRET` | Optional | Shared secret sent as `x-checker-secret` header for basic auth. |

When `CHECKER_WORKER_URL` is not set:
- In **production**: all checker routes immediately save a `checker_unavailable` snapshot. No Python is spawned. The UI shows "Checker not connected".
- In **local development**: the app falls back to Python adapters if available.

---

## Security

All requests from esolz-app to the worker include:
```
x-checker-secret: <CHECKER_WORKER_SECRET>
Content-Type: application/json
```

The worker must reject requests that do not include the correct secret (if configured).
Worker responses must never include raw stack traces, Python tracebacks, or internal file paths.

---

## Status Values

All responses include a `status` field. Permitted values:

| Value | Meaning |
|---|---|
| `success` | Check completed and data is valid |
| `partial_success` | Check completed but some fields are missing (e.g. BSR found but buy box unknown) |
| `product_issue` | Check ran and found a real product-level issue (e.g. genuinely unavailable) |
| `checker_unavailable` | Worker could not run the check (internal error, timeout, CAPTCHA, network) |
| `failed` | Generic failure (treated same as checker_unavailable by esolz-app) |

**Critical rule**: `checker_unavailable` and `failed` must NEVER be treated as:
- Product unavailability (0% availability)
- Buy box lost
- Rank dropped
- Any product-level negative signal

Only `product_issue` or `success` with negative data indicates a real product issue.

---

## Endpoints

### POST /keyword-rank

Check organic and sponsored keyword rank for an ASIN on Amazon search results.

**Request:**
```json
{
  "workspace_id": "55a321c9-...",
  "tracked_keyword_id": "uuid",
  "asin": "B0H1WV4B2M",
  "keyword": "glass air fryer",
  "marketplace": "IN",
  "marketplace_id": "A21TJRUUN4KGV"
}
```

**Response (success):**
```json
{
  "ok": true,
  "found": true,
  "organic_rank": 5,
  "sponsored_rank": 1,
  "page": 1,
  "position_on_page": 5,
  "status": "success",
  "error_message": null
}
```

**Response (not found / ranked beyond page 3):**
```json
{
  "ok": true,
  "found": false,
  "organic_rank": null,
  "sponsored_rank": null,
  "page": null,
  "position_on_page": null,
  "status": "success",
  "error_message": null
}
```

**Response (checker unavailable):**
```json
{
  "ok": false,
  "found": false,
  "organic_rank": null,
  "sponsored_rank": null,
  "page": null,
  "position_on_page": null,
  "status": "checker_unavailable",
  "error_message": "Playwright browser unavailable"
}
```

esolz-app saves: `scrape_status = 'checker_unavailable'`, `page_status = null`, `found = false`.
Alerts do NOT fire. UI shows "Checker not connected".

---

### POST /pincode-availability

Check product delivery availability for a specific pincode.

**Request:**
```json
{
  "workspace_id": "55a321c9-...",
  "tracked_asin_id": "uuid",
  "asin": "B0H1WV4B2M",
  "marketplace": "IN",
  "pincode": "110001"
}
```

**Response (success — available):**
```json
{
  "ok": true,
  "available": true,
  "delivery_promise": "Same-Day — FREE delivery by 9 PM",
  "price": 599.00,
  "seller": "Cloudtail India",
  "status": "success",
  "error_message": null
}
```

**Response (success — unavailable):**
```json
{
  "ok": true,
  "available": false,
  "delivery_promise": null,
  "price": null,
  "seller": null,
  "status": "product_issue",
  "error_message": null
}
```

**Response (checker unavailable):**
```json
{
  "ok": false,
  "available": null,
  "delivery_promise": null,
  "price": null,
  "seller": null,
  "status": "checker_unavailable",
  "error_message": "Pincode set timeout"
}
```

esolz-app saves: `available = null`, `delivery_promise = 'Checker not connected: ...'`.
The pincode page and alerts exclude this row from availability ratio.

---

### POST /buybox-check

Check buy box status for an ASIN.

**Request:**
```json
{
  "workspace_id": "55a321c9-...",
  "tracked_asin_id": "uuid",
  "asin": "B0H1WV4B2M",
  "marketplace": "IN"
}
```

**Response (won):**
```json
{
  "ok": true,
  "buybox_won": true,
  "buybox_owner": "Cloudtail India",
  "price": 599.00,
  "status": "success",
  "error_message": null
}
```

**Response (lost):**
```json
{
  "ok": true,
  "buybox_won": false,
  "buybox_owner": "Rival Seller",
  "price": 579.00,
  "status": "product_issue",
  "error_message": null
}
```

**Response (checker unavailable):**
```json
{
  "ok": false,
  "buybox_won": null,
  "buybox_owner": null,
  "price": null,
  "status": "checker_unavailable",
  "error_message": "CAPTCHA encountered"
}
```

esolz-app saves: `buy_box_status = 'checker_unavailable'`.
Buy box page excludes checker_unavailable rows from win-rate calculation.
Alerts do NOT fire on checker_unavailable.

---

### POST /bsr-check

Check BSR, price, rating and review count for an ASIN.

**Request:**
```json
{
  "workspace_id": "55a321c9-...",
  "tracked_asin_id": "uuid",
  "asin": "B0H1WV4B2M",
  "marketplace": "IN"
}
```

**Response (success):**
```json
{
  "ok": true,
  "bsr": 1250,
  "category": "Kitchen & Home",
  "price": 599.00,
  "rating": 4.3,
  "review_count": 128,
  "status": "success",
  "error_message": null
}
```

**Response (checker unavailable):**
```json
{
  "ok": false,
  "bsr": null,
  "category": null,
  "price": null,
  "rating": null,
  "review_count": null,
  "status": "checker_unavailable",
  "error_message": "Browser launch failed"
}
```

esolz-app saves: `buy_box_status = 'checker_unavailable'`, all numeric fields null.
BSR alerts only fire when `bsr IS NOT NULL`, so checker failures don't create false BSR drop alerts.

---

## Retry Behaviour

esolz-app does not automatically retry failed checker calls. The user can manually
trigger a recheck from the UI ("Refresh" / "Refresh Ranks" buttons).

---

## Timeouts

esolz-app waits up to **90 seconds** for worker responses before aborting with
`CheckerWorkerUnavailableError`. Workers should respond (with success or error body)
within this window. Long-running checks should return early with `checker_unavailable`
rather than holding the connection open.

---

## Worker Deployment Options

The worker can be deployed as:
- A standalone FastAPI / Express service on any VPS, Railway, Render, etc.
- A long-running process with Playwright installed
- A Docker container with Chromium + Python/Node

The worker URL is provided to esolz-app via the `CHECKER_WORKER_URL` environment
variable in Vercel project settings. The worker is NOT deployed to Vercel.
