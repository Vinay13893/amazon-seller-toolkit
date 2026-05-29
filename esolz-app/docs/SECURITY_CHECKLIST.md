# Security Checklist

## Committing Code

- [ ] Never commit `.env` files
- [ ] Never commit `.env.local` files
- [ ] Never commit `sp_api_config.json` or any credential JSON
- [ ] Never commit `service-account*.json` or `gsheets-key.json`
- [ ] Run `git status` before every push — check no secret files in staged list
- [ ] Verify `.gitignore` blocks all credential paths

## Logging

- [ ] Never log access tokens
- [ ] Never log refresh tokens
- [ ] Never log LWA client secrets
- [ ] Never log Supabase service role key
- [ ] Never log DB passwords
- [ ] Never log AWS secret keys
- [ ] Use the project logger (`src/lib/observability/logger.ts`) — it auto-redacts sensitive keys

## Secrets in Chat / Docs / Prompts

- [ ] Never paste actual secret values into chat, issues, PRs, or doc files
- [ ] Only discuss key names and whether they are present or missing

## Credential Rotation Workflow

1. Rotate in source (Amazon Developer Console / Supabase / AWS IAM)
2. Update `esolz-app/.env.local` locally
3. Update Vercel → Production env vars
4. Update any local credential JSON files used by Python tools
5. Redeploy app on Vercel
6. Verify health endpoint returns all `_configured: true`
7. Verify GitHub secret scanning shows no open active alerts

## GitHub

- [ ] Enable Secret Scanning on repo
- [ ] Enable Push Protection on repo
- [ ] Review Security tab after every push — zero open alerts target
- [ ] Do not merge PRs with secret scanning alerts

## Vercel

- [ ] Keep all secret keys under Production environment target
- [ ] Redeploy after every env var change
- [ ] Never use `NEXT_PUBLIC_` prefix for server-only secrets

## Periodic Review (Monthly)

- [ ] Confirm no secrets in recent commits: `git log --all --oneline | head -20`
- [ ] Confirm `.gitignore` covers current secret paths
- [ ] Confirm Vercel env vars match `.env.local.example` key list
