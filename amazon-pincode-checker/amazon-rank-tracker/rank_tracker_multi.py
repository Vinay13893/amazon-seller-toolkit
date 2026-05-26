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
SHEET_NAME = "MultiPairs"  # <-- multi mapping sheet: group | keyword | asins (comma separated)

LOG_DIR = "rank_logs_multi"
MASTER_CSV = "rank_master_multi.csv"

# Google Sheets sync
SYNC_TO_GSHEETS = True
GSHEETS_KEY_FILE = r"secret\gsheets-key.json"
GSHEETS_SPREADSHEET_ID = "PASTE_YOUR_SHEET_ID_HERE"
GSHEETS_WORKSHEET_NAME = "RawData_Multi"
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


def read_multipairs(excel_path: Path) -> pd.DataFrame:
    """
    MultiPairs sheet format:
      group | keyword | asins
    where asins is comma-separated list.
    """
    if not excel_path.exists():
        raise FileNotFoundError(f"Input Excel not found: {excel_path}")

    xls = pd.ExcelFile(excel_path)
    if SHEET_NAME not in xls.sheet_names:
        raise ValueError(
            f"Sheet '{SHEET_NAME}' not found in {INPUT_XLSX}. "
            f"Create it with columns: group, keyword, asins"
        )

    df = pd.read_excel(excel_path, sheet_name=SHEET_NAME)
    df.columns = [str(c).strip().lower() for c in df.columns]

    required = {"group", "keyword", "asins"}
    if not required.issubset(set(df.columns)):
        raise ValueError(f"'{SHEET_NAME}' must have headers: group, keyword, asins")

    df["group"] = df["group"].astype(str).str.strip()
    df["keyword"] = df["keyword"].astype(str).str.strip()
    df["asins"] = df["asins"].astype(str).str.strip()

    df = df[(df["group"] != "") & (df["keyword"] != "") & (df["asins"] != "")]
    df = df.drop_duplicates()

    if df.empty:
        raise ValueError(f"No valid rows found in '{SHEET_NAME}'.")

    return df


def extract_asins_from_html(html: str) -> set[str]:
    found = set()
    for m in re.finditer(r'data-asin="([A-Z0-9]{10})"', html, flags=re.I):
        found.add(m.group(1).upper())
    for m in re.finditer(r"/dp/([A-Z0-9]{10})", html, flags=re.I):
        found.add(m.group(1).upper())
    for m in re.finditer(r"/gp/product/([A-Z0-9]{10})", html, flags=re.I):
        found.add(m.group(1).upper())
    return found


def scan_keyword_for_asins(page, keyword: str, target_asins: list[str]) -> dict[str, int | None]:
    """
    Returns: asin -> first page found (1..SCAN_PAGES) or None
    """
    first_page_found = {a: None for a in target_asins}

    for pnum in range(1, SCAN_PAGES + 1):
        url = build_search_url(keyword, pnum)
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        time.sleep(SLEEP_BETWEEN_PAGES_SEC)

        html = page.content()
        present = extract_asins_from_html(html)

        for a in target_asins:
            if first_page_found[a] is None and a in present:
                first_page_found[a] = pnum

    return first_page_found


def write_outputs(base_dir: Path, df: pd.DataFrame):
    log_dir = base_dir / LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    daily_csv = log_dir / f"rank_multi_{datetime.now().strftime('%Y-%m-%d')}.csv"
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
        ws = sh.add_worksheet(title=GSHEETS_WORKSHEET_NAME, rows=10000, cols=30)

    existing = ws.get_all_values()
    if not existing:
        ws.append_row(list(df.columns))

    ws.append_rows(df.astype(str).values.tolist(), value_input_option="RAW")


def main():
    base_dir = Path(__file__).resolve().parent
    excel_path = base_dir / INPUT_XLSX

    cfg_df = read_multipairs(excel_path)

    run_date = today_str()
    tracked_at = now_str()

    print(f"[{tracked_at}] MULTI | Rows: {len(cfg_df)} | Pages: {SCAN_PAGES}")

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page()

        for _, row in cfg_df.iterrows():
            group = row["group"]
            keyword = row["keyword"]
            asins_raw = row["asins"]

            asins = [clean_asin(x) for x in asins_raw.split(",")]
            asins = [a for a in asins if a]

            if not asins:
                continue

            try:
                first_page_found = scan_keyword_for_asins(page, keyword, asins)
                scan_status = "ok"
            except Exception as e:
                first_page_found = {a: None for a in asins}
                scan_status = f"error: {type(e).__name__}"

            for asin in asins:
                pg = first_page_found.get(asin)
                results.append({
                    "run_date": run_date,
                    "tracked_at": tracked_at,
                    "marketplace": MARKETPLACE_DOMAIN,
                    "group": group,
                    "keyword": keyword,
                    "asin": asin,
                    "scan_status": scan_status,
                    "scanned_pages": SCAN_PAGES,
                    "found_any": bool(pg is not None),
                    "page_est": pg if pg is not None else ""
                })

        browser.close()

    out_cols = [
        "run_date", "tracked_at", "marketplace",
        "group", "keyword", "asin",
        "scan_status", "scanned_pages",
        "found_any", "page_est"
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
