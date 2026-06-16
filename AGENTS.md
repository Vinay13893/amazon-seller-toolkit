# Project Context

## Project

- App/tool: Amazon Seller Intelligence Tool / ESOLZ app
- Production app: https://esolz-app.vercel.app/
- Worker: https://sociomonkey-checker-worker.onrender.com/
- Main repo branch: master
- App folder: esolz-app
- Worker folder: checker-worker
- Render worker service: sociomonkey-checker-worker
- Supabase project ref: okxfwcfxxrtmijmvztdq
- Workspace ID: 55a321c9-7729-4662-a494-9f1f1aa86846
- Amazon marketplace: A21TJRUUN4KGV
- Important test jobId: 58761e56-4034-4ee9-a976-3fc968cd8e5e
- Important reportId: 674373020618
- Report type: GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT
- Report document status: DONE
- Job status: DONE
- Current rows stored: 691247 as of latest Brand Analytics sync

## Critical Current Status

- Render deploy source is fixed.
- Auto-deploy is now On Commit.
- `/health` shows buildMarker `ba-debug-health-marker-20260616-d007072`.
- Render env now has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Phase 1 Brand Analytics sync/storage is complete.
- `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` stored 691247 rows for jobId `58761e56-4034-4ee9-a976-3fc968cd8e5e`.
- Temporary public Brand Analytics debug routes have been removed/protected.
- Next phase: Brand Analytics dashboard UI.

## Security Rules

- Never ask user to paste secrets into Codex chat, terminal, files, or ChatGPT.
- Secrets must only be entered directly into Render/Vercel/Supabase dashboards.
- Do not print env values, tokens, auth headers, report download URLs, raw Amazon report rows, search terms, ASINs, or keywords.
- A Supabase service-role key may have been exposed earlier; rotate it after Brand Analytics flow is stable.
- Temporary debug routes must be removed or protected before production.

## Execution Rules

- Low-credit mode.
- No broad refactors.
- No "check everything."
- Make minimal targeted changes.
- Build before commit.
- Commit only changed relevant files.
- Return concise result: files changed, build result, commit, deploy status, live test result, next blocker.
- Do not run `/brand-analytics/sync` unless specifically instructed.
- Do not create new Amazon reports unless specifically instructed.
- Do not touch pincode/scraping unless specifically instructed.

## Current Next Task

Build Brand Analytics dashboard UI:

- Show stored Search Terms data safely.
- Add loading, empty, and error states.
- Add safe row-count and last-sync status.
- Do not expose raw rows, secrets, tokens, auth headers, Amazon document URLs, search terms, ASINs, or keywords in logs/chat.
