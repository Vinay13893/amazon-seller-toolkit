# Keyword Checker Runtime

## Overview

Keyword rank refresh runs a Python script from the Next.js API runtime using child_process.
In some production Node environments (including many Vercel deployments), `python3` may not be available in PATH for the serverless runtime.

If Python is unavailable, the app now fails safely:

- A failed `keyword_rank_snapshots` row is still written for each checked keyword.
- `scrape_status` is set to `failed`.
- `found` is set to `false`.
- `organic_rank` is set to `null`.
- `error_message` is set to:
  - `Keyword rank checker runtime is not available in this deployment.`

This keeps UI history transparent and prevents silent failures.

## Python Binary Resolution

The checker resolves Python in this order:

1. `KEYWORD_PYTHON_BIN` environment variable (if set)
2. Platform default:
   - Windows: `python`
   - Non-Windows: `python3`
3. One fallback retry:
   - If initial binary is `python3` and spawn fails with ENOENT, retry once with `python`

If runtime is still unavailable, the API returns a controlled failed response instead of crashing.

## Environment Variable (Optional)

You can set one of these values in production if needed:

- `KEYWORD_PYTHON_BIN=python`
- `KEYWORD_PYTHON_BIN=python3`

This is optional for local development.

## Local Development

Local development can work with either `python` or `python3`, depending on your OS and PATH setup.

## Production Recommendation

For robust production architecture:

- Keep Vercel for the Next.js app/UI and API gateway.
- Run scraping/rank-check worker jobs on a runtime designed for long-running Python workloads (Render, Railway, VPS, AWS worker, etc.).
- Worker writes results to Supabase `keyword_rank_snapshots`.

For MVP, safe failed snapshots preserve visibility when runtime dependencies are unavailable.
