"""
FBA Reconciliation — SP-API Client
====================================
Fetches all reports needed for FBA inventory reconciliation:
  1. Inventory Ledger          (every inventory event per ASIN)
  2. FBA Customer Returns      (returns with disposition)
  3. FBA Reimbursements        (reimbursed cash + units)
  4. FBA Inventory Snapshot    (current available/unfulfillable/reserved/inbound)
  5. Inbound Shipments         (sent vs received discrepancies via API)
"""

import gzip
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from io import StringIO
from urllib.parse import urlencode

import requests as req
import pandas as pd

# ─── Config ────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(
    os.path.dirname(SCRIPT_DIR),
    "category_analysis", "sp_api_config.json"
)

MARKETPLACE_ID = "A21TJRUUN4KGV"   # Amazon India
SP_API_HOST    = "sellingpartnerapi-eu.amazon.com"
SP_API_BASE    = f"https://{SP_API_HOST}"
SP_API_REGION  = "eu-west-1"

_cached_token      = None
_cached_token_time = None


# ─── Helpers ──────────────────────────────────────────────────
def _load_config():
    with open(CONFIG_FILE, "r") as f:
        return json.load(f)


def _sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signature_key(secret, date_stamp, region, service):
    kdate    = _sign(("AWS4" + secret).encode("utf-8"), date_stamp)
    kregion  = _sign(kdate,    region)
    kservice = _sign(kregion,  service)
    return   _sign(kservice, "aws4_request")


def _get_access_token():
    cfg = _load_config()
    r = req.post("https://api.amazon.com/auth/o2/token", data={
        "grant_type":    "refresh_token",
        "refresh_token": cfg["refresh_token"],
        "client_id":     cfg["lwa_app_id"],
        "client_secret": cfg["lwa_client_secret"],
    }, timeout=30)
    r.raise_for_status()
    d = r.json()
    if "access_token" not in d:
        raise RuntimeError(f"LWA auth failed: {d}")
    return d["access_token"]


def _token():
    global _cached_token, _cached_token_time
    now = datetime.now(timezone.utc)
    if _cached_token and _cached_token_time and (now - _cached_token_time).seconds < 3000:
        return _cached_token
    _cached_token      = _get_access_token()
    _cached_token_time = now
    return _cached_token


def _call(method, path, params=None, body=None):
    cfg   = _load_config()
    token = _token()
    now   = datetime.now(timezone.utc)

    amz_date   = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    canonical_uri         = path
    canonical_querystring = urlencode(sorted(params.items())) if params else ""
    payload               = json.dumps(body) if body else ""
    payload_hash          = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    h2sign = {
        "host":               SP_API_HOST,
        "x-amz-access-token": token,
        "x-amz-date":         amz_date,
    }
    signed_headers    = ";".join(sorted(h2sign.keys()))
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(h2sign.items()))

    canonical_request = "\n".join([
        method, canonical_uri, canonical_querystring,
        canonical_headers, signed_headers, payload_hash
    ])

    algorithm        = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{SP_API_REGION}/execute-api/aws4_request"
    string_to_sign   = "\n".join([
        algorithm, amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    ])

    sig_key   = _signature_key(cfg["aws_secret_key"], date_stamp, SP_API_REGION, "execute-api")
    signature = hmac.new(sig_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth = (
        f"{algorithm} Credential={cfg['aws_access_key']}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {
        "host":               SP_API_HOST,
        "x-amz-access-token": token,
        "x-amz-date":         amz_date,
        "Authorization":      auth,
        "Content-Type":       "application/json",
        "User-Agent":         "FBAReconciliation/1.0 (Language=Python)",
    }

    url = f"{SP_API_BASE}{path}"
    if canonical_querystring:
        url += f"?{canonical_querystring}"

    for attempt in range(3):
        if method == "GET":
            resp = req.get(url, headers=headers, timeout=60)
        else:
            resp = req.post(url, headers=headers, data=payload, timeout=60)

        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"      Rate limited — waiting {wait}s ...")
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            raise RuntimeError(f"SP-API {resp.status_code}: {resp.text[:600]}")
        return resp.json()

    raise RuntimeError("Max retries exceeded (rate limiting)")


