# Amazon Ads Tool — Quick Reference

## What This Is
Python tool that pulls Amazon Advertising API v3 reports (SP, SD, SB campaigns), analyzes ASIN/keyword/search-term performance, categorizes winners/losers, and exports CSV reports.

## Location
```
c:\amazon-bsr-tracker\amazon-pincode-checker\
```

## Credentials
`.env` file at `c:\amazon-bsr-tracker\amazon-pincode-checker\.env` with:
```
AMZN_ADS_CLIENT_ID=...
AMZN_ADS_CLIENT_SECRET=...
AMZN_ADS_REFRESH_TOKEN=...
AMZN_ADS_REGION=eu
AMZN_ADS_MARKETPLACE=IN
AMZN_ADS_PROFILE_ID=...
AMZN_ADS_TARGET_ACOS=25.0
AMZN_ADS_MAX_BID=50.0
AMZN_ADS_MIN_BID=1.0
```

## Python Environment
```
Venv: c:\amazon-bsr-tracker\amazon-pincode-checker\.venv
Activate: .\.venv\Scripts\activate
Direct: c:\amazon-bsr-tracker\amazon-pincode-checker\.venv\Scripts\python.exe
```

## How to Run

### Full Analysis (requests + polls + analyzes + CSV export)
```powershell
cd c:\amazon-bsr-tracker\amazon-pincode-checker
.\.venv\Scripts\activate
python run_report.py
```
- Requests 6 report types from Amazon API in parallel
- Polls until all are COMPLETED (timeout ~900s)
- Downloads, analyzes, prints analysis, saves CSV
- **Takes 15-30 minutes** because Amazon EU/IN is slow to generate reports
- If it times out, use `check_reports.py` (see below)

### Resume/Check Already-Requested Reports
```powershell
c:\amazon-bsr-tracker\amazon-pincode-checker\.venv\Scripts\python.exe c:\amazon-bsr-tracker\amazon-pincode-checker\check_reports.py
```
- Edit `REPORT_IDS` dict at top of `check_reports.py` with the report UUIDs from the run_report.py output
- Polls with 30-minute timeout, then downloads + analyzes + exports CSV
- Use this when run_report.py timed out but reports are still generating on Amazon's side

### CLI Module Commands
```powershell
python -m amazon_ads_tool profiles       # List ad profiles
python -m amazon_ads_tool report --days 30  # Basic report
```

## Output Folders
```
raw_data/       — Raw API JSON + CSV (timestamped, e.g. sp_campaigns_data_20260410.json)
csv_reports/    — Analysis CSVs (timestamped):
                   asin_analysis_YYYYMMDD.csv
                   keyword_analysis_YYYYMMDD.csv
                   search_term_analysis_YYYYMMDD.csv
                   campaign_analysis_YYYYMMDD.csv
reports/        — Legacy folder (older runs)
```

## Report Types Requested
| Key                    | API reportTypeId      | What It Contains                          |
|------------------------|-----------------------|-------------------------------------------|
| sp_campaigns           | spCampaigns           | SP campaign-level metrics                 |
| sp_targeting           | spTargeting           | Keywords/targets with bids + performance  |
| sp_search_terms        | spSearchTerm          | Customer search terms + conversions       |
| sp_advertised_product  | spAdvertisedProduct   | ASIN/SKU level performance                |
| sd_campaigns           | sdCampaigns           | Sponsored Display campaigns               |
| sb_campaigns           | sbCampaigns           | Sponsored Brands campaigns (often 429s)   |

## CSV Categories (Analysis Logic)
**ASIN:** WINNER (ACoS < target, ≥3 orders), PUSH HARDER (ACoS < 70% of target, ≥2 orders), LOSER-PAUSE (0 orders, >₹100 spend), LOSER-CUT BIDS (ACoS > 2× target), MONITOR (everything else)

**Keywords:** TOP PERFORMER (ACoS < target, ≥2 orders), NEGATE (0 orders, >₹50 spend), CUT BID 40% (ACoS > 2× target), MONITOR

**Search Terms:** BEST CONVERTING (≥2 orders, ACoS < target), ADD AS NEGATIVE (0 orders, >₹30 spend), CONVERTING (≥2 orders), MONITOR

## Key Files
```
run_report.py              — Main script: request → poll → download → analyze → CSV
check_reports.py           — Resume script: poll known report IDs → download → analyze → CSV
amazon_ads_tool/
  config.py                — Config dataclass, load_config(), metric column lists
  api_client.py            — AmazonAdsClient (auth, rate limits, gzip download)
  reports.py               — ReportManager (request_report, poll, download, _date_range)
  analyzer.py              — PerformanceAnalyzer (compute_campaign_metrics)
  optimizer.py             — BidOptimizer, SearchTermHarvester
  campaigns.py             — CampaignManager (list/update campaigns)
  __main__.py              — CLI entry point (profiles, report, optimize commands)
```

## API Quirks
- **Region EU, Marketplace IN** → endpoint: `https://advertising-api-eu.amazon.com`
- **SP columns** use `1d` suffix: `purchases1d`, `sales1d`, `unitsSoldClicks1d`
- **SD/SB columns** have NO suffix: `purchases`, `sales`, `unitsSoldClicks`
- **HTTP 425** = duplicate report already requested → regex-extract existing report ID from response
- **HTTP 429** = rate limited (SB campaigns hit this often) → retry with backoff
- **Date range**: end date is always **yesterday** (Amazon data has 1-day lag)
- **Report generation time**: 15-30 min typical for EU/IN; do NOT kill early
- **DAYS variable** in run_report.py controls lookback period (default: 30)

## Troubleshooting
- If reports stuck PENDING: wait longer (up to 30 min), or use check_reports.py
- If SB returns 429: expected, non-critical — SP + SD are the important ones
- CWD matters for dotenv: run from `c:\amazon-bsr-tracker\amazon-pincode-checker\` or use absolute python path
- If `check_reports.py` fails with import errors: use the full venv python path directly
