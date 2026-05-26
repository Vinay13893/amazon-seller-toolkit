from playwright.sync_api import sync_playwright
import time, re

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)
p = b.new_page(user_agent=UA)

asin = "B0F8HF1BLP"
url = f"https://www.amazon.in/dp/{asin}"

print("Loading product page...")
p.goto(url, wait_until="domcontentloaded", timeout=30000)
time.sleep(2)

# Try scrolling more aggressively and waiting longer
print("Scrolling page in steps...")
for pct in [0.2, 0.4, 0.6, 0.8, 1.0]:
    p.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
    time.sleep(1.5)

# Check if product details section appeared after scrolling
html = p.content()
has_bsr = "Best Sellers Rank" in html
print(f"After scroll - BSR in HTML: {has_bsr}")

if not has_bsr:
    # Try clicking on "Product Information" or "Additional Information" tab
    print("\nTrying to click product detail tabs...")
    tab_selectors = [
        "a#productDetails_expand_technical_section",
        "a[href='#productDetails_techSpec_section_1']",
        "#productDetails_db_sections a",
        "a:has-text('Product Information')",
        "a:has-text('Additional Information')",
        "a:has-text('Technical Details')",
        "a:has-text('Product details')",
        "#dp-container a:has-text('Product information')",
    ]
    for sel in tab_selectors:
        try:
            el = p.locator(sel)
            if el.count() > 0:
                print(f"  Found: {sel} (count={el.count()})")
                el.first.click(force=True, no_wait_after=True, timeout=3000)
                time.sleep(2)
                html = p.content()
                if "Best Sellers Rank" in html:
                    print(f"  BSR appeared after clicking {sel}!")
                    break
        except Exception as e:
            pass

    has_bsr = "Best Sellers Rank" in html
    print(f"After tab clicks - BSR in HTML: {has_bsr}")

if not has_bsr:
    # Try waiting for lazy load
    print("\nWaiting longer for lazy load...")
    time.sleep(5)
    p.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(3)
    html = p.content()
    has_bsr = "Best Sellers Rank" in html
    print(f"After extra wait - BSR in HTML: {has_bsr}")

if not has_bsr:
    # Try approach: use the mobile user agent which might have simpler rendering
    print("\nTrying mobile user agent...")
    p.close()
    p = b.new_page(user_agent="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36")
    p.goto(url, wait_until="domcontentloaded", timeout=30000)
    time.sleep(3)
    for pct in [0.3, 0.6, 1.0]:
        p.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
        time.sleep(1.5)
    html = p.content()
    has_bsr = "Best Sellers Rank" in html or "#" in html and " in " in html
    print(f"Mobile UA - BSR in HTML: {has_bsr}")
    
    # Check what's in the mobile page  
    text = p.locator("body").inner_text(timeout=5000)
    bsr_idx = text.lower().find("best seller")
    rank_idx = text.find("#")
    if bsr_idx > -1:
        print(f"  Found 'best seller' at {bsr_idx}: {text[bsr_idx:bsr_idx+200]}")
    if rank_idx > -1:
        # Find all # patterns
        for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n]{5,50})", text):
            print(f"  Rank: #{m.group(1)} in {m.group(2).strip()}")

if not has_bsr:
    # Try: networkidle wait
    print("\nTrying with networkidle...")
    p.close()
    p = b.new_page(user_agent=UA)
    p.goto(url, wait_until="networkidle", timeout=60000)
    time.sleep(2)
    p.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.7)")
    time.sleep(2)
    html = p.content()
    has_bsr = "Best Sellers Rank" in html
    print(f"networkidle - BSR in HTML: {has_bsr}")
    if has_bsr:
        text = p.locator("body").inner_text(timeout=5000)
        for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n]{5,50})", text):
            print(f"  Rank: #{m.group(1)} in {m.group(2).strip()}")

if has_bsr:
    text = p.locator("body").inner_text(timeout=5000)
    for m in re.finditer(r"#([\d,]+)\s+in\s+([^\n#(]{5,60})", text):
        print(f"  FOUND: #{m.group(1)} in {m.group(2).strip()}")
else:
    print("\nALL METHODS FAILED. BSR not rendered by Amazon for server IP.")
    # Last resort: check if available via JSON-LD or script data
    print("\nChecking script/JSON data...")
    scripts = p.locator("script").all()
    for s in scripts:
        try:
            content = s.inner_text(timeout=500)
            if "rank" in content.lower() and ("seller" in content.lower() or "category" in content.lower()):
                print(f"  Script with rank data found: {content[:300]}")
        except:
            pass

p.close()
b.close()
pw.stop()
print("\nDone.")
