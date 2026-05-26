# Amazon Ads Automation Tool - Setup & API Connection Guide

## What This Tool Does

Built for your agency to automate Amazon Ads management across all your clients:

| Feature | Description |
|---------|-------------|
| **Report Downloads** | Pull SP, SD, SB reports via API (campaigns, targeting, search terms) |
| **Monthly Analysis** | Auto-generate performance reports with ACoS, ROAS, CTR, problem campaigns |
| **Bid Optimization** | Increase bids on winners, decrease on losers, pause zero-converters |
| **Search Term Harvesting** | Auto-move converting search terms to exact match keywords |
| **Negative Keywords** | Auto-negate search terms wasting spend (high clicks, zero sales) |
| **Bleeding Campaigns** | Find and pause campaigns with extreme ACoS |
| **Multi-Client** | Manage all your agency clients from one tool |

---

## Step 1: Create Amazon Developer Account

1. Go to **https://developer.amazon.com/** and sign in
2. Click **"Developer Console"** → **"Login with Amazon"**
3. Click **"Create a New Security Profile"**
   - Name: `YourAgency Ads Tool`
   - Description: `Internal ads automation`
   - Privacy URL: Your website URL
4. Note down:
   - **Client ID** (starts with `amzn1.application-oa2-client.`)
   - **Client Secret**

---

## Step 2: Register for Amazon Advertising API

1. Go to **https://advertising.amazon.com/API**
2. Click **"Request Access"**
3. Fill in the form:
   - **Company Name:** Your agency name
   - **API Use Case:** Campaign management & reporting
   - **Account Type:** Agency
4. Wait for approval (usually 1-3 business days)

---

## Step 3: Get Authorization (Refresh Token)

This is the most important step. You need a **refresh token** for each Amazon seller account you manage.

### Option A: Using the LWA Authorization Flow (Recommended)

1. Open this URL in browser (replace YOUR_CLIENT_ID):
```
https://www.amazon.com/ap/oa?client_id=YOUR_CLIENT_ID&scope=advertising::campaign_management&response_type=code&redirect_uri=https://localhost/callback
```

2. Log in with the **seller's Amazon account** (or your agency account)
3. Grant permissions
4. You'll be redirected to: `https://localhost/callback?code=AUTH_CODE_HERE`
5. Copy the `code` parameter value

6. Exchange the code for tokens (run in terminal):
```bash
curl -X POST https://api.amazon.com/auth/o2/token \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE_HERE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://localhost/callback"
```

7. You'll get back:
```json
{
  "access_token": "Atza|...",
  "refresh_token": "Atzr|...",
  "token_type": "bearer",
  "expires_in": 3600
}
```

8. **Save the `refresh_token`** — this is what goes in your `.env` file. It does not expire.

### Option B: Using the helper script

```bash
python -m amazon_ads_tool.get_token --client-id YOUR_ID --client-secret YOUR_SECRET
```
(This will open a browser and handle the flow automatically — we can build this if needed)

---

## Step 4: Configure the Tool

```bash
# Copy example config
cp .env.example .env

# Edit .env with your credentials
```

Fill in your `.env`:
```env
AMZN_ADS_CLIENT_ID=amzn1.application-oa2-client.xxxxx
AMZN_ADS_CLIENT_SECRET=your_secret
AMZN_ADS_REFRESH_TOKEN=Atzr|your_refresh_token
AMZN_ADS_REGION=eu
AMZN_ADS_MARKETPLACE=IN
```

---

## Step 5: Get Your Profile ID

```bash
pip install -r amazon_ads_tool/requirements.txt
python -m amazon_ads_tool profiles
```

This shows all advertising profiles (accounts) you have access to. Copy the Profile ID for your seller account and add it to `.env`:

```env
AMZN_ADS_PROFILE_ID=1234567890
```

---

## Usage

### List all campaigns
```bash
python -m amazon_ads_tool campaigns
```

### Download all reports (last 30 days)
```bash
python -m amazon_ads_tool download --days 30
```

### Download specific report
```bash
python -m amazon_ads_tool download --type sp_search_terms --days 14
```
Report types: `sp_campaigns`, `sp_targeting`, `sp_search_terms`, `sd_campaigns`, `sb_campaigns`

