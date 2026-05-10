# Claude Amazon All Tools — Master Workspace

> **Last updated:** April 12, 2026  
> **Owner:** EMOUNT Ventures (eHomekart / LilToes brands on Amazon.in)  
> **Workspace path:** `e:\amazon-bsr-tracker\` (to be renamed `e:\Claude amazon all Tools\`)

## For AI Assistants — Read This First

This is the **top-level README** for the entire workspace. It maps every tool and project. When resuming work, read this file to know what exists and where to find it.

For **deep details** on the Amazon Ads analytics toolkit (the largest project), read:  
`amazon-pincode-checker/README.md` — it has credentials, data pipeline, category config, analysis scripts, prorating rules, and all findings.

---

## Workspace Map

| Folder / File | What It Does | Status |
|---------------|-------------|--------|
| **amazon-pincode-checker/** | Amazon Ads analytics hub (main project) | Active — primary working area |
| **amazon-pincode-checker/amazon-rank-tracker/** | Keyword rank tracker for Amazon.in | Active |
| **amazon-pincode-checker/amazon-tools/** | Hijacker / unauthorized seller tracker | Active |
| **amazon-pincode-checker/Claude Telegram Bot/** | Telegram approve/reject permission bot | Active |
| **amazon-pincode-checker/Store Replenish Auto/** | FBA store replenishment automation | Active |
| Root files (`app.py`, `amazon_bsr_tracker.py`, etc.) | BSR (Best Seller Rank) web tracker | Legacy — Flask app for tracking BSR |
| `debug_*.py`, `bsr_*.py`, `verify_*.py` at root | BSR tracker debug/test scripts | Legacy — consider moving to debug/ |
| `Prompt file.xlsx` | Prompt templates | Reference |

---

## 1. Amazon Ads Analytics Hub (`amazon-pincode-checker/`)

**The main project.** Full details in its own [README.md](amazon-pincode-checker/README.md).

### What it does:
- Pulls SP + SD campaign reports via **Amazon Ads API v3**
- Fetches real order data (40K+ orders, 365d) via **Amazon SP-API**
- Classifies ASINs into **6 product categories** with ACoS/ROAS targets
- Generates master audit reports (duplication, search terms, keyword bids, category P&L)
- Monthly trend analysis with prorating

### Key scripts:
| Script | Purpose | Run |
|--------|---------|-----|
| `master_analysis.py` | Full audit → 6 master CSVs | `python master_analysis.py` |
| `twelve_month_analysis.py` | 12-month revenue trend Excel | `python twelve_month_analysis.py --use-cache` |
| `action_report.py` | Prorated monthly action reports | `python action_report.py` |
| `_summary_stats.py` | Quick summary stats from outputs | `python _summary_stats.py` |
| `generate_excel_report.py` | Formatted Excel report | `python generate_excel_report.py` |
| `deep_analysis.py` | 8-dimension deep analysis | `python deep_analysis.py` |
| `campaign_deep_dive.py` | 6-analysis campaign deep dive | `python campaign_deep_dive.py` |

### Python environment:
```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker
& amazon_ads_tool\.venv\Scripts\Activate.ps1
```

### Sub-tools inside amazon-pincode-checker:
| Folder | Purpose |
|--------|---------|
| `amazon_ads_tool/` | API client library + cached report JSONs |
| `category_analysis/` | Category definitions, SP-API order data, PnL logic |
| `output/` | ALL generated reports (CSVs, Excels, text) |
| `csv_reports/` | Analysis CSVs from ads data |
| `raw_data/` | Raw API response data |
| `pincode_checker/` | Amazon pincode availability checker |
| `sponsored_scraper/` | Sponsored product scraping scripts |
| `youtube/` | Viral titles generator + Shorts video creator |
| `ghee_research/` | Market research CSVs |
| `debug/` | Debug scripts and temp files |
| `reports/` | Ads API report profiles |
| `Ads Analytics Claude/` | Saved analysis report archives |
| `Daily Herbs Previous Output File/` | Daily Herbs product content |

---

## 2. Amazon Rank Tracker (`amazon-pincode-checker/amazon-rank-tracker/`)

Playwright-based keyword rank tracker. Scans up to 7 pages of Amazon.in search results to find where your ASINs appear.

| Script | Mode | Input |
|--------|------|-------|
| `rank_tracker_multi.py` | Multiple ASINs per keyword (grouped) | `rank_input.xlsx` → sheet "MultiPairs" |
| `rank_tracker_single.py` | One keyword ↔ one ASIN | `rank_input.xlsx` → sheet "Pairs" |

**Output:** Daily CSVs in `rank_logs_multi/` + cumulative `rank_master_multi.csv`  
**Google Sheets sync:** via `secret/gsheets-key.json` (set `SYNC_TO_GSHEETS = True`)  
**Historical data:** Jan–Feb 2026 (7 daily snapshots)

```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker\amazon-rank-tracker
python rank_tracker_multi.py
```

---

## 3. Amazon Hijacker Tracker (`amazon-pincode-checker/amazon-tools/`)

Selenium + ChromeDriver tool to detect unauthorized sellers on your Amazon listings.

**How it works:**
1. Reads `Input.xlsx` (columns: `asin`, `authorized_seller`, `marketplace`)
2. Opens each ASIN's offer listing page
3. Extracts all sellers with prices, fulfillment (FBA/FBM), ratings
4. Flags: `UNAUTHORIZED_SELLER`, `YOU_NOT_PRESENT`, `UNKNOWN_SELLER`, or `OK`

**Output:** `outputs/offers_latest.csv`, `outputs/alerts_latest.csv`

```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker\amazon-tools
python amazon_hijacker_tracker.py
```

---

## 4. Telegram Permission Bot (`amazon-pincode-checker/Claude Telegram Bot/`)

Sends approve/reject buttons via Telegram to gate automated actions.

**Key function:** `request_permission(description, timeout=120)` → returns `True`/`False`

**Setup:** `.env` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`  
**Note:** `.venv` was deleted to save space — recreate with `pip install python-telegram-bot python-dotenv` if needed.

