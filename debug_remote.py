from playwright.sync_api import sync_playwright
import time, re

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)

# ======== TEST 1: Seller Lookup (offer listing page) ========
print("=" * 60)
print("TEST 1: SELLER LOOKUP")
print("=" * 60)
p = b.new_page(user_agent=UA)
asin = "B0F8H6VCNF"
url = f"https://www.amazon.in/gp/offer-listing/{asin}?condition=new"
print(f"Loading: {url}")
try:
    resp = p.goto(url, wait_until="domcontentloaded", timeout=30000)
    print(f"HTTP status: {resp.status if resp else 'None'}")
    time.sleep(2.5)
    html = p.content()
    
    # Check for CAPTCHA
    if "captcha" in html.lower():
        print("WARNING: CAPTCHA detected!")
    
    # Check page content
    body_text = p.locator("body").inner_text(timeout=5000)[:3000]
    print(f"\nBody text (first 1500 chars):\n{body_text[:1500]}")
    
    # Check for offer divs
    offers_aod = p.locator("div#aod-offer, div.aod-offer")
    offers_olp = p.locator("div.olpOffer")
    print(f"\naod-offer count: {offers_aod.count()}")
    print(f"olpOffer count: {offers_olp.count()}")
    
    # Check if it's a "no offers" page or redirected to product page
    if "no offers" in body_text.lower() or "currently unavailable" in body_text.lower():
        print("Page says: no offers or unavailable")
    
    # Save screenshot
    p.screenshot(path="/tmp/seller_debug.png")
    print("Screenshot: /tmp/seller_debug.png")
    
    # Save HTML
    with open("/tmp/seller_debug.html", "w") as f:
        f.write(html[:50000])
    print("HTML saved: /tmp/seller_debug.html")
except Exception as e:
    print(f"Error: {e}")
p.close()

# ======== TEST 2: Pincode Check ========
print("\n" + "=" * 60)
print("TEST 2: PINCODE CHECK")
print("=" * 60)
p = b.new_page(user_agent=UA)

# Step 1: Go to amazon.in
print("Loading amazon.in...")
p.goto("https://www.amazon.in", wait_until="domcontentloaded", timeout=60000)
time.sleep(2)

# Step 2: Try to open location popup
print("Clicking location popup...")
# Method A: normal click
try:
    loc = p.locator("#glow-ingress-block")
    print(f"  #glow-ingress-block found: {loc.count()}")
    if loc.count() > 0:
        loc.click(no_wait_after=True, timeout=3000)
        print("  Normal click done")
        time.sleep(2)
except Exception as e:
    print(f"  Normal click failed: {e}")

# Check if popup opened
inp = p.locator("#GLUXZipUpdateInput")
print(f"  Input after normal click: {inp.count()}")

# Method B: JS click
if inp.count() == 0:
    print("  Trying JS click...")
    try:
        p.evaluate('document.querySelector("#glow-ingress-block").click()')
        time.sleep(3)
        inp = p.locator("#GLUXZipUpdateInput")
        print(f"  Input after JS click: {inp.count()}")
    except Exception as e:
        print(f"  JS click failed: {e}")

# Method C: direct URL approach (set cookie via address bar)
if inp.count() == 0:
    print("  Trying alternative popup selectors...")
    for sel in ["#nav-global-location-popover-link", "#contextualIngressPtLabel_deliveryShortLine"]:
        try:
            el = p.locator(sel)
            if el.count() > 0:
                print(f"    Found {sel}, clicking...")
                p.evaluate(f'document.querySelector("{sel}").click()')
                time.sleep(2)
                inp = p.locator("#GLUXZipUpdateInput")
                print(f"    Input count: {inp.count()}")
                if inp.count() > 0:
                    break
        except Exception as e:
            print(f"    {sel} failed: {e}")

if inp.count() > 0 and inp.is_visible():
    print("  Filling pincode 110007...")
    inp.click()
    inp.fill("110007")
    time.sleep(0.5)
    
    # Find and click Apply
    apply_sel = "#GLUXZipUpdate input[type=submit], #GLUXZipUpdate .a-button-input"
    apply_btn = p.locator(apply_sel)
    print(f"  Apply button count: {apply_btn.count()}")
    if apply_btn.count() > 0:
        apply_btn.first.click(force=True, no_wait_after=True)
        time.sleep(3)
        
        # Handle continue/done
        for txt in ["Continue", "Done"]:
            try:
                btn = p.get_by_role("button", name=re.compile(txt, re.I)).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click(timeout=2000)
                    time.sleep(1)
                    break
            except:
                pass
        
        print("  Pincode set! Now checking product page...")
        p.goto(f"https://www.amazon.in/dp/{asin}", wait_until="domcontentloaded", timeout=60000)
        time.sleep(3)
        
        # Get title
        try:
            title = p.locator("#productTitle").first.inner_text(timeout=3000).strip()[:80]
            print(f"  Title: {title}")
        except:
            print("  No title found")
        
        # Get body
        try:
            body = p.locator("body").inner_text(timeout=3000)[:2000]
            if "unavailable" in body.lower():
                print("  STATUS: unavailable")
            else:
                m = re.search(r"(FREE delivery[^\n]{0,80}|Fastest delivery[^\n]{0,80}|Get it by[^\n]{0,60})", body, re.I)
                if m:
                    print(f"  Delivery: {m.group(1)}")
                else:
                    print("  No delivery match found in body")
        except:
            pass
        
        p.screenshot(path="/tmp/pincode_product.png")
        print("  Screenshot: /tmp/pincode_product.png")
    else:
        print("  No Apply button found")
else:
    print("  FAILED: No pincode input visible")
    p.screenshot(path="/tmp/pincode_debug.png")
    print("  Screenshot: /tmp/pincode_debug.png")
    body = p.locator("body").inner_text(timeout=3000)[:2000]
    print(f"  Body text:\n{body}")

p.close()
b.close()
pw.stop()
print("\nDone.")
