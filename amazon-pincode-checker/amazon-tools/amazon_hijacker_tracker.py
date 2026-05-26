import os, re, csv, time
from datetime import datetime

import pandas as pd
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

INPUT_XLSX = "input.xlsx"
SHEET = "Input"
OUTDIR = "outputs"
OFFERS_CSV = os.path.join(OUTDIR, "offers_latest.csv")
ALERTS_CSV = os.path.join(OUTDIR, "alerts_latest.csv")

HEADLESS = False
MAX_OFFERS = 30

def ns(s): return " ".join((s or "").split()).strip()

def clean_seller(s):
    s = ns(s)
    s = re.split(r"\s+Seller rating\s+is\s+", s, flags=re.I)[0]
    s = re.split(r"\s+See\s+less\s*$", s, flags=re.I)[0]
    return s.strip(" -|").strip()

def price_num(p):
    if not p: return ""
    p = p.replace(",", "").replace("₹", "").replace("$", "").strip()
    try: return float(p)
    except: return ""

def rating_from_text(t):
    t = ns(t)
    rv = rm = rc = pp = rp = ""
    m = re.search(r"Seller rating is\s+(\d+(?:\.\d+)?)\s+out of\s+(\d+(?:\.\d+)?)\s+stars", t, re.I)
    if m: rv, rm = m.group(1), m.group(2)
    m = re.search(r"\(([\d,]+)\s+ratings\)", t, re.I)
    if m: rc = m.group(1).replace(",", "")
    m = re.search(r"(\d+)%\s+positive\s+over\s+(last\s+\d+\s+months|last\s+\d+\s+days|last\s+year)", t, re.I)
    if m: pp, rp = m.group(1), m.group(2)
    return rv, rm, rc, pp, rp

def dom(mp): return "www.amazon.com" if (mp or "IN").upper() == "US" else "www.amazon.in"
def url(asin, mp): return f"https://{dom(mp)}/gp/offer-listing/{asin}?condition=new"

def driver():
    o = Options()
    if HEADLESS: o.add_argument("--headless=new")
    o.add_argument("--start-maximized")
    o.add_argument("--lang=en-US")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--no-sandbox")
    o.add_argument("--disable-dev-shm-usage")
    return webdriver.Chrome(options=o)

def extract_offers(html):
    soup = BeautifulSoup(html, "lxml")

    # Only real offer blocks (no generic fallback!)
    blocks = soup.select("div#aod-offer, div.aod-offer")
    if not blocks:
        blocks = soup.select("div.olpOffer")

    offers = []
    seen = set()

    for b in blocks:
        t = ns(b.get_text(" ", strip=True))
        if not t: 
            continue

        # seller link (best)
        a = b.select_one("a[href*='/sp?seller='], a[href*='/gp/aag/main?seller='], a[href*='seller=']")
        seller = seller_id = ""
        if a:
            seller = clean_seller(a.get_text(strip=True))
            href = a.get("href", "") or ""
            m = re.search(r"(?:seller=)([A-Z0-9]{8,20})", href)
            if m: seller_id = m.group(1)

        # fallback: "Sold by XYZ"
        if not seller:
            m = re.search(r"Sold by\s+(.+?)(?:\s+and\s+Fulfilled|\s+Ships|\s*$)", t, re.I)
            if m: seller = clean_seller(m.group(1))

        # price
        p = b.select_one("span.a-price span.a-offscreen") or b.select_one("span.olpOfferPrice")
        price = ns(p.get_text(strip=True)) if p else ""
        if not price:
            m = re.search(r"(₹\s?[\d,]+(?:\.\d{1,2})?)", t)
            if m: price = m.group(1).replace(" ", "")

        # fulfillment heuristic
        fulf = "FBA" if re.search(r"Fulfilled by Amazon|Ships from Amazon|Dispatched from and sold by Amazon", t, re.I) else "FBM"

        rv, rm, rc, pp, rp = rating_from_text(t)

        key = (seller_id or seller or "", price, fulf)
        if key in seen:
            continue
        seen.add(key)

        # keep only meaningful rows
        if not (seller or price):
            continue

        offers.append({
            "seller_found": seller,
            "seller_id": seller_id,
            "price": price,
            "price_num": price_num(price),
            "fulfillment": fulf,
            "seller_rating_value": rv,
            "seller_rating_max": rm,
            "seller_rating_count": rc,
            "seller_positive_percent": pp,
            "seller_rating_period": rp,
        })

        if len(offers) >= MAX_OFFERS:
            break

    return offers

def read_inputs():
    df = pd.read_excel(INPUT_XLSX, sheet_name=SHEET)
    df.columns = [c.strip().lower() for c in df.columns]
    if "asin" not in df.columns or "authorized_seller" not in df.columns:
        raise ValueError("Input sheet must have: asin, authorized_seller (optional: marketplace)")
    if "marketplace" not in df.columns:
        df["marketplace"] = "IN"
    return df[["asin", "authorized_seller", "marketplace"]].dropna(subset=["asin"]).to_dict("records")

def main():
    os.makedirs(OUTDIR, exist_ok=True)
    scan_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    items = read_inputs()

    d = driver()
    rows, alerts = [], []

    fields = [
        "scan_time","asin","marketplace","authorized_seller",
        "seller_found","seller_id","price","price_num","fulfillment",
        "seller_rating_value","seller_rating_max","seller_rating_count",
        "seller_positive_percent","seller_rating_period","status"
    ]

    try:
        for it in items:
            asin = str(it["asin"]).strip()
            mp = str(it.get("marketplace","IN")).strip().upper()
            auth = clean_seller(str(it.get("authorized_seller","")))

            d.get(url(asin, mp))
            time.sleep(2.5)

            offers = extract_offers(d.page_source)

            if not offers:
                r = {k:"" for k in fields}
                r.update({"scan_time":scan_time,"asin":asin,"marketplace":mp,"authorized_seller":auth,"status":"PARSE_FAILED"})
                rows.append(r); alerts.append(r)
                continue

            found_lower = {o["seller_found"].lower() for o in offers if o["seller_found"]}
            you_present = bool(auth) and (auth.lower() in found_lower)

            for o in offers:
                seller = o["seller_found"]
                status = "OK"
                if auth and seller and seller.lower() != auth.lower():
                    status = "UNAUTHORIZED_SELLER"
                elif auth and not seller:
                    status = "UNKNOWN_SELLER"

                r = {
                    "scan_time":scan_time,"asin":asin,"marketplace":mp,"authorized_seller":auth,
                    "seller_found":seller,"seller_id":o["seller_id"],
                    "price":o["price"],"price_num":o["price_num"],"fulfillment":o["fulfillment"],
                    "seller_rating_value":o["seller_rating_value"],"seller_rating_max":o["seller_rating_max"],
                    "seller_rating_count":o["seller_rating_count"],"seller_positive_percent":o["seller_positive_percent"],
                    "seller_rating_period":o["seller_rating_period"],"status":status
                }
                rows.append(r)
                if status in ("UNAUTHORIZED_SELLER","UNKNOWN_SELLER"):
                    alerts.append(r)

            if auth and not you_present:
                r = {k:"" for k in fields}
                r.update({"scan_time":scan_time,"asin":asin,"marketplace":mp,"authorized_seller":auth,"status":"YOU_NOT_PRESENT"})
                rows.append(r); alerts.append(r)

            time.sleep(1)

    finally:
        d.quit()

    with open(OFFERS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    with open(ALERTS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(alerts)

    print("DONE")
    print("Offers:", OFFERS_CSV)
    print("Alerts:", ALERTS_CSV)

if __name__ == "__main__":
    main()
