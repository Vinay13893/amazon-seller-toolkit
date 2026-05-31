# Beta Release Checklist

## Current Beta Version Status
- Release stage: Beta freeze candidate.
- QA status: Focused MVP QA completed with no P0/P1 blockers found.
- Deployment status: Use current live production build only; no additional deploy required for this checklist.
- Target cohort: First 3-5 beta users.

## Live Modules
- Keyword Tracker: live and validated in production.
- ASIN Tracking and listing import flow: live with safe duplicate handling.
- Product/BSR refresh foundation: live with Amazon Catalog API first.
- Buy Box Monitor: live and validated.
- Pincode checks: live with null-safe handling in dashboards/alerts.
- Alerts generation: live and validated for current regression scope.
- Dashboard overview shell: live and validated for normal load/reload behavior.

## Known Limitations
- Pincode accuracy remains beta/experimental and may vary by run.
- BSR refresh can return `partial_success` when Amazon does not return sales rank.
- Competitors page is placeholder and not part of beta validation.
- Destructive remove/archive ASIN actions were not exercised in production QA.
- Occasional console/network noise exists; currently not user-facing.

## What Beta Users Can Safely Test
- Login and normal dashboard navigation.
- Amazon account connect flow (if not connected).
- Listing sync visibility and imported listing counts.
- Track ASIN flow for allowed products.
- Duplicate ASIN import behavior (should be safely blocked/ignored).
- Keyword tracking and Refresh Ranks behavior.
- Product Refresh Data behavior and BSR status messaging.
- Buy Box Run Check behavior and latest snapshot visibility.
- Pincode check flow and null-safe display behavior.
- Generate Alerts and review alert severity consistency.

## What Beta Users Should Not Rely On Yet
- Exact pincode availability certainty for operational decisions.
- Guaranteed BSR presence for every ASIN refresh.
- Competitor intelligence completeness.
- Destructive ASIN lifecycle operations (remove/archive) as part of beta acceptance.
- Console error-free sessions as a quality gate when UI behavior is healthy.

## Test Account Checklist
- Confirm account can log in and reach dashboard.
- Confirm workspace is correct before testing.
- Confirm Amazon connection status is visible.
- Confirm listings are synced (or sync action available).
- Confirm at least one ASIN is tracked.
- Confirm at least one keyword is tracked for one ASIN.
- Confirm Buy Box and Pincode modules are accessible.
- Confirm Alerts page loads with expected baseline alerts.

## Daily Monitoring Checklist
- Review error logs for new repeated API failures.
- Review refresh success rates for:
  - Keyword refresh.
  - ASIN/BSR refresh.
  - Buy Box checks.
  - Pincode checks.
- Review Alerts generation consistency for false critical spikes.
- Spot-check dashboard load time and shell resolution.
- Verify no growth in user-facing failures or stuck states.
- Track beta user feedback volume and severity labels.

## Rollback Checklist
- Trigger rollback if a confirmed P0/P1 regression appears.
- Steps:
  1. Identify failing module and timestamp.
  2. Capture impacted endpoint/page and user-visible symptom.
  3. Roll back to last known good production deployment.
  4. Verify core smoke flows after rollback:
     - Login/dashboard load.
     - ASIN page load.
     - Keyword table load.
     - Buy Box check action.
     - Alerts generation.
  5. Post rollback note to beta channel with impact and ETA.

## Feedback Questions for Beta Users
- Was login and first dashboard load smooth?
- Could you find and track your ASINs without confusion?
- Did keyword rank refresh show understandable results?
- Did BSR refresh messaging make sense when rank was unavailable?
- Was Buy Box output understandable and trustworthy for your use?
- Did pincode results feel directionally useful for your market?
- Were alerts helpful, noisy, or missing important issues?
- Which step felt slowest or most confusing?
- What is the single most important improvement before wider beta?

## P0/P1 Issue Escalation Rules
- P0 (blocks beta immediately):
  - App unavailable for core pages.
  - Data corruption/loss in tracked entities.
  - Authentication/authorization break exposing wrong workspace data.
  - Core module actions nonfunctional for most users (ASIN/Keyword/Buy Box/Alerts).
- P1 (must fix before expanding beta cohort):
  - Reproducible workflow break in a core module for subset of users.
  - Severe misleading outputs that could trigger incorrect business decisions.
  - Persistent stuck loading or repeated user-facing error states.
- Triage process:
  1. Reproduce with page URL + timestamp + workspace.
  2. Label severity (P0/P1/P2/P3).
  3. Assign owner and target fix window.
  4. Validate fix in production with a focused smoke test.
