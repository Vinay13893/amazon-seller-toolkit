# Beta User Test Script

Follow these steps in order and record your observations.

## 1. Login
1. Open the app login page.
2. Sign in with your beta account.
3. Confirm you reach the dashboard successfully.

## 2. Connect Amazon (if not already connected)
1. Open Settings.
2. Start Amazon connection flow.
3. Complete authorization.
4. Return to app and confirm connection status is shown as connected.

## 3. Sync Listings
1. In Settings or ASIN area, run listing sync.
2. Wait for sync to complete.
3. Confirm listing count appears and products are visible.

## 4. Track ASIN
1. Open ASIN Tracking page.
2. Track one ASIN from your listings.
3. Confirm ASIN appears in tracked ASIN table.
4. Optional safe check: try tracking the same ASIN again and confirm duplicate is handled safely.

## 5. Refresh Keyword Rank
1. Open Keyword Tracker.
2. Add one keyword for a tracked ASIN if none exists.
3. Click Refresh Ranks.
4. Confirm latest rank/status and checked time update.

## 6. Refresh Product/BSR
1. Open ASIN detail page for your tracked ASIN.
2. Click Refresh Data.
3. Confirm response updates Last Checked and status.
4. If BSR is unavailable, confirm message is clear (BSR not available from Amazon) rather than generic failure.

## 7. Check Buy Box
1. On ASIN detail, open Buy Box section.
2. Click Run Check.
3. Confirm owner/price/status updates or clear fallback is shown.

## 8. Run Pincode Check
1. In ASIN detail, open Pincode section.
2. Run pincode check for sample pincodes.
3. Confirm results render without broken/null confusion.

## 9. Generate Alerts
1. Open Alerts page.
2. Click Generate Alerts.
3. Confirm page updates and alerts are understandable.
4. Note any clearly false critical alerts.

## 10. Report Feedback
Please report:
- What worked well.
- What was confusing.
- Any failed action and exact step number.
- Page URL used and approximate time.
- Screenshot if possible.
- Suggested improvement (one sentence).

## Quick Severity Guide
- P0: Cannot use core flow at all.
- P1: Core flow works but reliably breaks in a major step.
- P2: Works with friction or confusing messaging.
- P3: Cosmetic/polish issue only.
