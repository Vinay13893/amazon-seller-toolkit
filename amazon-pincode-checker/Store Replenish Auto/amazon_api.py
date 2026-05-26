"""
Amazon SP-API Integration Module
=================================
Fetches order data and FBA inventory from Amazon SP-API (India).
Uses requests + AWS Signature V4 directly (no sp_api dependency).

Usage:
    python amazon_api.py --setup    # Configure credentials
    python amazon_api.py --test     # Test API connection
    python amazon_api.py --fetch    # Fetch & save data to Excel
"""

import json
import os
import sys
import time
import getpass
import hashlib
import hmac
import gzip
from datetime import datetime, timedelta, timezone
from io import StringIO
from urllib.parse import urlencode, quote

import requests as req
import pandas as pd
import numpy as np

# ─── Paths ─────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, "sp_api_config.json")

MARKETPLACE_ID = "A21TJRUUN4KGV"  # Amazon India
SP_API_HOST = "sellingpartnerapi-eu.amazon.com"  # India is in EU selling region
SP_API_BASE = f"https://{SP_API_HOST}"
SP_API_REGION = "eu-west-1"

# Status mapping: SP-API / report statuses → pivot column names
STATUS_MAP = {
    # Cancelled variants
    'Cancelled': 'Cancelled', 'Canceled': 'Cancelled',
    'Buyer-Cancelled': 'Cancelled', 'Seller-Cancelled': 'Cancelled',
    # Pending variants
    'Pending': 'Pending', 'Unshipped': 'Pending',
    'PendingAvailability': 'Pending', 'InvoiceUnconfirmed': 'Pending',
    # Shipped variants
    'Shipped': 'Shipped', 'PartiallyShipped': 'Shipped',
    # Delivery
    'Delivered': 'Shipped - Delivered to Buyer',
    'Shipped - Delivered to Buyer': 'Shipped - Delivered to Buyer',
    # Out for delivery
    'Out for Delivery': 'Shipped - Out for Delivery',
    'Shipped - Out for Delivery': 'Shipped - Out for Delivery',
    # Picked up
    'Picked Up': 'Shipped - Picked Up',
    'Shipped - Picked Up': 'Shipped - Picked Up',
    # Returns / rejections
    'Returned': 'Shipped - Returned to Seller',
    'Shipped - Returned to Seller': 'Shipped - Returned to Seller',
    'Shipped - Returning to Seller': 'Shipped - Returning to Seller',
    'Rejected': 'Shipped - Rejected by Buyer',
    'Shipped - Rejected by Buyer': 'Shipped - Rejected by Buyer',
    'Refunded': 'Shipped - Returned to Seller',
    'Unfulfillable': 'Cancelled',
}

# All status columns expected in the output pivot
PIVOT_STATUS_COLUMNS = [
    'Cancelled', 'Pending', 'Pending - Waiting for Pick Up', 'Shipped',
    'Shipped - Delivered to Buyer', 'Shipped - Out for Delivery',
    'Shipped - Picked Up', 'Shipped - Rejected by Buyer',
    'Shipped - Returned to Seller', 'Shipped - Returning to Seller',
]


# ─── Config ────────────────────────────────────────────────────
def load_config():
    """Load SP-API credentials from local config file."""
    if not os.path.exists(CONFIG_FILE):
        print(f"\n  Config not found: {CONFIG_FILE}")
        print("  Run: python amazon_api.py --setup\n")
        sys.exit(1)
    with open(CONFIG_FILE, 'r') as f:
        config = json.load(f)
    required = ['lwa_app_id', 'lwa_client_secret', 'refresh_token',
                'aws_access_key', 'aws_secret_key']
    missing = [k for k in required if not config.get(k)]
    if missing:
        print(f"\n  Missing credentials: {', '.join(missing)}")
        print("  Run: python amazon_api.py --setup\n")
        sys.exit(1)
    return config


def get_credentials(config=None):
    """Return credentials dict for sp_api library."""
    c = config or load_config()
    return dict(
        refresh_token=c['refresh_token'],
        lwa_app_id=c['lwa_app_id'],
        lwa_client_secret=c['lwa_client_secret'],
        aws_access_key=c['aws_access_key'],
        aws_secret_key=c['aws_secret_key'],
    )


def setup_credentials():
    """Interactive credential setup wizard."""
    print("=" * 55)
    print("  Amazon SP-API — Credential Setup")
    print("=" * 55)
    print("\n  Paste each value when prompted.\n")

    config = {}
    config['lwa_app_id'] = input("  LWA Client ID: ").strip()
    config['lwa_client_secret'] = getpass.getpass("  LWA Client Secret: ").strip()
    config['refresh_token'] = getpass.getpass("  Refresh Token: ").strip()
    config['aws_access_key'] = input("  AWS Access Key ID: ").strip()
    config['aws_secret_key'] = getpass.getpass("  AWS Secret Access Key: ").strip()

    for k, v in config.items():
        if not v:
            print(f"\n  ERROR: {k} is empty. Aborting.")
            sys.exit(1)

    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

    print(f"\n  Saved to: {CONFIG_FILE}")
    print("  Next: python amazon_api.py --test")


