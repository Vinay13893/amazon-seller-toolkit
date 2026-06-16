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
- Current rows stored: 0 as of latest check

## Critical Current Status

- Render deploy source is fixed.
- Auto-deploy is now On Commit.
- `/health` shows buildMarker `ba-debug-health-marker-20260616-d007072`.
- Render env now has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- `/brand-analytics/status-debug-temp` returns 200 and confirms job/document DONE but rows are not stored.
- Next required action: add/run temporary one-job sync route or protected sync route for jobId `58761e56-4034-4ee9-a976-3fc968cd8e5e`.

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

Add temporary one-job Brand Analytics sync route:

- `POST /brand-analytics/sync-debug-temp`
- Allow only jobId `58761e56-4034-4ee9-a976-3fc968cd8e5e`
- Run once, then verify `/brand-analytics/status-debug-temp` shows rows stored.
- Do not expose raw rows.
