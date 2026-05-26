"""
SP-API Data Fetcher — Orders + FBA Inventory
==============================================
Reuses the existing SP-API auth from category_analysis/sp_api_client.py.
Only fetches data we don't already have (incremental).
"""

import os
import sys
import json
import time
import hashlib
import hmac
import gzip
import pandas as pd
from datetime import datetime, timedelta, timezone
from io import StringIO
from urllib.parse import urlencode

import requests as req

# ─── Constants ─────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)

# Look for SP-API config in category_analysis first, then Store Replenish Auto
CONFIG_PATHS = [
    os.path.join(PARENT_DIR, "category_analysis", "sp_api_config.json"),
    os.path.join(PARENT_DIR, "Store Replenish Auto", "sp_api_config.json"),
]

MARKETPLACE_ID = "A21TJRUUN4KGV"  # Amazon India
SP_API_HOST = "sellingpartnerapi-eu.amazon.com"
SP_API_BASE = f"https://{SP_API_HOST}"
SP_API_REGION = "eu-west-1"


# ─── Config ────────────────────────────────────────────────────
def _load_config():
    for path in CONFIG_PATHS:
        if os.path.exists(path):
            with open(path, 'r') as f:
                config = json.load(f)
            required = ['lwa_app_id', 'lwa_client_secret', 'refresh_token',
                        'aws_access_key', 'aws_secret_key']
            missing = [k for k in required if not config.get(k)]
            if not missing:
                return config
    raise FileNotFoundError(
        f"SP-API config not found. Checked: {CONFIG_PATHS}"
    )


# ─── AWS Signature V4 ─────────────────────────────────────────
def _sign(key, msg):
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()


def _get_signature_key(secret, date_stamp, region, service):
    k_date = _sign(('AWS4' + secret).encode('utf-8'), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, 'aws4_request')


# ─── Token Cache ───────────────────────────────────────────────
_cached_token = None
_cached_token_time = None


def _get_token(config=None):
    global _cached_token, _cached_token_time
    now = datetime.now(timezone.utc)
    if _cached_token and _cached_token_time and (now - _cached_token_time).seconds < 3000:
        return _cached_token

    c = config or _load_config()
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
    _cached_token = data['access_token']
    _cached_token_time = now
    return _cached_token


# ─── Signed Request ───────────────────────────────────────────
def _sp_api_request(method, path, params=None, body=None, _retry=0):
    config = _load_config()
    access_token = _get_token(config)

    now = datetime.now(timezone.utc)
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    date_stamp = now.strftime('%Y%m%d')

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
        method, path, canonical_querystring,
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
        'User-Agent': 'DailyDashboard/1.0 (Language=Python)',
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

    if resp.status_code == 429 and _retry < 5:
        wait = min(60, 2 ** (_retry + 1))
        print(f"    Rate limited — waiting {wait}s (retry {_retry + 1})...")
        time.sleep(wait)
        return _sp_api_request(method, path, params, body, _retry + 1)

    if resp.status_code >= 400:
        raise RuntimeError(f"SP-API {resp.status_code}: {resp.text[:500]}")

    return resp.json()


# ─── Reports API ───────────────────────────────────────────────
def _request_report(report_type, start_date=None, end_date=None, report_options=None):
    """Request, poll, and download a report. Returns DataFrame."""
    body = {
        'reportType': report_type,
        'marketplaceIds': [MARKETPLACE_ID],
    }
    if start_date:
        body['dataStartTime'] = start_date.strftime('%Y-%m-%dT00:00:00Z')
    if end_date:
        body['dataEndTime'] = end_date.strftime('%Y-%m-%dT23:59:59Z')
    if report_options:
        body['reportOptions'] = report_options

    print(f"    Requesting report: {report_type}")
    res = _sp_api_request('POST', '/reports/2021-06-30/reports', body=body)
    report_id = res.get('reportId')
    if not report_id:
        raise RuntimeError(f"No reportId: {res}")
    print(f"    Report ID: {report_id} — polling...")

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
            raise RuntimeError(f"Report failed: {status}")
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


