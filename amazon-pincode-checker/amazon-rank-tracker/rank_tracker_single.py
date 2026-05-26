import re
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import gspread
from playwright.sync_api import sync_playwright


# =========================
# SETTINGS
# =========================
MARKETPLACE_DOMAIN = "www.amazon.in"
SCAN_PAGES = 7
HEADLESS = True
SLEEP_BETWEEN_PAGES_SEC = 1.2

INPUT_XLSX = "rank_input.xlsx"
SHEET_NAME = "Pairs"  # <-- single mapping sheet: keyword | asin

LOG_DIR = "rank_logs_single"
MASTER_CSV = "rank_master_single.csv"

# Google Sheets sync
SYNC_TO_GSHEETS = True
GSHEETS_KEY_FILE = r"secret\gsheets-key.json"
GSHEETS_SPREADSHEET_ID = "PASTE_YOUR_SHEET_ID_HERE"
GSHEETS_WORKSHEET_NAME = "RawData_Single"
# =========================


def now_str():
    return datetime.now().strftime("%d-%m-%Y %H:%M:%S")


def today_str():
    return datetime.now().strftime("%d-%m-%Y")


def clean_asin(x: str) -> str:
    x = str(x).strip().upper()
    x = re.sub(r"[^A-Z0-9]", "", x)
    return x


def build_search_url(keyword: str, page_num: int) -> str:
    from urllib.parse import quote_plus
    q = quote_plus(keyword.strip())
    if page_num <= 1:
        return f"https://{MARKETPLACE_DOMAIN}/s?k={q}"
    return f"https://{MARKETPLACE_DOMAIN}/s?k={q}&page={page_num}"


def read_pairs(excel_path: Path) -> pd.DataFrame:
    if not excel_path.exists():
        raise FileNotFoundError(f"Input Excel not found: {excel_path}")

    xls = pd.ExcelFile(excel_path)
    if SHEET_NAME not in xls.sheet_names:
        raise ValueError(
            f"Sheet '{SHEET_NAME}' not found in {INPUT_XLSX}. "
            f"Create it with columns: keyword, asin"
        )

    df = pd.read_excel(excel_path, sheet_name=SHEET_NAME)
    df.columns = [str(c).strip().lower() for c in df.columns]

    if "keyword" not in df.columns or "asin" not in df.columns:
        raise ValueError(f"'{SHEET_NAME}' must have headers: keyword, asin")

    df["keyword"] = df["keyword"].astype(str).str.strip()
    df["asin"] = df["asin"].apply(clean_asin)

    df = df[(df["keyword"] != "") & (df["asin"] != "")]
    df = df.drop_duplicates()

    if df.empty:
        raise ValueError(f"No valid rows found in '{SHEET_NAME}'.")

    return df


def extract_asins_from_html(html: str) -> list[str]:
    """
    Extract ASINs from the page and preserve approximate order by scanning data-asin blocks.
    This is not perfect ranking, but better than a pure set membership check.
    """
    asins = []
    for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
        a = m.group(1).upper()
        if a and a not in asins:
            asins.append(a)
    return asins


def detect_sponsored_near_asin(html: str, asin: str) -> bool:
    """
    Best-effort: checks if "Sponsored" appears near the ASIN block.
    Not perfect, but useful.
    """
    asin = asin.upper()
    idx = html.upper().find(f'DATA-ASIN="{asin}"')
    if idx == -1:
        return False
    window = html[max(0, idx - 2000): idx + 4000].lower()
    return "sponsored" in window


