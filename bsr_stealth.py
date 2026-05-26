from playwright.sync_api import sync_playwright
import time, re
from bs4 import BeautifulSoup

# Strategy: Use Playwright but with stealth techniques
# 1. First visit amazon.in homepage to get cookies
# 2. Then navigate to product page
# 3. Wait for specific BSR elements with retry

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(
    headless=True,
    args=[
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
    ]
)

ctx = b.new_context(
    user_agent=UA,
    viewport={'width': 1920, 'height': 1080},
    locale='en-IN',
    timezone_id='Asia/Kolkata',
    java_script_enabled=True,
)

# Remove webdriver flag
page = ctx.new_page()
page.add_init_script("""
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-IN', 'en-US', 'en']});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
""")

asin = "B0F8HF1BLP"

# Step 1: Visit homepage first to build session
print("Step 1: Visit amazon.in homepage...")
page.goto("https://www.amazon.in", wait_until="domcontentloaded", timeout=30000)
time.sleep(2)

# Step 2: Navigate to product
print(f"Step 2: Navigate to product {asin}...")
page.goto(f"https://www.amazon.in/dp/{asin}", wait_until="domcontentloaded", timeout=30000)
time.sleep(3)

# Step 3: Scroll slowly to trigger lazy loading
print("Step 3: Scrolling to trigger lazy load...")
height = page.evaluate("document.body.scrollHeight")
for y in range(0, height, 300):
    page.evaluate(f"window.scrollTo(0, {y})")
    time.sleep(0.15)
time.sleep(2)

# Scroll back up to product details area (usually around 60-70% down)
page.evaluate(f"window.scrollTo(0, {int(height * 0.6)})")
time.sleep(2)
page.evaluate(f"window.scrollTo(0, {int(height * 0.7)})")
time.sleep(2)

html = page.content()
print(f"Page size: {len(html)} bytes")

with open("/tmp/bsr_stealth.html", "w", encoding="utf-8") as f:
    f.write(html)

# Check for BSR
soup = BeautifulSoup(html, "lxml")
text = soup.get_text("\n", strip=True)

has_bsr = "Best Sellers Rank" in html
print(f"'Best Sellers Rank' in HTML: {has_bsr}")

if has_bsr:
    matches = re.findall(r"#([\d,]+)\s+in\s+([^\n#(]{3,80})", text)
    for rank, cat in matches:
        cat = re.sub(r"\s+See Top.*$", "", cat, flags=re.IGNORECASE).strip()
        print(f"  #{rank} in {cat}")
else:
    # Try waiting for specific element
    print("\nTrying to wait for product details element...")
    for sel in ["#detailBulletsWrapper_feature_div", "#prodDetails", "#productDetails_db_sections"]:
        try:
            page.wait_for_selector(sel, timeout=10000)
            el = page.locator(sel)
            if el.count() > 0:
                txt = el.inner_text(timeout=3000)
                print(f"  {sel} found: {txt[:200]}")
                break
        except:
            pass
    
    # Final check
    html = page.content()
    has_bsr = "Best Sellers Rank" in html
    print(f"\nFinal check - 'Best Sellers Rank' in HTML: {has_bsr}")
    
    if not has_bsr:
        # Check what sections ARE present
        print("\nSections found on page:")
        for sel in ["#productTitle", "#price", "#availability", "#merchant-info",
                     "#aplus", "#productDescription", "#feature-bullets",
                     "#detailBullets_feature_div", "#prodDetails",
                     "#productDetails_detailBullets_sections1",
                     "#reviews-medley-footer", "#ask-btf_feature_div"]:
            el = page.locator(sel)
            if el.count() > 0:
                print(f"  PRESENT: {sel}")
            else:
                print(f"  missing: {sel}")

page.close()
ctx.close()
b.close()
pw.stop()
print("\nDone.")
