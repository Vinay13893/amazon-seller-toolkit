"""
SP-API Client for Category Analysis
=====================================
Adapted from e:\\Emount\\Stock Reports\\Claude\\Store Replenish Auto\\amazon_api.py
Fetches:
  1. Order data (last N days) — for total/organic sales per SKU
  2. FBA inventory — for stock health analysis
"""

import json
import os
import time
import hashlib
import hmac
import gzip
from datetime import datetime, timedelta, timezone
from io import StringIO
from urllib.parse import urlencode

import requests as req
import pandas as pd

# ─── Constants ─────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, "sp_api_config.json")

MARKETPLACE_ID = "A21TJRUUN4KGV"          # Amazon India
SP_API_HOST = "sellingpartnerapi-eu.amazon.com"
SP_API_BASE = f"https://{SP_API_HOST}"
SP_API_REGION = "eu-west-1"


# ─── Config ────────────────────────────────────────────────────
def load_config():
    with open(CONFIG_FILE, 'r') as f:
        config = json.load(f)
    required = ['lwa_app_id', 'lwa_client_secret', 'refresh_token',
                'aws_access_key', 'aws_secret_key']
    missing = [k for k in required if not config.get(k)]
    if missing:
        raise ValueError(f"Missing SP-API credentials: {', '.join(missing)}")
    return config


# ─── AWS Signature V4 ─────────────────────────────────────────
def _sign(key, msg):
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()


def _get_signature_key(secret, date_stamp, region, service):
    k_date = _sign(('AWS4' + secret).encode('utf-8'), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, 'aws4_request')


# ─── Auth ──────────────────────────────────────────────────────
_cached_token = None
_cached_token_time = None


def _get_access_token(config=None):
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


def _get_token():
    global _cached_token, _cached_token_time
    now = datetime.now(timezone.utc)
    if _cached_token and _cached_token_time and (now - _cached_token_time).seconds < 3000:
        return _cached_token
    _cached_token = _get_access_token()
    _cached_token_time = now
    return _cached_token


# ─── Signed Request ───────────────────────────────────────────
def _sp_api_request(method, path, params=None, body=None):
    config = load_config()
    access_token = _get_token()

    now = datetime.now(timezone.utc)
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    date_stamp = now.strftime('%Y%m%d')

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

    algorithm = 'AWS4-HMAC-SHA256'
    credential_scope = f'{date_stamp}/{SP_API_REGION}/execute-api/aws4_request'
    string_to_sign = '\n'.join([
        algorithm, amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()
    ])

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
        'User-Agent': 'CategoryAnalysis/1.0 (Language=Python)',
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

    if resp.status_code == 429:
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
    print(f"    Report ID: {report_id}  — waiting for Amazon ...")

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

    doc_res = _sp_api_request('GET', f'/reports/2021-06-30/documents/{doc_id}')
    url = doc_res.get('url')
    if not url:
        raise ValueError(f"No download URL: {doc_res}")

    dl = req.get(url, timeout=120)
    dl.raise_for_status()
    data = dl.content
    if doc_res.get('compressionAlgorithm', '') == 'GZIP':
        data = gzip.decompress(data)
    text = data.decode('utf-8-sig')
    return pd.read_csv(StringIO(text), sep='\t', dtype=str)


def _find_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


# ─── Public Functions ──────────────────────────────────────────
def fetch_orders_data(days=30):
    """Fetch last N days of order data. Returns DataFrame with columns:
    sku, asin, quantity, item_price, item_status, order_date
    """
    print(f"\n  Fetching order data (last {days} days) ...")
    # Use a full-day window ending yesterday to avoid partial intraday data.
    today_utc = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end_dt = today_utc - timedelta(seconds=1)
    start_dt = (end_dt - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

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
    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]
    print(f"    Total: {len(raw)} order rows across {chunk_num} chunk(s)")
    print(f"    Columns: {list(raw.columns)}")

    # Normalize columns
    sku_col = _find_col(raw, ['sku', 'seller-sku', 'merchant-sku'])
    asin_col = _find_col(raw, ['asin'])
    qty_col = _find_col(raw, ['quantity', 'quantity-purchased', 'qty'])
    price_col = _find_col(raw, ['item-price', 'item-total'])
    status_col = _find_col(raw, ['item-status', 'order-status', 'order-item-status'])
    date_col = _find_col(raw, ['purchase-date', 'order-date', 'last-updated-date'])

    result = pd.DataFrame()
    if sku_col:
        result['sku'] = raw[sku_col].fillna('').str.strip()
    if asin_col:
        result['asin'] = raw[asin_col].fillna('').str.strip()
    if qty_col:
        result['quantity'] = pd.to_numeric(raw[qty_col], errors='coerce').fillna(1).astype(int)
    else:
        result['quantity'] = 1
    if price_col:
        result['item_price'] = pd.to_numeric(raw[price_col], errors='coerce').fillna(0)
    else:
        result['item_price'] = 0
    if status_col:
        result['item_status'] = raw[status_col].fillna('Unknown').str.strip()
    if date_col:
        result['order_date'] = raw[date_col]

    return result


def fetch_fba_inventory():
    """Fetch current FBA inventory. Returns DataFrame with columns:
    sku, asin, product_name, fba_available, fba_inbound, fba_reserved, fba_total, fba_unsellable
    """
    print("\n  Fetching FBA inventory ...")
    raw = _request_report('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA')
    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]
    print(f"    Downloaded {len(raw)} inventory rows")
    print(f"    Columns: {list(raw.columns)}")

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


def test_connection():
    """Quick test of SP-API credentials."""
    print("  Testing SP-API connection ...")
    try:
        token = _get_access_token()
        print(f"    LWA auth OK (token length: {len(token)})")
        return True
    except Exception as e:
        print(f"    LWA auth FAILED: {e}")
        return False


if __name__ == '__main__':
    if test_connection():
        print("\n  SP-API credentials verified!")
    else:
        print("\n  SP-API connection failed.")
