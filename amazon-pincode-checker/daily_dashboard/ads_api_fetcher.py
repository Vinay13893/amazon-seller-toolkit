"""
Ads API Data Fetcher — Campaign & ASIN Performance
====================================================
CACHE-FIRST approach:
  1. Check existing JSON reports in amazon_ads_tool/reports/ (default + monthly)
  2. If files were updated today or yesterday → load them directly, SKIP API calls
  3. Only make fresh API requests when cached files are stale (>1 day old)

This avoids unnecessary 2-5 minute waits for ads report generation.
"""

import os
import sys
import json
import time
import gzip
import logging
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

import pandas as pd
import requests

# ─── Setup: Add parent dir so we can import amazon_ads_tool ───
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

logger = logging.getLogger(__name__)

# ─── Cached Report Paths (from amazon_ads_tool) ───────────────
ADS_REPORTS_DIR = os.path.join(PARENT_DIR, "amazon_ads_tool", "reports")
CACHED_FILES = {
    'sp_campaigns': os.path.join(ADS_REPORTS_DIR, "sp_campaigns_data.json"),
    'sd_campaigns': os.path.join(ADS_REPORTS_DIR, "sd_campaigns_data.json"),
    'sp_products':  os.path.join(ADS_REPORTS_DIR, "sp_advertised_product_data.json"),
}
MONTHLY_DIR = os.path.join(ADS_REPORTS_DIR, "monthly")


# ─── Ads API Config (from .env) ───────────────────────────────
def _load_ads_config():
    """Load Ads API credentials from the .env file."""
    env_path = os.path.join(PARENT_DIR, ".env")
    config = {}
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    key, val = line.split('=', 1)
                    config[key.strip()] = val.strip().strip('"').strip("'")

    return {
        'client_id': config.get('AMZN_ADS_CLIENT_ID', ''),
        'client_secret': config.get('AMZN_ADS_CLIENT_SECRET', ''),
        'refresh_token': config.get('AMZN_ADS_REFRESH_TOKEN', ''),
        'profile_id': config.get('AMZN_ADS_PROFILE_ID', ''),
        'region': config.get('ADS_REGION', 'eu'),
    }


# ─── Token Cache ───────────────────────────────────────────────
_ads_token = None
_ads_token_time = 0

API_ENDPOINTS = {
    "na": "https://advertising-api.amazon.com",
    "eu": "https://advertising-api-eu.amazon.com",
    "fe": "https://advertising-api-fe.amazon.com",
}