---

## 5. Store Replenish Auto (`amazon-pincode-checker/Store Replenish Auto/`)

FBA store replenishment automation for separate seller accounts.

**Note:** `.venv` and duplicate `amazon_ads_tool/` were deleted (Apr 12, 2026) — recreate venv from `requirements.txt` if needed. Scripts should import from parent `amazon_ads_tool/` via `sys.path`.

---

## 6. BSR Web Tracker (Root Level — Legacy)

A Flask web app for tracking Amazon Best Seller Rank. Deployed via Docker/Render.

| File | Purpose |
|------|---------|
| `app.py` | Flask web app with upload/stream endpoints |
| `amazon_bsr_tracker.py` | Core BSR scraper (Playwright + BeautifulSoup) |
| `templates/index.html` | Web UI |
| `requirements.txt` | Flask + Playwright dependencies |
| `Dockerfile` | Docker container build |
| `render.yaml` | Render.com deployment config |
| `setup_server.sh` | Server setup script |
| `amazon-toolkit.service` | Systemd service file |
| `.venv/` | Separate venv for Flask app |

**Root debug/test scripts** (`debug_*.py`, `bsr_*.py`, `verify_*.py`, `search_html.py`, `test_pin_remote.py`) are BSR tracker development files.

---

## Cleanup Log

**April 12, 2026:**
- Deleted empty `reports/` at root (redundant)
- Deleted stale `bsr_history.csv` (last entry Jan 2026, all PARSE_FAIL)
- Deleted `debug_page.html`, `debug_pw.html` (stale HTML captures)
- Deleted all `__pycache__/` folders (5 locations)
- Deleted duplicate `amazon_ads_tool/` inside `Store Replenish Auto/`
- Deleted `.venv/` from `Store Replenish Auto/` and `Claude Telegram Bot/` (saved ~93 MB, recreate from requirements.txt)

---

## User Preferences

- **Always organize outputs into folders** — never dump files in root
- **All generated reports go to `output/`** inside amazon-pincode-checker
- **README is the source of truth** — update it when adding new tools or making structural changes
- **PowerShell quirk:** Write Python to .py files, don't use inline `-c` with multiline strings
- **python-dotenv** is NOT installed system-wide; scripts parse .env manually