### Generate monthly performance report
```bash
python -m amazon_ads_tool report --days 30
```
Outputs a markdown report with:
- Overall KPIs (spend, sales, ACoS, ROAS, CTR)
- Performance by ad type (SP/SD/SB)
- Top 10 campaigns by spend
- Problem campaigns (high ACoS)
- Star campaigns (below target ACoS)
- Bid optimization recommendations
- Search term analysis

### Run optimization (DRY RUN - preview only)
```bash
python -m amazon_ads_tool optimize
```
Shows what changes would be made:
- Bid increases for strong performers (ACoS < 70% of target)
- Bid decreases for weak performers (ACoS > 130% of target)
- Keyword pauses for zero-converters (30+ clicks, 0 sales)
- Search term harvesting (3+ conversions → exact match)
- Search term negation (30+ clicks, 0 sales → negative exact)

### Run optimization (LIVE - applies changes)
```bash
python -m amazon_ads_tool optimize-live
```
⚠️ This actually changes bids and keywords. Always dry-run first!

### Find bleeding campaigns
```bash
python -m amazon_ads_tool pause-bleeders --max-acos 80
```

---

## Multi-Client Setup (Agency)

For managing multiple seller accounts:

```env
# List all clients
AMZN_ADS_CLIENTS=default,storexyz,brandabc

# Client: storexyz
AMZN_ADS_STOREXYZ_CLIENT_ID=amzn1.application-oa2-client.xxx
AMZN_ADS_STOREXYZ_CLIENT_SECRET=secret
AMZN_ADS_STOREXYZ_REFRESH_TOKEN=Atzr|token
AMZN_ADS_STOREXYZ_REGION=eu
AMZN_ADS_STOREXYZ_MARKETPLACE=IN
AMZN_ADS_STOREXYZ_PROFILE_ID=123456
AMZN_ADS_STOREXYZ_TARGET_ACOS=20.0
```

Then use `--client`:
```bash
python -m amazon_ads_tool report --client storexyz
python -m amazon_ads_tool optimize --client brandabc
```

---

## Optimization Logic

### Bid Adjustment Rules

| Condition | Action |
|-----------|--------|
| ACoS < 70% of target & 2+ orders | Increase bid by 20% (capped at max_bid) |
| ACoS > 130% of target & 1+ orders | Decrease bid by 30% (min = min_bid) |
| 30+ clicks & 0 orders | Pause keyword/target |
| < 20 clicks | No action (insufficient data) |

### Search Term Rules

| Condition | Action |
|-----------|--------|
| 3+ conversions & ACoS < 150% target | Harvest → exact match keyword |
| 30+ clicks & 0 conversions | Negate → negative exact match |

### Settings You Can Tune

| Setting | Default | What it does |
|---------|---------|-------------|
| `TARGET_ACOS` | 25% | Your target ACoS percentage |
| `MAX_BID` | ₹50 | Maximum bid cap |
| `MIN_BID` | ₹1 | Minimum bid floor |
| `bid_increase_pct` | 20% | How much to increase winning bids |
| `bid_decrease_pct` | 30% | How much to decrease losing bids |
| `min_clicks_for_decision` | 20 | Min clicks before making changes |
| `search_term_harvest_threshold` | 3 | Min conversions to harvest term |
| `negate_after_clicks` | 30 | Negate after N clicks with 0 sales |

---

## Project Structure

```
amazon_ads_tool/
├── __init__.py          # Package init
├── __main__.py          # CLI entry point
├── config.py            # Configuration & settings
├── auth.py              # OAuth2 authentication (LWA)
├── api_client.py        # Core API client (SP, SB, SD)
├── reports.py           # Report generation & downloading
├── campaigns.py         # Campaign management
├── optimizer.py         # Bid optimization & search term harvesting
├── analyzer.py          # Performance analysis & report generation
└── requirements.txt     # Python dependencies
```

---

## Amazon Advertising API Reference

- **API Docs:** https://advertising.amazon.com/API/docs/en-us
- **SP API:** Sponsored Products v3
- **SB API:** Sponsored Brands v4
- **SD API:** Sponsored Display v3
- **Reporting:** Async Reports v3
- **Rate Limits:** 10 requests/second (handled automatically)
- **Auth:** Login with Amazon (LWA) OAuth2