def _get_ads_token(config):
    global _ads_token, _ads_token_time
    if _ads_token and time.time() - _ads_token_time < 3000:
        return _ads_token

    resp = requests.post('https://api.amazon.com/auth/o2/token', data={
        'grant_type': 'refresh_token',
        'refresh_token': config['refresh_token'],
        'client_id': config['client_id'],
        'client_secret': config['client_secret'],
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    _ads_token = data['access_token']
    _ads_token_time = time.time()
    return _ads_token


def _ads_request(method, path, config, body=None, accept=None):
    """Make an authenticated Ads API request."""
    base_url = API_ENDPOINTS[config['region']]
    token = _get_ads_token(config)
    headers = {
        'Authorization': f'Bearer {token}',
        'Amazon-Advertising-API-ClientId': config['client_id'],
        'Amazon-Advertising-API-Scope': config['profile_id'],
    }
    if accept:
        headers['Accept'] = accept
        headers['Content-Type'] = accept

    url = f"{base_url}{path}"
    resp = requests.request(method, url, json=body, headers=headers, timeout=60)

    if resp.status_code == 429:
        retry_after = int(resp.headers.get("Retry-After", 10))
        print(f"    Ads API rate limited — waiting {retry_after}s...")
        time.sleep(retry_after)
        return _ads_request(method, path, config, body, accept)

    return resp


# ─── Report Request/Poll/Download ─────────────────────────────
def _request_ads_report(config, report_config, start_date, end_date):
    """Request, poll, and download an ads report. Returns list of dicts."""
    body = json.loads(json.dumps(report_config))
    body['startDate'] = start_date
    body['endDate'] = end_date

    print(f"    Requesting ads report: {body.get('name', 'unknown')} ({start_date} → {end_date})")
    resp = _ads_request('POST', '/reporting/reports', config, body=body,
                        accept='application/vnd.createasyncreportrequest.v3+json')

    if resp.status_code == 425:
        # Duplicate report — extract existing ID
        import re
        match = re.search(r'duplicate of\s*:\s*([a-f0-9-]+)', resp.text, re.IGNORECASE)
        if match:
            report_id = match.group(1)
            print(f"    Reusing existing report: {report_id}")
        else:
            raise RuntimeError(f"425 duplicate but can't extract ID: {resp.text[:300]}")
    elif resp.status_code >= 400:
        raise RuntimeError(f"Ads API {resp.status_code}: {resp.text[:300]}")
    else:
        report_id = resp.json().get('reportId', '')

    # Poll — up to 20 minutes (DAILY reports can take 10-15 min)
    for attempt in range(240):
        time.sleep(5)
        poll_resp = _ads_request('GET', f'/reporting/reports/{report_id}', config,
                                  accept='application/vnd.createasyncreportrequest.v3+json')
        if poll_resp.status_code >= 400:
            raise RuntimeError(f"Poll error: {poll_resp.status_code}: {poll_resp.text[:200]}")
        result = poll_resp.json()
        status = result.get('status', '')

        if status == 'COMPLETED':
            url = result.get('url', '')
            break
        elif status == 'FAILURE':
            raise RuntimeError(f"Report failed: {result}")
        if attempt % 6 == 5:
            print(f"    [{(attempt+1)*5}s] status = {status}")
    else:
        raise TimeoutError("Ads report did not complete within 20 minutes.")

    # Download
    dl = requests.get(url, timeout=120)
    dl.raise_for_status()
    try:
        data = gzip.decompress(dl.content)
        return json.loads(data)
    except gzip.BadGzipFile:
        return json.loads(dl.content)


# ─── Report Configurations ────────────────────────────────────
SP_CAMPAIGN_REPORT = {
    "name": "Dashboard SP Campaign Daily",
    "configuration": {
        "adProduct": "SPONSORED_PRODUCTS",
        "groupBy": ["campaign"],
        "columns": [
            "campaignName", "campaignId", "campaignStatus", "campaignBudgetAmount",
            "impressions", "clicks", "cost", "purchases1d", "sales1d", "unitsSoldClicks1d",
        ],
        "reportTypeId": "spCampaigns",
        "format": "GZIP_JSON",
        "timeUnit": "SUMMARY",
    },
}

SD_CAMPAIGN_REPORT = {
    "name": "Dashboard SD Campaign Daily",
    "configuration": {
        "adProduct": "SPONSORED_DISPLAY",
        "groupBy": ["campaign"],
        "columns": [
            "campaignName", "campaignId", "campaignStatus",
            "impressions", "clicks", "cost", "purchases", "sales", "unitsSoldClicks",
        ],
        "reportTypeId": "sdCampaigns",
        "format": "GZIP_JSON",
        "timeUnit": "SUMMARY",
    },
}

SP_PRODUCT_REPORT = {
    "name": "Dashboard SP Product Daily",
    "configuration": {
        "adProduct": "SPONSORED_PRODUCTS",
        "groupBy": ["advertiser"],
        "columns": [
            "campaignName", "campaignId", "adGroupName", "adGroupId",
            "advertisedAsin", "advertisedSku",
            "impressions", "clicks", "cost", "purchases1d", "sales1d", "unitsSoldClicks1d",
        ],
        "reportTypeId": "spAdvertisedProduct",
        "format": "GZIP_JSON",
        "timeUnit": "SUMMARY",
    },
}

# ─── Daily Report Configs (timeUnit=DAILY for date-range filtering) ───
SP_CAMPAIGN_DAILY_REPORT = {
    "name": "Dashboard SP Campaign Daily Breakdown",
    "configuration": {
        "adProduct": "SPONSORED_PRODUCTS",
        "groupBy": ["campaign"],
        "columns": [
            "date", "campaignName", "campaignId", "campaignStatus",
            "impressions", "clicks", "cost", "purchases1d", "sales1d", "unitsSoldClicks1d",
        ],
        "reportTypeId": "spCampaigns",
        "format": "GZIP_JSON",
        "timeUnit": "DAILY",
    },
}

SD_CAMPAIGN_DAILY_REPORT = {
    "name": "Dashboard SD Campaign Daily Breakdown",
    "configuration": {
        "adProduct": "SPONSORED_DISPLAY",
        "groupBy": ["campaign"],
        "columns": [
            "date", "campaignName", "campaignId", "campaignStatus",
            "impressions", "clicks", "cost", "purchases", "sales", "unitsSoldClicks",
        ],
        "reportTypeId": "sdCampaigns",
        "format": "GZIP_JSON",
        "timeUnit": "DAILY",
    },
}


# ─── Cache Helpers ─────────────────────────────────────────────
def _get_freshest_file(candidates):
    """Given a list of file paths, return the most recently modified one that exists.
    Returns (path, mod_datetime) or (None, None).
    """
    best_path, best_time = None, None
    for fpath in candidates:
        if os.path.exists(fpath) and os.path.getsize(fpath) > 10:
            mt = datetime.fromtimestamp(os.path.getmtime(fpath))
            if best_time is None or mt > best_time:
                best_path, best_time = fpath, mt
    return best_path, best_time


def _file_is_fresh(filepath, max_age_hours=48):
    """Check if a file exists and was modified within max_age_hours.
    Default 48h to cover weekends and overnight gaps.
    """
    if not os.path.exists(filepath):
        return False
    mod_time = datetime.fromtimestamp(os.path.getmtime(filepath))
    age = datetime.now() - mod_time
    return age.total_seconds() < max_age_hours * 3600


def _find_best_cache(report_type):
    """Find the freshest cached JSON for a report type.
    Checks both default/ and monthly/ folders.
    
    report_type: 'sp_campaigns' | 'sd_campaigns' | 'sp_products'
    Returns (filepath, mod_datetime) or (None, None)
    """
    candidates = []
    
    # Default reports (last 30 days)
    if report_type in CACHED_FILES:
        candidates.append(CACHED_FILES[report_type])
    
    # Monthly reports — current month
    month_str = datetime.now().strftime('%Y-%m')
    monthly_map = {
        'sp_campaigns': f'sp_campaigns_{month_str}.json',
        'sd_campaigns': f'sd_campaigns_{month_str}.json',
        'sp_products':  f'sp_advertised_product_{month_str}.json',
    }
    if report_type in monthly_map:
        candidates.append(os.path.join(MONTHLY_DIR, monthly_map[report_type]))
    
    return _get_freshest_file(candidates)


def _load_json_file(filepath):
    """Load a JSON file. Returns list of dicts or empty list."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"    Warning: Could not load {filepath}: {e}")
        return []


def _save_json_file(filepath, data):
    """Save data as JSON."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


# ─── Public: Fetch Ads Campaign Data (CACHE-FIRST) ────────────
def fetch_ads_campaigns(start_date=None, end_date=None):
    """Load SP + SD campaign data. Checks cache first, only fetches if stale.
    
    Cache sources (checked in order, picks freshest):
      1. amazon_ads_tool/reports/sp_campaigns_data.json (default 30-day)
      2. amazon_ads_tool/reports/monthly/sp_campaigns_2026-04.json
    """
    all_rows = []
    
    # ── SP Campaigns ──
    best_sp, sp_mod = _find_best_cache('sp_campaigns')
    if best_sp and _file_is_fresh(best_sp):
        sp_data = _load_json_file(best_sp)
        print(f"  [Ads] SP campaigns: loaded {len(sp_data)} rows from cache ({sp_mod:%Y-%m-%d %H:%M})")
        for row in sp_data:
            row['ad_type'] = 'SP'
        all_rows.extend(sp_data)
    else:
        src = f"({sp_mod:%Y-%m-%d %H:%M})" if sp_mod else "(missing)"
        print(f"  [Ads] SP campaigns cache stale {src} — fetching from API...")
        try:
            config = _load_ads_config()
            if not config['client_id']:
                print("  [Ads] WARNING: No Ads API credentials. Skipping SP.")
            else:
                sd_str = start_date if isinstance(start_date, str) else (start_date.strftime('%Y-%m-%d') if start_date else (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d'))
                ed_str = end_date if isinstance(end_date, str) else (end_date.strftime('%Y-%m-%d') if end_date else (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d'))
                sp_data = _request_ads_report(config, SP_CAMPAIGN_REPORT, sd_str, ed_str)
                _save_json_file(CACHED_FILES['sp_campaigns'], sp_data)
                for row in sp_data:
                    row['ad_type'] = 'SP'
                all_rows.extend(sp_data)
                print(f"  [Ads] SP campaigns: fetched {len(sp_data)} rows")
        except Exception as e:
            print(f"  [Ads] SP campaign fetch error: {e}")
    
    # ── SD Campaigns ──
    best_sd, sd_mod = _find_best_cache('sd_campaigns')
    if best_sd and _file_is_fresh(best_sd):
        sd_data = _load_json_file(best_sd)
        print(f"  [Ads] SD campaigns: loaded {len(sd_data)} rows from cache ({sd_mod:%Y-%m-%d %H:%M})")
        for row in sd_data:
            row['ad_type'] = 'SD'
            if 'purchases' in row and 'purchases1d' not in row:
                row['purchases1d'] = row.pop('purchases')
            if 'sales' in row and 'sales1d' not in row:
                row['sales1d'] = row.pop('sales')
            if 'unitsSoldClicks' in row and 'unitsSoldClicks1d' not in row:
                row['unitsSoldClicks1d'] = row.pop('unitsSoldClicks')
        all_rows.extend(sd_data)
    else:
        src = f"({sd_mod:%Y-%m-%d %H:%M})" if sd_mod else "(missing)"
        print(f"  [Ads] SD campaigns cache stale {src} — fetching from API...")
        try:
            config = _load_ads_config()
            if config['client_id']:
                sd_str = start_date if isinstance(start_date, str) else (start_date.strftime('%Y-%m-%d') if start_date else (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d'))
                ed_str = end_date if isinstance(end_date, str) else (end_date.strftime('%Y-%m-%d') if end_date else (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d'))
                sd_data = _request_ads_report(config, SD_CAMPAIGN_REPORT, sd_str, ed_str)
                _save_json_file(CACHED_FILES['sd_campaigns'], sd_data)
                for row in sd_data:
                    row['ad_type'] = 'SD'
                    if 'purchases' in row and 'purchases1d' not in row:
                        row['purchases1d'] = row.pop('purchases')
                    if 'sales' in row and 'sales1d' not in row:
                        row['sales1d'] = row.pop('sales')
                    if 'unitsSoldClicks' in row and 'unitsSoldClicks1d' not in row:
                        row['unitsSoldClicks1d'] = row.pop('unitsSoldClicks')
                all_rows.extend(sd_data)
                print(f"  [Ads] SD campaigns: fetched {len(sd_data)} rows")
        except Exception as e:
            print(f"  [Ads] SD campaign fetch error: {e}")
    
    if not all_rows:
        return pd.DataFrame()
    
    df = pd.DataFrame(all_rows)
    for col in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
    return df


# ─── Public: Fetch Ads Product (ASIN) Data (CACHE-FIRST) ──────
def fetch_ads_products(start_date=None, end_date=None):
    """Load SP advertised product (ASIN-level) data. Cache-first."""
    best_file, mod_time = _find_best_cache('sp_products')
    
    if best_file and _file_is_fresh(best_file):
        data = _load_json_file(best_file)
        print(f"  [Ads] SP products: loaded {len(data)} rows from cache ({mod_time:%Y-%m-%d %H:%M})")
    else:
        src = f"({mod_time:%Y-%m-%d %H:%M})" if mod_time else "(missing)"
        print(f"  [Ads] SP products cache stale {src} — fetching from API...")
        try:
            config = _load_ads_config()
            if not config['client_id']:
                print("  [Ads] WARNING: No Ads API credentials. Skipping.")
                return pd.DataFrame()
            sd_str = start_date if isinstance(start_date, str) else (start_date.strftime('%Y-%m-%d') if start_date else (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d'))
            ed_str = end_date if isinstance(end_date, str) else (end_date.strftime('%Y-%m-%d') if end_date else (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d'))
            data = _request_ads_report(config, SP_PRODUCT_REPORT, sd_str, ed_str)
            _save_json_file(CACHED_FILES['sp_products'], data)
            print(f"  [Ads] SP products: fetched {len(data)} rows")
        except Exception as e:
            print(f"  [Ads] SP product fetch error: {e}")
            return pd.DataFrame()
    
    if not data:
        return pd.DataFrame()
    
    df = pd.DataFrame(data)
    for col in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
    return df


# ─── Incremental chunk save helper ─────────────────────────────
def _save_chunk_to_bank(bank_name, rows):
    """Append a chunk of rows to a data bank CSV immediately (incremental save)."""
    if not rows:
        return
    import pandas as pd
    bank_dir = os.path.join(SCRIPT_DIR, "data_bank")
    os.makedirs(bank_dir, exist_ok=True)
    path = os.path.join(bank_dir, f"{bank_name}.csv")
    df_new = pd.DataFrame(rows)
    for col in ['impressions', 'clicks', 'cost', 'purchases1d', 'sales1d', 'unitsSoldClicks1d']:
        if col in df_new.columns:
            df_new[col] = pd.to_numeric(df_new[col], errors='coerce').fillna(0)
    if 'date' in df_new.columns:
        df_new['date'] = pd.to_datetime(df_new['date'], errors='coerce').dt.strftime('%Y-%m-%d')

    if os.path.exists(path) and os.path.getsize(path) > 0:
        df_existing = pd.read_csv(path)
        df_combined = pd.concat([df_existing, df_new], ignore_index=True)
        df_combined = df_combined.drop_duplicates()
    else:
        df_combined = df_new

    df_combined.to_csv(path, index=False)
    return len(df_new)


def _get_already_fetched_dates(bank_name):
    """Load the existing bank and return the set of dates already fetched."""
    bank_dir = os.path.join(SCRIPT_DIR, "data_bank")
    path = os.path.join(bank_dir, f"{bank_name}.csv")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        df = pd.read_csv(path)
        if 'date' in df.columns:
            return set(pd.to_datetime(df['date'], errors='coerce').dt.strftime('%Y-%m-%d').dropna())
    return set()


def fetch_ads_campaigns_daily(start_date=None, end_date=None):
    """Fetch daily-level SP + SD campaign data for a given date range.
    Returns DataFrame with a 'date' column for per-day filtering.
    
    Uses 14-day chunks (faster report generation on Amazon's side).
    Each chunk is saved immediately to CSV so progress isn't lost on timeout.
    Skips chunks where all dates have already been fetched (resume support).
    """
    config = _load_ads_config()
    if not config['client_id']:
        print("  [Ads] WARNING: No Ads API credentials. Skipping daily.")
        return pd.DataFrame()

    if end_date is None:
        end_date = (datetime.now() - timedelta(days=1)).date()
    elif isinstance(end_date, str):
        end_date = datetime.strptime(end_date, '%Y-%m-%d').date()

    if start_date is None:
        start_date = end_date - timedelta(days=29)
    elif isinstance(start_date, str):
        start_date = datetime.strptime(start_date, '%Y-%m-%d').date()

    total_days = (end_date - start_date).days + 1
    print(f"  [Ads] Fetching daily campaigns: {start_date} → {end_date} ({total_days} days)")

    # Check what's already been fetched (for resume support)
    already_fetched = _get_already_fetched_dates('ads_campaigns_daily')
    if already_fetched:
        print(f"    Resume: {len(already_fetched)} dates already in bank")

    all_data = []
    MAX_CHUNK = 14  # Smaller chunks = faster Amazon report generation
    saved_count = 0

    chunk_start = start_date
    chunk_num = 0
    while chunk_start <= end_date:
        chunk_end = min(chunk_start + timedelta(days=MAX_CHUNK - 1), end_date)
        chunk_num += 1
        sd_str = chunk_start.strftime('%Y-%m-%d')
        ed_str = chunk_end.strftime('%Y-%m-%d')

        # Check if this chunk is already fully fetched
        chunk_dates = set()
        d = chunk_start
        while d <= chunk_end:
            chunk_dates.add(d.strftime('%Y-%m-%d'))
            d += timedelta(days=1)
        if chunk_dates.issubset(already_fetched):
            print(f"    Chunk {chunk_num}: {sd_str} → {ed_str} — already fetched, skipping")
            chunk_start = chunk_end + timedelta(days=1)
            continue

        print(f"    Chunk {chunk_num}: {sd_str} → {ed_str}")
        chunk_rows = []

        # SP Daily
        try:
            sp_data = _request_ads_report(config, SP_CAMPAIGN_DAILY_REPORT, sd_str, ed_str)
            for row in sp_data:
                row['ad_type'] = 'SP'
            chunk_rows.extend(sp_data)
            print(f"      SP: {len(sp_data)} rows")
        except Exception as e:
            print(f"  [Ads] SP daily fetch error ({sd_str}→{ed_str}): {e}")

        # SD Daily — has shorter retention (~65 days), skip if out of range
        sd_retention_start = (datetime.now().date() - timedelta(days=65))
        sd_chunk_start = max(chunk_start, sd_retention_start)
        if sd_chunk_start <= chunk_end:
            sd_start_str = sd_chunk_start.strftime('%Y-%m-%d')
            try:
                sd_data = _request_ads_report(config, SD_CAMPAIGN_DAILY_REPORT, sd_start_str, ed_str)
                for row in sd_data:
                    row['ad_type'] = 'SD'
                    if 'purchases' in row and 'purchases1d' not in row:
                        row['purchases1d'] = row.pop('purchases')
                    if 'sales' in row and 'sales1d' not in row:
                        row['sales1d'] = row.pop('sales')
                    if 'unitsSoldClicks' in row and 'unitsSoldClicks1d' not in row:
                        row['unitsSoldClicks1d'] = row.pop('unitsSoldClicks')
                chunk_rows.extend(sd_data)
                print(f"      SD: {len(sd_data)} rows")
            except Exception as e:
                print(f"  [Ads] SD daily fetch error ({sd_start_str}→{ed_str}): {e}")
        else:
            print(f"      SD: skipping (before retention window)")

        # Save this chunk immediately
        if chunk_rows:
            n = _save_chunk_to_bank('ads_campaigns_daily', chunk_rows)
            saved_count += n
            print(f"      Saved chunk → {n} rows (total saved: {saved_count})")
            all_data.extend(chunk_rows)

        chunk_start = chunk_end + timedelta(days=1)

    # Return the full dataset from bank (includes any previously saved chunks)
    bank_dir = os.path.join(SCRIPT_DIR, "data_bank")
    path = os.path.join(bank_dir, "ads_campaigns_daily.csv")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        df = pd.read_csv(path)
        print(f"  [Ads] Daily campaigns total: {len(df)} rows in bank")
        return df

    return pd.DataFrame()


# ─── Public: Fetch Daily Ads Products (ASIN-level) ────────────
SP_PRODUCT_DAILY_REPORT = {
    "name": "Dashboard SP Product Daily Breakdown",
    "configuration": {
        "adProduct": "SPONSORED_PRODUCTS",
        "groupBy": ["advertiser"],
        "columns": [
            "date", "campaignName", "campaignId", "adGroupName", "adGroupId",
            "advertisedAsin", "advertisedSku",
            "impressions", "clicks", "cost", "purchases1d", "sales1d", "unitsSoldClicks1d",
        ],
        "reportTypeId": "spAdvertisedProduct",
        "format": "GZIP_JSON",
        "timeUnit": "DAILY",
    },
}


def fetch_ads_products_daily(start_date=None, end_date=None):
    """Fetch daily ASIN-level SP ads data.
    Uses 14-day chunks with incremental saving and resume support.
    """
    config = _load_ads_config()
    if not config['client_id']:
        print("  [Ads] WARNING: No Ads API credentials. Skipping daily products.")
        return pd.DataFrame()

    if end_date is None:
        end_date = (datetime.now() - timedelta(days=1)).date()
    elif isinstance(end_date, str):
        end_date = datetime.strptime(end_date, '%Y-%m-%d').date()

    if start_date is None:
        start_date = end_date - timedelta(days=29)
    elif isinstance(start_date, str):
        start_date = datetime.strptime(start_date, '%Y-%m-%d').date()

    total_days = (end_date - start_date).days + 1
    print(f"  [Ads] Fetching daily products: {start_date} → {end_date} ({total_days} days)")

    # Check what's already been fetched (for resume support)
    already_fetched = _get_already_fetched_dates('ads_products_daily')
    if already_fetched:
        print(f"    Resume: {len(already_fetched)} dates already in bank")

    all_data = []
    MAX_CHUNK = 14  # Smaller chunks = faster Amazon report generation
    saved_count = 0

    chunk_start = start_date
    chunk_num = 0
    while chunk_start <= end_date:
        chunk_end = min(chunk_start + timedelta(days=MAX_CHUNK - 1), end_date)
        chunk_num += 1
        sd_str = chunk_start.strftime('%Y-%m-%d')
        ed_str = chunk_end.strftime('%Y-%m-%d')

        # Check if this chunk is already fully fetched
        chunk_dates = set()
        d = chunk_start
        while d <= chunk_end:
            chunk_dates.add(d.strftime('%Y-%m-%d'))
            d += timedelta(days=1)
        if chunk_dates.issubset(already_fetched):
            print(f"    Chunk {chunk_num}: {sd_str} → {ed_str} — already fetched, skipping")
            chunk_start = chunk_end + timedelta(days=1)
            continue

        print(f"    Chunk {chunk_num}: {sd_str} → {ed_str}")

        try:
            data = _request_ads_report(config, SP_PRODUCT_DAILY_REPORT, sd_str, ed_str)
            if data:
                n = _save_chunk_to_bank('ads_products_daily', data)
                saved_count += n
                print(f"      SP products: {len(data)} rows → saved (total: {saved_count})")
                all_data.extend(data)
        except Exception as e:
            print(f"  [Ads] SP product daily fetch error ({sd_str}→{ed_str}): {e}")

        chunk_start = chunk_end + timedelta(days=1)

    # Return the full dataset from bank (includes any previously saved chunks)
    bank_dir = os.path.join(SCRIPT_DIR, "data_bank")
    path = os.path.join(bank_dir, "ads_products_daily.csv")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        df = pd.read_csv(path)
        print(f"  [Ads] Daily products total: {len(df)} rows in bank")
        return df

    return pd.DataFrame()


if __name__ == '__main__':
    print("Testing Ads API connection...")
    try:
        config = _load_ads_config()
        token = _get_ads_token(config)
        print(f"  Token obtained: {token[:20]}...")
        print("  Ads API connection OK!")
    except Exception as e:
        print(f"  ERROR: {e}")
