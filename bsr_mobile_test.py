from playwright.sync_api import sync_playwright
import time, re
from bs4 import BeautifulSoup

MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)
p = b.new_page(user_agent=MOBILE_UA, viewport={"width": 412, "height": 915})

asin = "B0F8HF1BLP"
url = f"https://www.amazon.in/dp/{asin}"

print("Loading with mobile UA...")
p.goto(url, wait_until="domcontentloaded", timeout=30000)
time.sleep(3)
for pct in [0.3, 0.6, 1.0]:
    p.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
    time.sleep(1.5)

html = p.content()
with open("/tmp/bsr_mobile.html", "w", encoding="utf-8") as f:
    f.write(html)
print("Saved /tmp/bsr_mobile.html")

text = p.locator("body").inner_text(timeout=5000)

# Find BSR section
print("\n--- Looking for BSR in mobile page text ---")
# Search for #number in category patterns
for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n#(]{3,80})", text):
    rank = m.group(1).replace(",", "")
    cat = m.group(2).strip()
    cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
    cat = re.sub(r"\s+in\s+.*$", "", cat, flags=re.IGNORECASE).strip()
    print(f"  #{rank} in {cat}")

# Also check raw HTML
print("\n--- Raw HTML BSR patterns ---")
for m in re.finditer(r"#([\d,]+)\s+in\s+", html):
    start = max(0, m.start() - 30)
    end = min(len(html), m.end() + 100)
    print(f"  {html[start:end][:150]}")

# Check "Best Sellers Rank" area
idx = text.find("Best Sellers Rank")
if idx == -1:
    idx = text.lower().find("best seller")
if idx > -1:
    area = text[idx:idx+500]
    print(f"\n--- BSR area text ---\n{area}")

# Also try: networkidle + desktop UA
print("\n\n=== Trying desktop UA with networkidle ===")
p.close()
p = b.new_page(
    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
)
p.goto(url, wait_until="networkidle", timeout=60000)
time.sleep(3)
# Scroll aggressively
for pct in [0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0]:
    p.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
    time.sleep(0.8)
time.sleep(3)
html2 = p.content()
text2 = p.locator("body").inner_text(timeout=5000)
print(f"Desktop networkidle - 'Best Sellers Rank' in HTML: {'Best Sellers Rank' in html2}")
for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n#(]{3,80})", text2):
    print(f"  #{m.group(1)} in {m.group(2).strip()}")

p.close()
b.close()
pw.stop()
print("\nDone.")
