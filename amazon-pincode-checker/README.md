# EMOUNT Ventures — Amazon Ads & Analytics Toolkit

> **Last updated:** April 12, 2026
> **Workspace:** `e:\amazon-bsr-tracker\amazon-pincode-checker\`
> **Owner:** EMOUNT Ventures (eHomekart / LilToes brands on Amazon.in)

## Quick Start for AI Assistants

**If the user says "read the readme" or "get up to speed" — read this file in full.** It contains everything about the project: structure, data pipeline, credentials, category config, analysis scripts, key findings, and all generated reports.

---

## What This Project Does

A comprehensive Amazon India (amazon.in) e-commerce automation and analytics hub:

1. **Amazon Ads API integration** — pulls SP (Sponsored Products) and SD (Sponsored Display) campaign reports, ASIN-level data, search terms, and keyword targeting
2. **Amazon SP-API integration** — fetches real order data (365 days, 40K+ orders) with SKU/ASIN/quantity/price
3. **Category-based P&L analysis** — classifies ASINs into 6 product categories, computes unit economics, organic vs paid split, margin analysis
4. **Pincode availability checking** — Playwright-based tool that checks delivery promises across Indian pincodes
5. **Sponsored product intelligence** — scrapes and extracts sponsored product data from Amazon.in search results
6. **YouTube content generation** — viral title generator + YouTube Shorts video creator with AI voiceover
7. **Amazon Rank Tracker** — Playwright-based keyword rank tracker for ASINs on Amazon.in with Google Sheets sync
8. **Amazon Hijacker Tracker** — Selenium-based tool that scans offer listings to detect unauthorized sellers on your ASINs
9. **Telegram Permission Bot** — Telegram bot for approve/reject gating of automated actions from scripts/VS Code

---

## Credentials & Auth

### Amazon Ads API
- **Config:** `.env` file in project root (DO NOT commit)
- **Region:** `eu` (India marketplace is in EU selling region)
- **Marketplace:** `IN`
- **Profile ID:** `1119208106810251`
- **API Version:** v3 (async GZIP_JSON reports)
- **Keys in .env:** `AMZN_ADS_CLIENT_ID`, `AMZN_ADS_CLIENT_SECRET`, `AMZN_ADS_REFRESH_TOKEN`, `AMZN_ADS_REGION`, `AMZN_ADS_MARKETPLACE`, `AMZN_ADS_PROFILE_ID`
- **Multi-client support:** Via `AMZN_ADS_CLIENTS` prefix in config.py

### Amazon SP-API (Seller API)
- **Config:** `category_analysis/sp_api_config.json`
- **Used for:** Fetching real order data (365d), FBA inventory
- **Auth:** AWS Signature V4 (no sp-api library dependency)

### Python Environment
- **Primary venv:** `amazon_ads_tool/.venv/` (activate with `& amazon_ads_tool\.venv\Scripts\Activate.ps1`)
- **System Python:** `C:\Python314`
- **Key packages:** pandas 3.0.2, openpyxl 3.1.5, requests 2.33.1, numpy 2.4.4
- **Note:** `python-dotenv` is NOT installed system-wide; scripts manually parse .env files

---

## The 6 Product Categories

Defined in `category_analysis/categories.py`. Each has SKU patterns, campaign patterns, direct ASIN lists, and target metrics.

| Key | Display Name | Target ACoS | Target Ads ROAS | Target Blended ROAS | # ASINs |
|-----|-------------|-------------|-----------------|---------------------|---------|
| `ASM` | Anti-Slip Mats (Shelf Liners) | 20% | 5x | 10x | 13 |
| `EVA_Kids` | EVA Kids Floor Mat (Multicolor) | 10% | 10x | 18x | 24 |
| `EVA_Gym` | EVA Gym Floor Mat (Black/Grey) | 10% | 10x | 18x | 22 |
| `BPM` | Baby Play Mat (Reversible/Foldable) | 18% | 5.5x | 11x | 5 |
| `Storage` | Storage Bags | 18% | 5.5x | 11x | 15 |
| `WTC` | Water Tank Cover | 10% | 10x | 20x | 0 (no ads yet) |

**Classification priority:** Direct ASIN match → SKU pattern match → Campaign name pattern → UNCATEGORIZED

**Helper functions:**
- `classify_asin(asin, sku)` → returns category key (e.g., `"EVA_Kids"`)
- `classify_campaign(campaign_name)` → returns category key
- `get_target(category_key, metric)` → returns target value

---

## Data Sources & Pipeline

### Raw Data (fetched from APIs)

| Source | File | Rows | Date Range | What It Contains |
|--------|------|------|------------|------------------|
| SP-API Orders | `category_analysis/cache_orders_365d.csv` | 40,858 | 2025-04-11 → 2026-04-10 | sku, asin, quantity, item_price, item_status, order_date |
| SP Campaigns | `amazon_ads_tool/reports/sp_campaigns_data.json` | 141 | 30-day default | cost, clicks, impressions, campaignName, campaignBudgetAmount |
| SD Campaigns | `amazon_ads_tool/reports/sd_campaigns_data.json` | 44 | 30-day default | Same structure as SP |
| SP ASIN-level | `amazon_ads_tool/reports/sp_advertised_product_data.json` | 627 | 30-day default | advertisedAsin, advertisedSku, cost, sales1d, clicks, campaignName, adGroupName |
| SP Search Terms | `amazon_ads_tool/reports/sp_search_terms_data.json` | 7,392 | 30-day default | searchTerm, cost, sales1d, clicks, impressions, purchases1d, campaignName, adGroupName |
| SP Targeting | `amazon_ads_tool/reports/sp_targeting_data.json` | 318 | 30-day default | keyword, keywordBid, matchType, cost, sales1d, clicks, campaignName |

### Monthly Snapshots (in `amazon_ads_tool/reports/monthly/`)

| Report Type | Jan | Feb | Mar | Apr | Fields |
|-------------|-----|-----|-----|-----|--------|
| `sp_campaigns_YYYY-MM.json` | ✅ | ✅ | ✅ | ✅ | cost, sales1d, clicks, impressions, campaignName, campaignBudgetAmount |
| `sp_advertised_product_YYYY-MM.json` | ✅ | ✅ | ✅ | ✅ | advertisedAsin, cost, sales1d, unitsSoldClicks1d, campaignName, adGroupName |
| `sd_campaigns_YYYY-MM.json` | ✅ | ✅ | ✅ | ✅ | cost, sales1d, clicks, impressions, campaignName |

### Prorating Constants (important for all monthly comparisons)

| Month | SP Days | SD Days | Notes |
|-------|---------|---------|-------|
| 2026-01 | 26 | 0 | SP data starts Jan 6, no SD |
| 2026-02 | 28 | 24 | SD starts Feb 5 |
| 2026-03 | 31 | 31 | Full month |
| 2026-04 | 11 | 11 | Only Apr 1–11 (as of last run) |

**All monthly comparisons MUST use daily averages and project to 30 days.** Raw totals are misleading because months have different data coverage.

### JSON Field Names (critical — varies by report type)

- **Monthly ASIN reports:** `sales1d`, `unitsSoldClicks1d`, `purchases1d` (NOT `sales` or `unitsSoldClicks`)
- **SP Campaigns:** `campaignBudgetAmount` for budget, but NO sales attribution (sales come from ASIN-level reports)
- **Search Terms:** `searchTerm`, `cost`, `sales1d`, `clicks`, `impressions`, `purchases1d`

---

## Key Analysis Scripts

### Core Analysis Pipeline

| Script | Purpose | Input | Output | Run Command |
|--------|---------|-------|--------|-------------|
| `twelve_month_analysis.py` | 12-month revenue + ads comparison | SP-API orders + Ads API | Excel report + console | `python twelve_month_analysis.py --use-cache` |
| `deep_analysis.py` | 8-dimension deep analysis | Cached data | Console output (8 analyses) | `python deep_analysis.py` |
| `campaign_deep_dive.py` | Why is April expensive? | Monthly JSONs | Console output (6 analyses) | `python campaign_deep_dive.py` |
| `action_report.py` | Prorated CSV reports | Monthly JSONs + orders | 5 CSVs (report_*.csv) | `python action_report.py` |
| `master_analysis.py` | **Full professional audit** | ALL data sources | 6 master CSVs | `python master_analysis.py` |
| `_summary_stats.py` | Quick summary numbers | Master CSVs | Console output | `python _summary_stats.py` |

### Master Analysis Outputs (as of April 12, 2026)

| CSV File | Rows | What It Contains |
|----------|------|------------------|
| `master_asin_report.csv` | 208 | Full P&L per ASIN: actual 90d revenue + 12m revenue, ad spend/sales/ROAS/ACoS, organic %, blended ROAS, estimated margin, duplication count, campaign list, monthly trend |
| `master_duplication_report.csv` | 627 | Every ASIN-campaign combination with spend/sales/ROAS — shows which ASINs are in too many campaigns |
| `master_search_terms.csv` | 5,769 | All search terms with action recommendations (NEGATE/SCALE/DEDUPLICATE/MONITOR), campaign count, ROAS, spend |
| `master_keyword_bids.csv` | 318 | Keywords with bid vs actual CPC, overbid detection, ROAS alerts |
| `master_category_pl.csv` | 6 | Category P&L: revenue, ad spend, ACoS vs target, unit economics, organic %, monthly CPC/ROAS trends |
| `master_competitor_targeting.csv` | 1,289 | All ASIN targeting entries with own-ASIN flag, ROAS, action recommendations |

### Action Report Outputs (prorated)

| CSV File | Rows | What It Contains |
|----------|------|------------------|
| `report_asin_performance.csv` | 103 | ASIN performance with daily averages and 30d projections |
| `report_campaign_performance.csv` | 193 | Campaign performance prorated |
| `report_category_trend.csv` | 21 | Category metrics per month |
| `report_monthly_summary.csv` | 4 | Monthly aggregate totals |
| `report_action_items.csv` | 23 | Prioritized action items |

### Other Scripts

| Script | Purpose |
|--------|---------|
| `run_report.py` | Fetches ALL reports from Amazon Ads API in parallel. Main data ingestion script. |
| `find_bleeders.py` | Finds bleeding campaigns (ACoS > 80%) |
| `generate_excel_report.py` | Creates team-facing Excel from category analysis |
| `amazon_pincode_checker.py` | Checks product availability across Indian pincodes (Playwright) |
| `amazon_sponsored_clicker1.py` | Detects & clicks sponsored products on Amazon.in |
| `youtube_viral_titles.py` | 5-step viral title generator (scrape → Claude → Gemini Deep Research) |
| `create_shorts.py` | YouTube Shorts video creator with AI voiceover |

---

## Key Findings (April 12, 2026 Audit)

### Overall Performance
- **Total Ad Spend (Jan–Apr):** Rs 7.99L
- **Total Ad Sales (Jan–Apr):** Rs 58.7L → **7.35x Ad ROAS**
- **Total Actual Revenue (90d):** Rs 1.42 Cr → **17.78x Blended ROAS**
- **Estimated Profit (90d):** Rs 57.3L on Rs 1.31 Cr revenue (43.7% margin)

### Critical Issues Found

#### 1. ASIN Duplication (Self-Competition)
- **28 ASINs in 10+ campaigns**, 9 ASINs in 20+ campaigns
- Worst: B0D9HB8LTP in **30 campaigns**, B0D9HH4VYG in 27, B0CN177JS7 in 24
- This drives up CPCs by bidding against yourself in auctions
- Rs 1.43L in 30-day spend on heavily duplicated ASINs

#### 2. Search Term Cannibalization
- **97 search terms appear in 3+ campaigns** — Rs 1.47L in self-competition
- "interlocking floor mat" triggers in **10 campaigns** simultaneously
- "interlocking play mat for kids" in 8 campaigns

#### 3. Search Term Waste
- **280 search terms to NEGATE** — Rs 38,238 total waste
- Top waste: "plastic sheet for kitchen shelves" (Rs 1,214, 0.19x ROAS), "baby mat" (Rs 612, 0x)

#### 4. Storage Bags Category Bleeding
- ACoS 31.6% vs 18% target (**13.6% over target**)
- CPC rising fast: Rs 10.5 → 12 → 12.9 → **15.9** (April)
- ROAS only 3.16x vs 5.5x target

#### 5. Own ASIN Targeting Waste
- 138 entries targeting own ASINs in "Defensive" campaigns — Rs 11,969 waste
- These are cannibalized organic sales, not incremental

#### 6. Negative Margin ASINs
- **B0CRKV5XTR** (EVA Gym): Revenue Rs 1.3L, Ad Spend Rs 72K → **-5.8% margin**, in 22 campaigns
- **B0CRKQJNL4** (EVA Kids): Revenue Rs 910, Ad Spend Rs 540 → **-9.4% margin**

#### 7. Unadvertised ASINs
- **72 selling ASINs have zero ads** — 23 in EVA Gym, 24 in ASM

#### 8. CPC Inflation (April worst)
- EVA Kids: 6.1 → 5.6 → 6.3 → **7.8**
- EVA Gym: 6.9 → 7.5 → 7.7 → **8.6**
- Storage: 10.5 → 12 → 12.9 → **15.9**
- Root cause: ASIN duplication + keyword cannibalization

### Category Performance Summary

| Category | Rev 90d | ACoS | Target | Organic% | Margin% | Status |
|----------|---------|------|--------|----------|---------|--------|
| EVA Kids | Rs 54.4L | 10.0% | 10% | 42.9% | 44.3% | ✅ On target |
| EVA Gym | Rs 46.5L | 12.0% | 10% | 58.0% | 45.0% | ⚠️ 2% over |
| ASM | Rs 20.5L | 22.7% | 20% | 67.3% | 42.6% | ⚠️ Slightly over |
| BPM | Rs 3.9L | 25.0% | 18% | 66.0% | 41.5% | ⚠️ 7% over |
| Storage | Rs 4.9L | 31.6% | 18% | 36.5% | 29.9% | 🔴 Critical |
| WTC | Rs 83K | — | 10% | 100% | 50% | No ads |

### Unit Economics

| Category | Avg Price | Profit/Unit (Before Ads) | Ad Cost/Unit | Profit/Ad Unit |
|----------|-----------|--------------------------|--------------|----------------|
| EVA Gym | Rs 2,155 | Rs 1,077 | Rs 249 | Rs 828 |
| EVA Kids | Rs 1,958 | Rs 979 | Rs 201 | Rs 778 |
| BPM | Rs 876 | Rs 438 | Rs 211 | Rs 227 |
| Storage | Rs 566 | Rs 283 | Rs 165 | Rs 118 |
| ASM | Rs 327 | Rs 164 | Rs 126 | **Rs 38** |

### Priority Actions

1. Consolidate ASINs into fewer campaigns (9 ASINs in 20+ campaigns)
2. Negate 280 losing search terms (Rs 38K immediate savings)
3. Fix Storage Bags (31.6% ACoS vs 18% target)
4. Negate own-ASIN targeting in Defensive campaigns (Rs 12K waste)
5. Consolidate 97 duplicated search terms (Rs 1.47L self-competition)
6. Pause/reduce B0CRKV5XTR ads (negative margin)
7. Scale star keywords: "interlocking foam mats for kids" (79.6x ROAS)
8. Add ads for 72 unadvertised selling ASINs

---

## Directory Structure

```
amazon-pincode-checker/
├── .env                               # Amazon Ads API credentials (DO NOT commit)
├── README.md                          # ← THIS FILE
│
├── ── ANALYSIS SCRIPTS (root — need relative imports to category_analysis/) ──
├── master_analysis.py                 # Full professional audit → 6 master CSVs → output/
├── action_report.py                   # Prorated monthly reports → 5 report CSVs → output/
├── deep_analysis.py                   # 8-dimension analysis (console)
├── campaign_deep_dive.py              # Why is April expensive? (console)
├── twelve_month_analysis.py           # 12-month revenue + ads → output/*.xlsx
├── _summary_stats.py                  # Quick summary from output/ CSVs
├── find_bleeders.py                   # High-ACoS campaign finder
├── generate_excel_report.py           # Team-facing Excel → output/
├── run_report.py                      # Fetch ALL ads reports (parallel)
├── check_reports.py                   # Resume/check report status
├── list_profiles.py                   # List Ads API profiles
├── get_refresh_token.py               # OAuth2 token helper
│
├── output/                            # ALL generated reports go here
│   ├── master_asin_report.csv         # 208 ASINs: full P&L
│   ├── master_duplication_report.csv  # 627 ASIN-campaign combos
│   ├── master_search_terms.csv        # 5,769 search terms + actions
│   ├── master_keyword_bids.csv        # 318 keywords + bid analysis
│   ├── master_category_pl.csv         # 6 categories: unit economics
│   ├── master_competitor_targeting.csv# 1,289 competitor ASIN targets
│   ├── report_*.csv                   # Prorated action reports (5 files)
│   ├── 12_Month_Performance_*.xlsx    # 12-month Excel reports
│   ├── Ads_Performance_Report_*.xlsx  # Ads performance Excel
│   └── *.txt                          # Analysis text logs
│
├── amazon_ads_tool/                   # Ads API package
│   ├── .venv/                         # Python virtualenv
│   ├── config.py, api_client.py, reports.py, optimizer.py, analyzer.py
│   └── reports/                       # Raw API data (JSON)
│       ├── sp_campaigns_data.json, sd_campaigns_data.json
│       ├── sp_advertised_product_data.json, sp_search_terms_data.json
│       ├── sp_targeting_data.json
│       └── monthly/                   # Jan–Apr 2026 snapshots
│
├── category_analysis/                 # Category config + SP-API
│   ├── categories.py                  # 6 categories with patterns & targets
│   ├── sp_api_client.py, sp_api_config.json
│   ├── cache_orders_365d.csv          # 40,858 orders (365 days)
│   └── cache_orders_30d.csv           # Recent 30-day orders
│
├── pincode_checker/                   # Amazon pincode availability tool
│   ├── amazon_pincode_checker.py      # Playwright-based checker
│   ├── asins.csv, pincodes.csv        # Input files
│   └── amazon_availability_report*.csv# Output reports
│
├── sponsored_scraper/                 # Sponsored product intelligence
│   ├── amazon_sponsored_clicker1.py, amazon_sponsored_stage1.py
│   ├── click_and_extract.py, extract_simple.py, extract_v2.py
│   └── *.csv                          # Scraping results
│
├── youtube/                           # YouTube content tools
│   ├── youtube_viral_titles.py        # Viral title generator (Claude+Gemini)
│   ├── create_shorts.py              # YouTube Shorts video creator
│   ├── apify_myeasyhome_fetch.py     # Instagram scraper
│   ├── shorts_videos/                 # Generated videos
│   └── calmcreations15_results/       # Channel scraping results
│
├── amazon-rank-tracker/               # Keyword rank tracker for Amazon.in
│   ├── rank_tracker_multi.py          # Multi-ASIN rank tracker (Playwright)
│   ├── rank_tracker_single.py         # Single keyword-ASIN pair tracker
│   ├── rank_input.xlsx                # Input: keyword-ASIN mappings
│   ├── rank_master_multi.csv          # Historical rank data (multi)
│   ├── rank_master_single.csv         # Historical rank data (single)
│   ├── rank_logs_multi/               # Daily rank snapshots (Jan–Feb 2026)
│   ├── rank_logs_single/              # Daily rank snapshots
│   ├── secret/gsheets-key.json        # Google Sheets service account key
│   └── rank_dashboard.xlsx, rank_output.xlsx  # Dashboard outputs
│
├── amazon-tools/                      # Hijacker/unauthorized seller tracker
│   ├── amazon_hijacker_tracker.py     # Selenium-based offer listing scraper
│   ├── Input.xlsx                     # Input: asin, authorized_seller, marketplace
│   ├── chromedriver.exe               # Chrome WebDriver
│   ├── outputs/
│   │   ├── offers_latest.csv          # All sellers found per ASIN
│   │   ├── alerts_latest.csv          # Unauthorized seller alerts only
│   │   └── history/                   # Historical scans
│   └── test_browser.py               # Browser test script
│
├── Claude Telegram Bot/               # Telegram permission gating bot
│   ├── telegram_bot/
│   │   ├── bot.py                     # Core: request_permission() async function
│   │   ├── example.py                 # Usage demo (start bot + send request)
│   │   ├── .env                       # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
│   │   └── requirements.txt           # python-telegram-bot, python-dotenv
│   └── .venv/                         # Separate virtualenv
│
├── ghee_research/                     # Ghee market research results
├── debug/                             # Debug scripts & temp files
├── Store Replenish Auto/              # Separate account (FBA replenishment)
├── Daily Herbs Previous Output File/  # Daily Herbs product content
├── Ads Analytics Claude/              # Claude analysis report archives
├── amazon_profile/                    # Playwright browser profile
└── amazon_search_profile/             # Search browser profile
```

---

## Tool Details: Amazon Rank Tracker (`amazon-rank-tracker/`)

Tracks keyword search rank positions for your ASINs on Amazon.in using Playwright (headless browser). Scans up to 7 pages per keyword.

**Two modes:**
- `rank_tracker_single.py` — One keyword → one ASIN pair per row (sheet: "Pairs")
- `rank_tracker_multi.py` — One keyword → multiple ASINs per row, grouped (sheet: "MultiPairs")

**Input:** `rank_input.xlsx` with columns: `group | keyword | asins` (comma-separated for multi)
**Output:** Daily CSV logs in `rank_logs_multi/`, cumulative `rank_master_multi.csv`
**Google Sheets sync:** Enabled via `SYNC_TO_GSHEETS = True`, needs `secret/gsheets-key.json` service account key

```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker\amazon-rank-tracker
python rank_tracker_multi.py
```

**Historical data available:** Jan–Feb 2026 (7 daily snapshots)

---

## Tool Details: Amazon Hijacker Tracker (`amazon-tools/`)

Scans Amazon offer listings (buy box page) for each ASIN to detect unauthorized sellers. Uses Selenium + ChromeDriver.

**How it works:**
1. Reads `Input.xlsx` (columns: `asin`, `authorized_seller`, `marketplace`)
2. Opens the offer listing page for each ASIN
3. Extracts all sellers: name, seller ID, price, fulfillment (FBA/FBM), rating
4. Flags sellers not matching `authorized_seller` as `UNAUTHORIZED_SELLER`
5. Flags if authorized seller is missing as `YOU_NOT_PRESENT`

**Output:**
- `outputs/offers_latest.csv` — All sellers found for all ASINs
- `outputs/alerts_latest.csv` — Only unauthorized/missing seller alerts

```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker\amazon-tools
python amazon_hijacker_tracker.py
```

**Requires:** ChromeDriver (included), Selenium, BeautifulSoup4, lxml, pandas

---

## Tool Details: Telegram Permission Bot (`Claude Telegram Bot/`)

A Telegram bot that sends permission requests with Approve/Reject inline buttons. Designed to gate automated actions — caller awaits the Telegram response before proceeding.

**Key function:** `request_permission(description, timeout=120)` — sends message to Telegram, returns `True` (approved) or `False` (rejected/timeout)

**Setup:**
- `.env` needs: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Separate venv at `Claude Telegram Bot/.venv/`
- `pip install python-telegram-bot python-dotenv`

```python
from bot import request_permission, run_bot
approved = await request_permission("Deploy to production?")
```

---

## How to Update Data

### Refresh Ads Reports (monthly)
```powershell
cd e:\amazon-bsr-tracker\amazon-pincode-checker
& amazon_ads_tool\.venv\Scripts\Activate.ps1
python run_report.py
```
This fetches all SP/SD reports in parallel, saves to `amazon_ads_tool/reports/`.
Monthly data should be manually copied/renamed to `monthly/sp_campaigns_YYYY-MM.json` etc.

### Refresh Orders Data
```powershell
python twelve_month_analysis.py --use-cache   # uses cached if < 24h old
python twelve_month_analysis.py               # forces fresh fetch
```
Orders cache saved to `category_analysis/cache_orders_365d.csv`.

### Re-run Full Analysis
```powershell
python master_analysis.py    # generates all 6 master CSVs
python _summary_stats.py     # quick summary to console
```

### Re-run Prorated Reports
```powershell
python action_report.py      # generates 5 report CSVs
```
**Remember to update prorating days** at the top of `action_report.py` and `master_analysis.py` when running for a new month!

---

## Technical Notes

- **PowerShell escaping:** Multiline Python scripts with quotes fail in PowerShell `-c`. Always write to `.py` files and run them.
- **SP Campaign ROAS 0.00x:** The `sp_campaigns` report type does NOT return sales attribution. Actual ad sales come from `sp_advertised_product` (ASIN-level) reports.
- **Data retention:** SP reports go back ~95 days, SD ~65 days. That's why we cache monthly snapshots.
- **`python-dotenv` not installed system-wide:** Scripts in this project manually parse `.env` files. Don't rely on `load_dotenv()`.
- **Profit estimation formula:** Revenue × 50% (after 30% Amazon fees + 20% estimated COGS) minus ad spend. Adjust COGS % if actual manufacturing costs are known.

---

## Version History

| Date | What Changed |
|------|-------------|
| 2026-04-12 | Master analysis: 6 CSVs, full audit with duplication/waste/competitor analysis |
| 2026-04-12 | Prorated action reports: 5 CSVs with proper daily averages |
| 2026-04-11 | Campaign deep dive: why April is expensive |
| 2026-04-11 | Deep 8-dimension analysis |
| 2026-04-11 | 12-month revenue analysis + Excel report |
| 2026-04-10 | Monthly data cached for Jan–Apr 2026 |
| 2026-03-30 | YouTube inventory scraping + Shorts generation |
| 2026-03-30 | Amazon pincode checker built |