# ─── AWS Signature V4 ─────────────────────────────────────────
def _sign(key, msg):
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()


def _get_signature_key(secret, date_stamp, region, service):
    k_date = _sign(('AWS4' + secret).encode('utf-8'), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    k_signing = _sign(k_service, 'aws4_request')
    return k_signing


def _get_access_token(config=None):
    """Exchange refresh token for a short-lived access token via LWA."""
    c = config or load_config()
    resp = req.post('https://api.amazon.com/auth/o2/token', data={
        'grant_type': 'refresh_token',
        'refresh_token': c['refresh_token'],
        'client_id': c['lwa_app_id'],
        'client_secret': c['lwa_client_secret'],
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if 'access_token' not in data:
        raise RuntimeError(f"LWA auth failed: {data}")
    return data['access_token']


# Token cache
_cached_token = None
_cached_token_time = None


def _get_token():
    global _cached_token, _cached_token_time
    now = datetime.now(timezone.utc)
    if _cached_token and _cached_token_time and (now - _cached_token_time).seconds < 3000:
        return _cached_token
    _cached_token = _get_access_token()
    _cached_token_time = now
    return _cached_token


def _sp_api_request(method, path, params=None, body=None):
    """Make an authenticated SP-API request with AWS Sig V4 signing."""
    config = load_config()
    access_token = _get_token()

    now = datetime.now(timezone.utc)
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    date_stamp = now.strftime('%Y%m%d')

    # Canonical request
    canonical_uri = path
    canonical_querystring = urlencode(sorted(params.items())) if params else ''

    payload = json.dumps(body) if body else ''
    payload_hash = hashlib.sha256(payload.encode('utf-8')).hexdigest()

    headers_to_sign = {
        'host': SP_API_HOST,
        'x-amz-access-token': access_token,
        'x-amz-date': amz_date,
    }
    signed_headers = ';'.join(sorted(headers_to_sign.keys()))
    canonical_headers = ''.join(
        f'{k}:{v}\n' for k, v in sorted(headers_to_sign.items())
    )

    canonical_request = '\n'.join([
        method, canonical_uri, canonical_querystring,
        canonical_headers, signed_headers, payload_hash
    ])

    # String to sign
    algorithm = 'AWS4-HMAC-SHA256'
    credential_scope = f'{date_stamp}/{SP_API_REGION}/execute-api/aws4_request'
    string_to_sign = '\n'.join([
        algorithm, amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()
    ])

    # Signature
    signing_key = _get_signature_key(
        config['aws_secret_key'], date_stamp, SP_API_REGION, 'execute-api'
    )
    signature = hmac.new(signing_key, string_to_sign.encode('utf-8'),
                         hashlib.sha256).hexdigest()

    authorization = (
        f'{algorithm} Credential={config["aws_access_key"]}/{credential_scope}, '
        f'SignedHeaders={signed_headers}, Signature={signature}'
    )

    request_headers = {
        'host': SP_API_HOST,
        'x-amz-access-token': access_token,
        'x-amz-date': amz_date,
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'User-Agent': 'StoreReplenishAuto/1.0 (Language=Python)',
    }

    url = f'{SP_API_BASE}{path}'
    if canonical_querystring:
        url += f'?{canonical_querystring}'

    if method == 'GET':
        resp = req.get(url, headers=request_headers, timeout=60)
    elif method == 'POST':
        resp = req.post(url, headers=request_headers, data=payload, timeout=60)
    else:
        raise ValueError(f"Unsupported method: {method}")

    if resp.status_code == 429:  # throttle
        retry_after = int(resp.headers.get('x-amzn-RateLimit-Limit', 2))
        wait = max(2, 60 // max(1, retry_after))
        print(f"    Rate limited — waiting {wait}s ...")
        time.sleep(wait)
        return _sp_api_request(method, path, params, body)

    if resp.status_code >= 400:
        raise RuntimeError(f"SP-API {resp.status_code}: {resp.text[:500]}")

    return resp.json()


# ─── Reports API ───────────────────────────────────────────────
def _request_report(report_type, start_date=None, end_date=None):
    """Request a report, poll until done, download and parse as DataFrame."""

    body = {
        'reportType': report_type,
        'marketplaceIds': [MARKETPLACE_ID],
    }
    if start_date:
        body['dataStartTime'] = start_date.strftime('%Y-%m-%dT%H:%M:%SZ')
    if end_date:
        body['dataEndTime'] = end_date.strftime('%Y-%m-%dT%H:%M:%SZ')

    res = _sp_api_request('POST', '/reports/2021-06-30/reports', body=body)
    report_id = res.get('reportId')
    if not report_id:
        raise RuntimeError(f"No reportId in response: {res}")
    print(f"    Report ID: {report_id}  — waiting for Amazon to generate ...")

    # Poll
    for attempt in range(30):
        time.sleep(30)
        status_res = _sp_api_request('GET', f'/reports/2021-06-30/reports/{report_id}')
        status = status_res.get('processingStatus', 'UNKNOWN')
        elapsed = (attempt + 1) * 30
        print(f"    [{elapsed}s] status = {status}")

        if status == 'DONE':
            doc_id = status_res.get('reportDocumentId')
            break
        if status in ('CANCELLED', 'FATAL'):
            raise RuntimeError(f"Report failed ({status})")
    else:
        raise TimeoutError("Report did not complete within 15 minutes.")

    # Get document URL
    doc_res = _sp_api_request('GET', f'/reports/2021-06-30/documents/{doc_id}')
    url = doc_res.get('url')
    if not url:
        raise ValueError(f"No download URL: {doc_res}")

    # Download — this URL is pre-signed, no auth needed
    dl = req.get(url, timeout=120)
    dl.raise_for_status()

    data = dl.content
    compression = doc_res.get('compressionAlgorithm', '')
    if compression == 'GZIP':
        data = gzip.decompress(data)

    text = data.decode('utf-8-sig')
    return pd.read_csv(StringIO(text), sep='\t', dtype=str)


def _find_col(df, candidates):
    """Find the first matching column name from a list of candidates."""
    for c in candidates:
        if c in df.columns:
            return c
    return None


# ─── Order data ────────────────────────────────────────────────
def fetch_orders_data(days=30):
    """
    Fetch last N days of order data from Amazon SP-API.
    Returns DataFrame in the same hierarchical pivot format as the
    manual Excel download (Row Labels / status columns / Grand Total).
    If days > 30, splits into multiple 30-day chunks (API limit).
    """
    print("  Requesting order report from Amazon SP-API ...")
    end_dt = datetime.now(timezone.utc)
    start_dt = end_dt - timedelta(days=days)

    # SP-API report supports max 30-day range; split into chunks if needed
    MAX_CHUNK = 30
    chunks = []
    chunk_start = start_dt
    chunk_num = 0
    while chunk_start < end_dt:
        chunk_end = min(chunk_start + timedelta(days=MAX_CHUNK), end_dt)
        chunk_num += 1
        print(f"    Chunk {chunk_num}: {chunk_start.strftime('%Y-%m-%d')} → {chunk_end.strftime('%Y-%m-%d')}")
        chunk_raw = _request_report(
            'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
            chunk_start, chunk_end,
        )
        print(f"      Downloaded {len(chunk_raw)} rows")
        chunks.append(chunk_raw)
        chunk_start = chunk_end

    raw = pd.concat(chunks, ignore_index=True)
    print(f"    Total downloaded: {len(raw)} order-item rows across {chunk_num} chunk(s)")
    return _pivot_orders(raw)


def _pivot_orders(raw):
    """Convert flat order rows into hierarchical SKU/state pivot table."""
    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]
    print(f"    Report columns: {list(raw.columns)}")

    sku_col = _find_col(raw, ['sku', 'seller-sku', 'merchant-sku'])
    status_col = _find_col(raw, ['item-status', 'order-status', 'order-item-status'])
    state_col = _find_col(raw, ['ship-state', 'shipping-state',
                                 'ship-state-or-region', 'recipient-state'])
    qty_col = _find_col(raw, ['quantity', 'quantity-purchased', 'qty'])

    if not sku_col or not status_col:
        raise ValueError(
            f"Cannot find required columns (sku / status). "
            f"Available columns: {list(raw.columns)}"
        )

    # Clean data
    raw[sku_col] = raw[sku_col].fillna('UNKNOWN').str.strip()
    raw[status_col] = raw[status_col].fillna('Unknown').str.strip()

    if state_col:
        raw[state_col] = raw[state_col].fillna('').str.strip().str.upper()
    else:
        raw['_state'] = ''
        state_col = '_state'

    if qty_col:
        raw[qty_col] = pd.to_numeric(raw[qty_col], errors='coerce').fillna(1).astype(int)
    else:
        raw['_qty'] = 1
        qty_col = '_qty'

    # Map statuses to our standard names
    raw['_status'] = raw[status_col].map(
        lambda x: STATUS_MAP.get(x.strip(), STATUS_MAP.get(x.strip().title(), 'Shipped'))
    )

    # SKU-level pivot
    sku_piv = raw.pivot_table(
        index=sku_col, columns='_status',
        values=qty_col, aggfunc='sum', fill_value=0
    )

    # SKU + State pivot
    sku_st_piv = raw.pivot_table(
        index=[sku_col, state_col], columns='_status',
        values=qty_col, aggfunc='sum', fill_value=0
    )

    # Build hierarchical rows matching the manual Excel format
    rows = []
    for sku in sku_piv.index:
        # SKU total row
        r = {'Row Labels': sku}
        for s in PIVOT_STATUS_COLUMNS:
            r[s] = int(sku_piv.at[sku, s]) if s in sku_piv.columns else 0
        r['Grand Total'] = sum(v for k, v in r.items() if k != 'Row Labels')
        rows.append(r)

        # State breakdown rows under this SKU
        if sku in sku_st_piv.index.get_level_values(0):
            states_df = sku_st_piv.loc[sku]
            for state_name in states_df.index:
                if not state_name:
                    continue
                sr = {'Row Labels': state_name}
                for s in PIVOT_STATUS_COLUMNS:
                    sr[s] = int(states_df.at[state_name, s]) if s in states_df.columns else 0
                sr['Grand Total'] = sum(v for k, v in sr.items() if k != 'Row Labels')
                rows.append(sr)

    # Grand Total row
    gt = {'Row Labels': 'Grand Total'}
    for s in PIVOT_STATUS_COLUMNS:
        gt[s] = int(sku_piv[s].sum()) if s in sku_piv.columns else 0
    gt['Grand Total'] = sum(v for k, v in gt.items() if k != 'Row Labels')
    rows.append(gt)

    result = pd.DataFrame(rows)
    for col in PIVOT_STATUS_COLUMNS + ['Grand Total']:
        if col not in result.columns:
            result[col] = 0

    return result


# ─── FBA Inventory ─────────────────────────────────────────────
def fetch_fba_inventory():
    """Fetch current FBA inventory levels via Reports API."""
    print("  Requesting FBA inventory report ...")
    raw = _request_report('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA')
    print(f"    Downloaded {len(raw)} inventory rows")

    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]

    col_map = {
        'sku': ['sku', 'seller-sku'],
        'product_name': ['product-name'],
        'asin': ['asin'],
        'fba_available': ['afn-fulfillable-quantity'],
        'fba_inbound': ['afn-inbound-shipped-quantity'],
        'fba_reserved': ['afn-reserved-quantity'],
        'fba_total': ['afn-total-quantity'],
        'fba_unsellable': ['afn-unsellable-quantity'],
    }

    out = {}
    for target, sources in col_map.items():
        found = _find_col(raw, sources)
        if found:
            out[target] = raw[found]

    df = pd.DataFrame(out)
    for c in ['fba_available', 'fba_inbound', 'fba_reserved', 'fba_total', 'fba_unsellable']:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce').fillna(0).astype(int)

    return df


# ─── Connection test ───────────────────────────────────────────
def test_connection():
    """Verify SP-API credentials work."""
    print("\n  Testing SP-API connection ...")
    try:
        token = _get_access_token()
        print(f"    LWA auth OK (token length: {len(token)})")
    except Exception as e:
        print(f"\n  LWA auth FAILED: {e}")
        return False

    try:
        after = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        res = _sp_api_request('GET', '/orders/v0/orders', params={
            'CreatedAfter': after,
            'MarketplaceIds': MARKETPLACE_ID,
            'MaxResultsPerPage': '1',
        })
        orders = res.get('payload', {}).get('Orders', [])
        print(f"\n  Connection SUCCESSFUL!  ({len(orders)} order(s) in last 24 hours)")
        print("  You're ready. Run:")
        print("    python fulfillment_plan_generator.py --api")
        return True
    except Exception as e:
        print(f"\n  Orders API call FAILED: {e}")
        return False


# ─── CLI ───────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python amazon_api.py --setup   Configure credentials")
        print("  python amazon_api.py --test    Test API connection")
        print("  python amazon_api.py --fetch   Fetch data and save to Excel")
        sys.exit(0)

    cmd = sys.argv[1].lower()

    if cmd == '--setup':
        setup_credentials()
    elif cmd == '--test':
        test_connection()
    elif cmd == '--fetch':
        print("\nFetching order data ...")
        orders = fetch_orders_data()
        p1 = os.path.join(SCRIPT_DIR, 'api_orders_data.xlsx')
        orders.to_excel(p1, index=False)
        print(f"\n  Orders saved: {p1}")

        print("\nFetching FBA inventory ...")
        try:
            inv = fetch_fba_inventory()
            p2 = os.path.join(SCRIPT_DIR, 'api_fba_inventory.xlsx')
            inv.to_excel(p2, index=False)
            print(f"  Inventory saved: {p2}")
        except Exception as e:
            print(f"  Inventory fetch skipped: {e}")
    else:
        print(f"  Unknown command: {cmd}")
        sys.exit(1)