# ─── Public: Fetch Orders (incremental) ───────────────────────
def fetch_orders(start_date, end_date):
    """Fetch order data between start_date and end_date (date objects).
    Returns normalized DataFrame with: sku, asin, quantity, item_price, item_status, order_date
    """
    start_dt = datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc)
    end_dt = datetime.combine(end_date, datetime.max.time(), tzinfo=timezone.utc)

    print(f"\n  [SP-API] Fetching orders: {start_date} → {end_date}")

    # Chunk into 30-day windows (SP-API limit)
    MAX_CHUNK = 30
    chunks = []
    chunk_start = start_dt
    chunk_num = 0

    while chunk_start <= end_dt:
        chunk_end = min(chunk_start + timedelta(days=MAX_CHUNK - 1), end_dt)
        chunk_num += 1
        print(f"    Chunk {chunk_num}: {chunk_start.strftime('%Y-%m-%d')} → {chunk_end.strftime('%Y-%m-%d')}")

        raw = _request_report(
            'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
            chunk_start, chunk_end,
        )
        print(f"      → {len(raw)} rows")
        chunks.append(raw)
        chunk_start = chunk_end + timedelta(days=1)

    if not chunks:
        return pd.DataFrame()

    raw = pd.concat(chunks, ignore_index=True)
    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]

    # Find columns dynamically
    def _find(candidates):
        for c in candidates:
            if c in raw.columns:
                return c
        return None

    sku_col = _find(['sku', 'seller-sku', 'merchant-sku'])
    asin_col = _find(['asin'])
    qty_col = _find(['quantity', 'quantity-purchased', 'qty'])
    price_col = _find(['item-price', 'item-total'])
    status_col = _find(['item-status', 'order-status', 'order-item-status'])
    date_col = _find(['purchase-date', 'order-date', 'last-updated-date'])

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

    print(f"  [SP-API] Orders fetched: {len(result)} rows")
    return result


# ─── Public: Fetch FBA Inventory (full snapshot) ──────────────
def fetch_fba_inventory():
    """Fetch current FBA inventory. Returns DataFrame."""
    print(f"\n  [SP-API] Fetching FBA inventory snapshot...")

    raw = _request_report('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA')
    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]
    print(f"  [SP-API] Inventory: {len(raw)} SKUs")

    def _find(candidates):
        for c in candidates:
            if c in raw.columns:
                return c
        return None

    result = pd.DataFrame()
    sku_col = _find(['sku', 'seller-sku', 'merchant-sku'])
    asin_col = _find(['asin', 'fnsku'])
    name_col = _find(['product-name', 'product_name', 'title'])
    avail_col = _find(['afn-fulfillable-quantity', 'available', 'sellable'])
    inbound_col = _find(['afn-inbound-working-quantity', 'inbound-working'])
    inbound_ship_col = _find(['afn-inbound-shipped-quantity', 'inbound-shipped'])
    reserved_col = _find(['afn-reserved-quantity', 'reserved'])
    unsellable_col = _find(['afn-unsellable-quantity', 'unsellable'])

    if sku_col:
        result['sku'] = raw[sku_col].fillna('').str.strip()
    if asin_col:
        result['asin'] = raw[asin_col].fillna('').str.strip()
    if name_col:
        result['product_name'] = raw[name_col].fillna('').str.strip()
    if avail_col:
        result['fba_available'] = pd.to_numeric(raw[avail_col], errors='coerce').fillna(0).astype(int)
    if inbound_col:
        result['fba_inbound_working'] = pd.to_numeric(raw[inbound_col], errors='coerce').fillna(0).astype(int)
    if inbound_ship_col:
        result['fba_inbound_shipped'] = pd.to_numeric(raw[inbound_ship_col], errors='coerce').fillna(0).astype(int)
    if reserved_col:
        result['fba_reserved'] = pd.to_numeric(raw[reserved_col], errors='coerce').fillna(0).astype(int)
    if unsellable_col:
        result['fba_unsellable'] = pd.to_numeric(raw[unsellable_col], errors='coerce').fillna(0).astype(int)

    # Calculate total
    for col in ['fba_available', 'fba_inbound_working', 'fba_inbound_shipped', 'fba_reserved']:
        if col not in result.columns:
            result[col] = 0
    result['fba_total'] = result['fba_available'] + result['fba_inbound_working'] + result['fba_inbound_shipped'] + result['fba_reserved']

    result['snapshot_date'] = datetime.now().strftime('%Y-%m-%d')
    return result


# ─── Seller Flex FC Codes ──────────────────────────────────────
SELLER_FLEX_FCS = {'TPKR', 'XHZU', 'XHZV', 'XHZR'}