# ─── Report Runner ─────────────────────────────────────────────
def _run_report(report_type, start_dt=None, end_dt=None, extra_body=None):
    """
    Submits a report request, polls until DONE, downloads and returns
    a pandas DataFrame. Handles TSV and GZIP automatically.
    """
    body = {
        "reportType":     report_type,
        "marketplaceIds": [MARKETPLACE_ID],
    }
    if start_dt:
        body["dataStartTime"] = start_dt.strftime("%Y-%m-%dT00:00:00Z")
    if end_dt:
        body["dataEndTime"]   = end_dt.strftime("%Y-%m-%dT23:59:59Z")
    if extra_body:
        body.update(extra_body)

    res = _call("POST", "/reports/2021-06-30/reports", body=body)
    report_id = res.get("reportId")
    if not report_id:
        raise RuntimeError(f"No reportId in response: {res}")
    print(f"      Submitted  reportId={report_id}")

    for attempt in range(40):
        time.sleep(30)
        status_res = _call("GET", f"/reports/2021-06-30/reports/{report_id}")
        status     = status_res.get("processingStatus", "UNKNOWN")
        print(f"      [{(attempt+1)*30}s] {status}")
        if status == "DONE":
            doc_id = status_res.get("reportDocumentId")
            break
        if status in ("CANCELLED", "FATAL"):
            raise RuntimeError(f"Report {report_type} failed ({status})")
    else:
        raise TimeoutError(f"Report {report_type} timed out after 20 min")

    doc = _call("GET", f"/reports/2021-06-30/documents/{doc_id}")
    dl  = req.get(doc["url"], timeout=120)
    dl.raise_for_status()

    data = dl.content
    if doc.get("compressionAlgorithm", "") == "GZIP":
        data = gzip.decompress(data)
    text = data.decode("utf-8-sig")
    df   = pd.read_csv(StringIO(text), sep="\t", dtype=str, low_memory=False)
    df.columns = [c.strip().lower().replace(" ", "-") for c in df.columns]
    return df


