from playwright.sync_api import sync_playwright
import time, re

pw = sync_playwright().start()
b = pw.chromium.launch(headless=True)
p = b.new_page(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
p.goto('https://www.amazon.in', timeout=30000)
time.sleep(2)

# Try force click with no_wait_after to avoid navigation timeout
print('Attempting force click on location...')
try:
    p.locator('#glow-ingress-block').click(force=True, no_wait_after=True, timeout=5000)
except Exception as e:
    print(f'Force click error: {e}')
    # Fallback: JS click
    p.evaluate('document.querySelector("#glow-ingress-block").click()')
time.sleep(3)

# Check for pincode input
inp = p.locator('#GLUXZipUpdateInput')
print('Input count after force click:', inp.count())

if inp.count() == 0:
    # Try JS click
    print('Trying JS click...')
    p.evaluate('document.querySelector("#glow-ingress-block").click()')
    time.sleep(2)
    inp = p.locator('#GLUXZipUpdateInput')
    print('Input count after JS click:', inp.count())

if inp.count() == 0:
    nav = p.locator('#nav-global-location-popover-link')
    print('Nav popup link count:', nav.count())
    if nav.count() > 0:
        nav.click(force=True, no_wait_after=True, timeout=5000)
        time.sleep(2)
        inp = p.locator('#GLUXZipUpdateInput')
        print('Input count after nav click:', inp.count())

if inp.count() > 0 and inp.is_visible():
    inp.click()
    inp.fill('110007')
    time.sleep(0.5)
    apply_btn = p.locator('#GLUXZipUpdate input[type=submit], #GLUXZipUpdate .a-button-input')
    print('Apply btn count:', apply_btn.count())
    if apply_btn.count() > 0:
        apply_btn.first.click(force=True, no_wait_after=True)
        time.sleep(3)
        for txt in ['Continue', 'Done', 'Apply']:
            try:
                btn = p.get_by_role('button', name=re.compile(txt, re.I)).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click(timeout=2000)
                    time.sleep(1)
                    break
            except:
                pass
        print('SUCCESS! Pincode set.')
        p.goto('https://www.amazon.in/dp/B0F8H6VCNF', timeout=30000)
        time.sleep(3)
        title_el = p.locator('#productTitle')
        if title_el.count() > 0:
            print('Product title:', title_el.inner_text(timeout=3000).strip()[:80])
        body = p.locator('body').inner_text(timeout=3000)
        if 'unavailable' in body.lower():
            print('STATUS: Currently unavailable')
        elif 'delivery' in body.lower():
            m = re.search(r'(FREE delivery[^\n]{0,80}|Fastest delivery[^\n]{0,80}|Get it by[^\n]{0,60})', body, re.I)
            if m:
                print('Delivery:', m.group(1))
        print('Done testing product page')
    else:
        print('No apply button found')
else:
    print('FAILED - no pincode input found')
    p.screenshot(path='/tmp/debug_pin.png')
    print('Screenshot saved')
    print(p.content()[:3000])

p.close()
b.close()
pw.stop()