# ─── Public: Fetch Inventory by Fulfillment Center ────────────
def fetch_inventory_by_fc():
    """Fetch per-FC inventory using Inventory Ledger Summary.
    Returns (snapshot_df, ledger_df):
      snapshot_df: latest balance per SKU/FC (same as before)
      ledger_df: full daily movements per SKU/FC with all columns
    """
    end_date = datetime.now(timezone.utc) - timedelta(days=1)
    start_date = end_date - timedelta(days=29)

    print(f"\n  [SP-API] Fetching inventory ledger by FC: {start_date.strftime('%Y-%m-%d')} → {end_date.strftime('%Y-%m-%d')}")

    try:
        raw = _request_report(
            'GET_LEDGER_SUMMARY_VIEW_DATA',
            start_date=start_date,
            end_date=end_date,
            report_options={
                'aggregateByLocation': 'FC',
                'aggregatedByTimePeriod': 'DAILY',
            },
        )
    except Exception as e:
        print(f"  ⚠️ Ledger report failed: {e}")
        return pd.DataFrame(), pd.DataFrame()

    raw.columns = [c.strip().lower().replace(' ', '-') for c in raw.columns]
    print(f"  [SP-API] Ledger: {len(raw)} rows, columns: {list(raw.columns)}")

    def _find(candidates):
        for c in candidates:
            if c in raw.columns:
                return c
        return None

    date_col = _find(['date'])
    balance_col = _find(['ending-warehouse-balance', 'ending_warehouse_balance'])
    start_balance_col = _find(['starting-warehouse-balance', 'starting_warehouse_balance'])
    location_col = _find(['location', 'fulfillment-center', 'fulfillment-center-id'])
    disp_col = _find(['disposition'])
    sku_col = _find(['msku', 'sku', 'seller-sku'])
    asin_col = _find(['asin'])
    title_col = _find(['title', 'product-name'])
    receipts_col = _find(['receipts'])
    shipments_col = _find(['customer-shipments'])
    returns_col = _find(['customer-returns'])
    transfer_col = _find(['warehouse-transfer-in/out'])

    if not balance_col or not location_col:
        print(f"  ⚠️ Ledger report missing expected columns (balance={balance_col}, location={location_col})")
        print(f"    Available: {list(raw.columns)}")
        return pd.DataFrame(), pd.DataFrame()

    # Parse dates
    if date_col:
        raw[date_col] = pd.to_datetime(raw[date_col], errors='coerce')

    # Filter SELLABLE only
    if disp_col:
        raw = raw[raw[disp_col].str.upper().str.strip() == 'SELLABLE']

    if raw.empty:
        print("  ⚠️ No SELLABLE inventory rows found in ledger")
        return pd.DataFrame(), pd.DataFrame()

    # ── Build full ledger DataFrame (all dates) ──
    ledger = pd.DataFrame()
    if date_col:
        ledger['date'] = raw[date_col].dt.strftime('%Y-%m-%d').values
    if sku_col:
        ledger['sku'] = raw[sku_col].fillna('').str.strip().values
    if asin_col:
        ledger['asin'] = raw[asin_col].fillna('').str.strip().values
    if title_col:
        ledger['product_name'] = raw[title_col].fillna('').str.strip().values
    ledger['fc_code'] = raw[location_col].fillna('').str.strip().values
    ledger['fc_type'] = ledger['fc_code'].apply(lambda x: 'seller_flex' if x.upper() in SELLER_FLEX_FCS else 'amazon_fba')

    for col_name, src_col in [
        ('starting_balance', start_balance_col),
        ('receipts', receipts_col),
        ('customer_shipments', shipments_col),
        ('customer_returns', returns_col),
        ('transfers', transfer_col),
        ('ending_balance', balance_col),
    ]:
        if src_col:
            ledger[col_name] = pd.to_numeric(raw[src_col], errors='coerce').fillna(0).astype(int).values
        else:
            ledger[col_name] = 0

    print(f"  [SP-API] Full ledger: {len(ledger)} rows across {ledger['date'].nunique() if 'date' in ledger.columns else '?'} days")

    # ── Build snapshot (latest date only) ──
    if date_col:
        latest_date = raw[date_col].max()
        recent = raw[raw[date_col] == latest_date].copy()
        print(f"  [SP-API] Snapshot date: {latest_date.strftime('%Y-%m-%d')}")
    else:
        recent = raw.copy()

    snapshot = pd.DataFrame()
    if sku_col:
        snapshot['sku'] = recent[sku_col].fillna('').str.strip().values
    if asin_col:
        snapshot['asin'] = recent[asin_col].fillna('').str.strip().values
    if title_col:
        snapshot['product_name'] = recent[title_col].fillna('').str.strip().values
    snapshot['fc_code'] = recent[location_col].fillna('').str.strip().values
    snapshot['quantity'] = pd.to_numeric(recent[balance_col], errors='coerce').fillna(0).astype(int).values
    snapshot['fc_type'] = snapshot['fc_code'].apply(lambda x: 'seller_flex' if x.upper() in SELLER_FLEX_FCS else 'amazon_fba')
    snapshot['snapshot_date'] = datetime.now().strftime('%Y-%m-%d')

    sf_total = snapshot[snapshot['fc_type'] == 'seller_flex']['quantity'].sum()
    fba_total = snapshot[snapshot['fc_type'] == 'amazon_fba']['quantity'].sum()
    print(f"  [SP-API] Snapshot: {len(snapshot)} rows — Seller Flex: {sf_total} units, Amazon FBA: {fba_total} units")

    return snapshot, ledger


# ─── Quick Test ────────────────────────────────────────────────
if __name__ == '__main__':
    print("Testing SP-API connection...")
    try:
        config = _load_config()
        token = _get_token(config)
        print(f"  LWA Token obtained: {token[:20]}...")
        print("  SP-API connection OK!")
    except Exception as e:
        print(f"  ERROR: {e}")
