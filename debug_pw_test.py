from playwright.sync_api import sync_playwright
import re

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
    page.goto("https://www.amazon.in/dp/B0F8J275QC", wait_until="domcontentloaded")
    # Wait for product details to load
    page.wait_for_timeout(3000)
    
    # Try scrolling to trigger lazy load
    page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
    page.wait_for_timeout(2000)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(2000)

    html = page.content()
    browser.close()

with open(r"c:\amazon-bsr-tracker\debug_pw.html", "w", encoding="utf-8") as f:
    f.write(html)

# Check for BSR
matches = re.findall(r"#([\d,]+)\s+in\s+([^\n<(]+)", html)
print(f"Found {len(matches)} BSR matches:")
for rank, cat in matches[:10]:
    print(f"  #{rank} in {cat.strip()[:60]}")

if not matches:
    if "Best Sellers Rank" in html:
        print("'Best Sellers Rank' text IS present")
    else:
        print("'Best Sellers Rank' text NOT found")
    if "captcha" in html.lower():
        print("CAPTCHA detected!")