def _col(df, *candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


# ─── Public Fetch Functions ────────────────────────────────────

def fetch_inventory_ledger(start_dt, end_dt):
    """
    GET_LEDGER_DETAIL_VIEW_DATA — every inventory event per FNSKU.
    Columns returned: date, fnsku, asin, msku, title, event-type,
                      reference-id, quantity, fulfillment-center,
                      disposition, reason, reconciled, unreconciled
    """
    print(f"\n  [1/5] Inventory Ledger ({start_dt.date()} → {end_dt.date()}) ...")

    # Ledger supports max 31-day windows — chunk if needed
    chunks   = []
    cur_start = start_dt
    while cur_start <= end_dt:
        cur_end = min(cur_start + timedelta(days=30), end_dt)
        print(f"    Chunk: {cur_start.date()} → {cur_end.date()}")
        df = _run_report("GET_LEDGER_DETAIL_VIEW_DATA", cur_start, cur_end)
        chunks.append(df)
        cur_start = cur_end + timedelta(days=1)

    raw = pd.concat(chunks, ignore_index=True) if len(chunks) > 1 else chunks[0]
    print(f"    Total rows: {len(raw)}")

    # Normalise key columns
    qty_col  = _col(raw, "quantity", "qty")
    date_col = _col(raw, "date", "snapshot-date")
    asin_col = _col(raw, "asin")
    sku_col  = _col(raw, "msku", "sku", "seller-sku")
    evt_col  = _col(raw, "event-type", "event_type", "transaction-type")
    disp_col = _col(raw, "disposition", "fulfillment-channel-sku")
    fc_col   = _col(raw, "fulfillment-center", "fulfillment-center-id")
    title_col= _col(raw, "title", "product-name")
    ref_col  = _col(raw, "reference-id", "reference_id", "shipment-id")

    out = pd.DataFrame()
    out["date"]        = pd.to_datetime(raw[date_col],  errors="coerce") if date_col else pd.NaT
    out["asin"]        = raw[asin_col].str.strip()                        if asin_col else ""
    out["sku"]         = raw[sku_col].str.strip()                         if sku_col  else ""
    out["title"]       = raw[title_col].str.strip()                       if title_col else ""
    out["event_type"]  = raw[evt_col].str.strip()                         if evt_col  else ""
    out["disposition"] = raw[disp_col].str.strip()                        if disp_col else ""
    out["fc"]          = raw[fc_col].str.strip()                          if fc_col   else ""
    out["reference_id"]= raw[ref_col].str.strip()                         if ref_col  else ""
    out["quantity"]    = pd.to_numeric(raw[qty_col],    errors="coerce").fillna(0).astype(int) if qty_col else 0
    return out


def fetch_customer_returns(start_dt, end_dt):
    """
    GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA — every return with
    detailed-disposition (SELLABLE / CUSTOMER_DAMAGED / DEFECTIVE /
    WAREHOUSE_DAMAGED / CARRIER_DAMAGED / EXPIRED / UNSELLABLE).
    """
    print(f"\n  [2/5] Customer Returns ({start_dt.date()} → {end_dt.date()}) ...")
    raw = _run_report("GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", start_dt, end_dt)
    print(f"    Total rows: {len(raw)}")
    print(f"    Columns: {list(raw.columns)}")

    date_col  = _col(raw, "return-date", "return_date", "date")
    sku_col   = _col(raw, "sku", "seller-sku", "msku")
    asin_col  = _col(raw, "asin")
    qty_col   = _col(raw, "quantity", "qty")
    disp_col  = _col(raw, "detailed-disposition", "disposition", "status")
    reason_col= _col(raw, "reason", "return-reason")
    order_col = _col(raw, "order-id", "amazon-order-id")
    title_col = _col(raw, "product-name", "title")
    fc_col    = _col(raw, "fulfillment-center-id", "fulfillment-center")

    out = pd.DataFrame()
    out["date"]        = pd.to_datetime(raw[date_col],   errors="coerce") if date_col  else pd.NaT
    out["asin"]        = raw[asin_col].str.strip()                         if asin_col else ""
    out["sku"]         = raw[sku_col].str.strip()                          if sku_col  else ""
    out["title"]       = raw[title_col].str.strip()                        if title_col else ""
    out["order_id"]    = raw[order_col].str.strip()                        if order_col else ""
    out["disposition"] = raw[disp_col].str.strip().str.upper()             if disp_col else ""
    out["reason"]      = raw[reason_col].str.strip()                       if reason_col else ""
    out["fc"]          = raw[fc_col].str.strip()                           if fc_col   else ""
    out["quantity"]    = pd.to_numeric(raw[qty_col],     errors="coerce").fillna(1).astype(int) if qty_col else 1
    return out


def fetch_reimbursements(start_dt, end_dt):
    """
    GET_FBA_REIMBURSEMENTS_DATA — all reimbursements (cash + units) with reason codes.
    """
    print(f"\n  [3/5] Reimbursements ({start_dt.date()} → {end_dt.date()}) ...")
    raw = _run_report("GET_FBA_REIMBURSEMENTS_DATA", start_dt, end_dt)
    print(f"    Total rows: {len(raw)}")
    print(f"    Columns: {list(raw.columns)}")

    date_col   = _col(raw, "approval-date", "date", "transaction-date")
    reason_col = _col(raw, "reason")
    sku_col    = _col(raw, "sku", "seller-sku", "msku")
    asin_col   = _col(raw, "asin")
    title_col  = _col(raw, "product-name", "title")
    cash_col   = _col(raw, "amount-total", "amount-per-unit", "amount")
    cur_col    = _col(raw, "currency-unit", "currency")
    qty_cash   = _col(raw, "quantity-reimbursed-cash")
    qty_inv    = _col(raw, "quantity-reimbursed-inventory")
    qty_total  = _col(raw, "quantity-reimbursed-total")
    order_col  = _col(raw, "amazon-order-id", "order-id")

    out = pd.DataFrame()
    out["date"]           = pd.to_datetime(raw[date_col],  errors="coerce") if date_col  else pd.NaT
    out["asin"]           = raw[asin_col].str.strip()                        if asin_col else ""
    out["sku"]            = raw[sku_col].str.strip()                         if sku_col  else ""
    out["title"]          = raw[title_col].str.strip()                       if title_col else ""
    out["reason"]         = raw[reason_col].str.strip()                      if reason_col else ""
    out["order_id"]       = raw[order_col].str.strip()                       if order_col else ""
    out["amount"]         = pd.to_numeric(raw[cash_col],   errors="coerce").fillna(0) if cash_col else 0.0
    out["currency"]       = raw[cur_col].str.strip()                         if cur_col  else "INR"
    out["qty_cash"]       = pd.to_numeric(raw[qty_cash],   errors="coerce").fillna(0).astype(int) if qty_cash  else 0
    out["qty_inventory"]  = pd.to_numeric(raw[qty_inv],    errors="coerce").fillna(0).astype(int) if qty_inv   else 0
    out["qty_total"]      = pd.to_numeric(raw[qty_total],  errors="coerce").fillna(0).astype(int) if qty_total else 0
    return out


def fetch_inventory_snapshot():
    """
    FBA Inventory Summaries API (/fba/inventory/v1/summaries) — direct API call,
    returns current fulfillable, inbound, reserved, unfulfillable per SKU.
    More reliable than the report-based approach.
    """
    print("\n  [4/5] Inventory Snapshot (current) ...")
    rows       = []
    next_token = None
    page       = 0

    while True:
        page += 1
        params = {
            "details":         "true",
            "granularityType": "Marketplace",
            "granularityId":   MARKETPLACE_ID,
            "marketplaceIds":  MARKETPLACE_ID,
        }
        if next_token:
            params["nextToken"] = next_token

        res     = _call("GET", "/fba/inventory/v1/summaries", params=params)
        payload = res.get("payload", {})
        items   = payload.get("inventorySummaries", [])

        for item in items:
            det   = item.get("inventoryDetails") or {}
            res_q = det.get("reservedQuantity") or {}
            unf_q = det.get("unfulfillableQuantity") or {}
            rows.append({
                "sku":           item.get("sellerSku", ""),
                "asin":          item.get("asin", ""),
                "title":         item.get("productName", ""),
                "available":     int(det.get("fulfillableQuantity", 0) or 0),
                "inbound":       int(
                    (det.get("inboundShippedQuantity") or 0) +
                    (det.get("inboundReceivingQuantity") or 0) +
                    (det.get("inboundWorkingQuantity") or 0)
                ),
                "reserved":      int(res_q.get("totalReservedQuantity", 0) or 0),
                "total":         int(item.get("totalQuantity", 0) or 0),
                "unfulfillable": int(unf_q.get("totalUnfulfillableQuantity", 0) or 0),
            })

        next_token = res.get("pagination", {}).get("nextToken")
        print(f"    Page {page}: {len(items)} SKUs (running total: {len(rows)})")
        if not next_token or not items:
            break
        time.sleep(0.5)

    print(f"    Total SKUs: {len(rows)}")
    return pd.DataFrame(rows) if rows else pd.DataFrame()


def _call_list(method, path, param_pairs=None, body=None):
    """
    Like _call() but accepts param_pairs as a list of (key, value) tuples,
    allowing repeated keys (e.g. ShipmentStatusList=CLOSED&ShipmentStatusList=SHIPPED).
    """
    cfg   = _load_config()
    token = _token()
    now   = datetime.now(timezone.utc)

    amz_date   = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    canonical_uri         = path
    sorted_pairs          = sorted(param_pairs or [], key=lambda x: x[0])
    canonical_querystring = urlencode(sorted_pairs)
    payload               = json.dumps(body) if body else ""
    payload_hash          = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    h2sign = {
        "host":               SP_API_HOST,
        "x-amz-access-token": token,
        "x-amz-date":         amz_date,
    }
    signed_headers    = ";".join(sorted(h2sign.keys()))
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(h2sign.items()))

    canonical_request = "\n".join([
        method, canonical_uri, canonical_querystring,
        canonical_headers, signed_headers, payload_hash
    ])

    algorithm        = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{SP_API_REGION}/execute-api/aws4_request"
    string_to_sign   = "\n".join([
        algorithm, amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    ])

    sig_key   = _signature_key(cfg["aws_secret_key"], date_stamp, SP_API_REGION, "execute-api")
    signature = hmac.new(sig_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth = (
        f"{algorithm} Credential={cfg['aws_access_key']}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {
        "host":               SP_API_HOST,
        "x-amz-access-token": token,
        "x-amz-date":         amz_date,
        "Authorization":      auth,
        "Content-Type":       "application/json",
        "User-Agent":         "FBAReconciliation/1.0 (Language=Python)",
    }

    url = f"{SP_API_BASE}{path}"
    if canonical_querystring:
        url += f"?{canonical_querystring}"

    for attempt in range(3):
        if method == "GET":
            resp = req.get(url, headers=headers, timeout=60)
        else:
            resp = req.post(url, headers=headers, data=payload, timeout=60)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            raise RuntimeError(f"SP-API {resp.status_code}: {resp.text[:600]}")
        return resp.json()

    raise RuntimeError("Max retries exceeded")


def fetch_inbound_shipments():
    """
    FBA Inbound Shipments API — list of shipments with ShippedQuantity vs ReceivedQuantity
    so we can flag short-received shipments.
    """
    print("\n  [5/5] Inbound Shipments ...")
    shipments = []
    next_token = None
    page = 0

    while True:
        page += 1
        # SP-API v0 inbound: pass each status as a separate repeated query param.
        # urlencode a list of tuples preserves repeated keys correctly.
        if next_token:
            qpairs = [
                ("MarketplaceId", MARKETPLACE_ID),
                ("QueryType",     "SHIPMENT"),
                ("NextToken",     next_token),
            ]
        else:
            qpairs = [
                ("MarketplaceId",       MARKETPLACE_ID),
                ("QueryType",           "SHIPMENT"),
                ("ShipmentStatusList",  "CLOSED"),
                ("ShipmentStatusList",  "RECEIVING"),
                ("ShipmentStatusList",  "SHIPPED"),
            ]
        # Build signed URL manually so repeated params survive
        from urllib.parse import urlencode as _ue
        qs = _ue(sorted(qpairs, key=lambda x: (x[0], x[1])))
        cfg   = _load_config()
        token = _token()
        now   = datetime.now(timezone.utc)
        amz_date   = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        h2sign = {"host": SP_API_HOST, "x-amz-access-token": token, "x-amz-date": amz_date}
        signed_headers    = ";".join(sorted(h2sign.keys()))
        canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(h2sign.items()))
        payload_hash      = hashlib.sha256(b"").hexdigest()
        canon_req = "\n".join(["GET", "/fba/inbound/v0/shipments", qs,
                                canonical_headers, signed_headers, payload_hash])
        algorithm        = "AWS4-HMAC-SHA256"
        cred_scope       = f"{date_stamp}/{SP_API_REGION}/execute-api/aws4_request"
        s2s = "\n".join([algorithm, amz_date, cred_scope,
                         hashlib.sha256(canon_req.encode()).hexdigest()])
        sig_key   = _signature_key(cfg["aws_secret_key"], date_stamp, SP_API_REGION, "execute-api")
        signature = hmac.new(sig_key, s2s.encode(), hashlib.sha256).hexdigest()
        auth = (f"{algorithm} Credential={cfg['aws_access_key']}/{cred_scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}")
        hdrs = {"host": SP_API_HOST, "x-amz-access-token": token, "x-amz-date": amz_date,
                "Authorization": auth, "Content-Type": "application/json",
                "User-Agent": "FBAReconciliation/1.0 (Language=Python)"}
        try:
            resp = req.get(f"{SP_API_BASE}/fba/inbound/v0/shipments?{qs}", headers=hdrs, timeout=60)
            if resp.status_code >= 400:
                print(f"    Inbound API error {resp.status_code}: {resp.text[:300]}")
                print("    Skipping inbound discrepancy check — check Seller Central > Manage FBA Shipments manually.")
                return pd.DataFrame()
            res = resp.json()
        except Exception as e:
            print(f"    Inbound shipments API error: {e}")
            return pd.DataFrame()

        payload = res.get("payload", {})
        items   = payload.get("ShipmentData", [])
        for s in items:
            shipments.append({
                "shipment_id":     s.get("ShipmentId", ""),
                "shipment_name":   s.get("ShipmentName", ""),
                "status":          s.get("ShipmentStatus", ""),
                "destination_fc":  s.get("DestinationFulfillmentCenterId", ""),
            })

        next_token = payload.get("NextToken")
        if not next_token or not items:
            break
        time.sleep(1)

    if not shipments:
        print("    No shipments returned from API — will skip inbound analysis")
        return pd.DataFrame()

    print(f"    Found {len(shipments)} shipments — fetching item details ...")
    rows = []
    for s in shipments[:50]:  # limit to recent 50 to avoid rate limits
        sid = s["shipment_id"]
        try:
            time.sleep(0.5)
            items_res = _call("GET", f"/fba/inbound/v0/shipments/{sid}/items",
                              params={"MarketplaceId": MARKETPLACE_ID})
            for item in items_res.get("payload", {}).get("ItemData", []):
                rows.append({
                    "shipment_id":     sid,
                    "shipment_name":   s["shipment_name"],
                    "status":          s["status"],
                    "destination_fc":  s["destination_fc"],
                    "sku":             item.get("SellerSKU", ""),
                    "fnsku":           item.get("FulfillmentNetworkSKU", ""),
                    "qty_shipped":     item.get("QuantityShipped", 0),
                    "qty_received":    item.get("QuantityReceived", 0),
                    "qty_in_case":     item.get("QuantityInCase", 0),
                })
        except Exception as e:
            print(f"    Could not fetch items for {sid}: {e}")

    df = pd.DataFrame(rows)
    if not df.empty:
        df["qty_shipped"]  = pd.to_numeric(df["qty_shipped"],  errors="coerce").fillna(0).astype(int)
        df["qty_received"] = pd.to_numeric(df["qty_received"], errors="coerce").fillna(0).astype(int)
        df["discrepancy"]  = df["qty_received"] - df["qty_shipped"]
    print(f"    Total shipment line items: {len(df)}")
    return df
