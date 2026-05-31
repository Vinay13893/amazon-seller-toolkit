# Sociomonkey Checker Worker (Sprint 1)

Standalone external worker service for:
- Keyword Rank checks (`/keyword-rank`)
- Pincode Availability checks (`/pincode-availability`)

This service is designed to run outside Vercel and integrate with `esolz-app` through `CHECKER_WORKER_URL` and `CHECKER_WORKER_SECRET`.

## Tech Stack

- Node.js + TypeScript
- Express
- Playwright (Chromium)
- Zod
- dotenv

## Folder Structure

- `src/server.ts`: HTTP server and routes
- `src/middleware/auth.ts`: secret header auth + lightweight rate limiting
- `src/checkers/keywordRank.ts`: keyword ranking checker
- `src/checkers/pincodeAvailability.ts`: pincode availability checker
- `src/utils/browser.ts`: browser lifecycle utility
- `src/utils/amazon.ts`: Amazon parsing/block/availability helpers

## Environment Variables

Use `.env.example` as template:

- `CHECKER_WORKER_SECRET=test-secret`
- `PORT=3001`
- `NODE_ENV=production`

## Install

```bash
npm install
npx playwright install chromium
```

## Run Locally

```bash
npm run dev
```

## Build + Start

```bash
npm run build
npm start
```

## API Security

All protected endpoints require:

- Header: `x-checker-secret: <CHECKER_WORKER_SECRET>`

Missing or invalid secret returns `401`.

## Endpoints

### `GET /health`

Response:

```json
{
  "ok": true,
  "service": "sociomonkey-checker-worker",
  "version": "0.1.0"
}
```

### `POST /keyword-rank`

Request JSON:

```json
{
  "workspace_id": "test",
  "tracked_keyword_id": "test",
  "asin": "B09D9Q1B26",
  "keyword": "baking paper roll",
  "marketplace": "amazon.in",
  "marketplace_id": "A21TJRUUN4KGV"
}
```

Behavior:
- Searches Amazon India and scans first 3 pages.
- Collects product cards with ASIN.
- Attempts to classify sponsored vs organic rows.
- Returns rank fields and page/position.
- Returns blocked status on CAPTCHA/robot checks.

### `POST /pincode-availability`

Request JSON:

```json
{
  "workspace_id": "test",
  "tracked_asin_id": "test",
  "asin": "B09D9Q1B26",
  "marketplace": "amazon.in",
  "pincode": "110001"
}
```

Behavior:
- Opens Amazon India product page.
- Detects robot/captcha blocks and returns `status: "blocked"` with `available: null`.
- Attempts to set pincode from the location popover.
- Extracts delivery promise, price, seller and fulfillment hints.
- Classifies availability conservatively:
  - `available: true` only when clear positive delivery/stock evidence is present.
  - `available: false` only when clear unavailability evidence is present.
  - `available: null` when blocked, unclear, or pincode cannot be set.
- Never returns `status: "unavailable"` unless explicit unavailability evidence is detected.

## Curl Tests

Health:

```bash
curl http://localhost:3001/health
```

Keyword:

```bash
curl -X POST http://localhost:3001/keyword-rank \
  -H "Content-Type: application/json" \
  -H "x-checker-secret: test-secret" \
  -d '{"workspace_id":"test","tracked_keyword_id":"test","asin":"B09D9Q1B26","keyword":"baking paper roll","marketplace":"amazon.in","marketplace_id":"A21TJRUUN4KGV"}'
```

Pincode:

```bash
curl -X POST http://localhost:3001/pincode-availability \
  -H "Content-Type: application/json" \
  -H "x-checker-secret: test-secret" \
  -d '{"workspace_id":"test","tracked_asin_id":"test","asin":"B09D9Q1B26","marketplace":"amazon.in","pincode":"110001"}'
```

## Deploy Notes (Render / Railway)

1. Reuse the existing worker service (for this project: `sociomonkey-checker-worker`) from `checker-worker` root.
2. Build command:

```bash
npm install && npx playwright install chromium && npm run build
```

3. Start command:

```bash
npm start
```

4. Environment variables:
- `CHECKER_WORKER_SECRET`
- `PORT` (platform usually sets this automatically)
- `NODE_ENV=production`

5. Confirm the service exposes:
- `GET /health`
- `POST /keyword-rank`
- `POST /pincode-availability`

6. Set in SaaS environment (separately):
- `CHECKER_WORKER_URL=https://<worker-host>`
- `CHECKER_WORKER_SECRET=<same-secret>`