def track_single_pair(page, keyword: str, asin: str) -> dict:
    """
    Finds:
    - first page where ASIN appears
    - approximate position on that page (1..N in extracted list)
    - sponsored flag best-effort
    """
    scan_status = "ok"
    scanned_pages = 0

    found_any = False
    page_est = ""
    pos_on_page = ""
    is_sponsored = False

    for pnum in range(1, SCAN_PAGES + 1):
        scanned_pages += 1
        url = build_search_url(keyword, pnum)

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(SLEEP_BETWEEN_PAGES_SEC)
            html = page.content()

            asins_in_order = extract_asins_from_html(html)
            if asin in asins_in_order:
                found_any = True
                page_est = pnum
                pos_on_page = asins_in_order.index(asin) + 1
                is_sponsored = detect_sponsored_near_asin(html, asin)
                break

        except Exception as e:
            scan_status = f"error: {type(e).__name__}"

    return {
        "keyword": keyword,
        "asin": asin,
        "scan_status": scan_status,
        "scanned_pages": scanned_pages,
        "found_any": bool(found_any),
        "page_est": page_est,
        "pos_on_page": pos_on_page,
        "is_sponsored": bool(is_sponsored),
    }


def write_outputs(base_dir: Path, df: pd.DataFrame):
    log_dir = base_dir / LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    daily_csv = log_dir / f"rank_single_{datetime.now().strftime('%Y-%m-%d')}.csv"
    master_csv = base_dir / MASTER_CSV

    df.to_csv(daily_csv, index=False, encoding="utf-8-sig")

    if master_csv.exists():
        df.to_csv(master_csv, mode="a", header=False, index=False, encoding="utf-8-sig")
    else:
        df.to_csv(master_csv, index=False, encoding="utf-8-sig")

    return daily_csv, master_csv


def sync_to_gsheets(base_dir: Path, df: pd.DataFrame):
    if not SYNC_TO_GSHEETS:
        return

    key_path = (base_dir / GSHEETS_KEY_FILE).resolve()
    if not key_path.exists():
        raise FileNotFoundError(f"service account key not found: {key_path}")

    if GSHEETS_SPREADSHEET_ID.strip() == "PASTE_YOUR_SHEET_ID_HERE":
        raise ValueError("Paste your Google Sheet ID into GSHEETS_SPREADSHEET_ID.")

    gc = gspread.service_account(filename=str(key_path))
    sh = gc.open_by_key(GSHEETS_SPREADSHEET_ID)

    try:
        ws = sh.worksheet(GSHEETS_WORKSHEET_NAME)
    except Exception:
        ws = sh.add_worksheet(title=GSHEETS_WORKSHEET_NAME, rows=5000, cols=30)

    existing = ws.get_all_values()
    if not existing:
        ws.append_row(list(df.columns))

    ws.append_rows(df.astype(str).values.tolist(), value_input_option="RAW")


def main():
    base_dir = Path(__file__).resolve().parent
    excel_path = base_dir / INPUT_XLSX

    pairs_df = read_pairs(excel_path)

    run_date = today_str()
    tracked_at = now_str()

    print(f"[{tracked_at}] SINGLE | Rows: {len(pairs_df)} | Pages: {SCAN_PAGES}")

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page()

        for _, row in pairs_df.iterrows():
            kw = row["keyword"]
            asin = row["asin"]
            r = track_single_pair(page, kw, asin)
            r["run_date"] = run_date
            r["tracked_at"] = tracked_at
            r["marketplace"] = MARKETPLACE_DOMAIN
            results.append(r)

        browser.close()

    out_cols = [
        "run_date", "tracked_at", "marketplace",
        "keyword", "asin",
        "scan_status", "scanned_pages",
        "found_any", "page_est", "pos_on_page",
        "is_sponsored"
    ]
    out_df = pd.DataFrame(results)[out_cols]

    daily_csv, master_csv = write_outputs(base_dir, out_df)
    print(f"Done. Daily CSV: {daily_csv} | Master CSV: {master_csv}")

    try:
        print(f"GSHEETS: Using key: {(base_dir / GSHEETS_KEY_FILE).resolve()}")
        sync_to_gsheets(base_dir, out_df)
        print("GSHEETS: synced OK ✅")
    except Exception as e:
        print("GSHEETS: Sync failed (but CSV saved OK).")
        print(f"Reason: {repr(e)}")


if __name__ == "__main__":
    main()
