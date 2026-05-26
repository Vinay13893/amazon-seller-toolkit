# Amazon.in ASIN x Pincode checker

Files included:
- `amazon_pincode_checker.py`
- `asins.csv`
- `pincodes.csv`

## Setup

```bash
pip install playwright
playwright install chromium
```

## Run

```bash
python amazon_pincode_checker.py \
  --asins asins.csv \
  --pincodes pincodes.csv \
  --output amazon_availability_report.csv \
  --profile-dir ./amazon_profile
```

## Output columns
- `asin`
- `pincode`
- `url`
- `title`
- `is_buyable`
- `availability_text`
- `amazon_fulfilled`
- `merchant_text`
- `delivery_type` → `same_day`, `next_day`, `two_day`, `other`, `unknown`, `unavailable`, `error`
- `delivery_text`
- `captcha_seen`
- `error`

## Best practice
Use a logged-in Prime account in the persistent browser profile if your goal is to evaluate same-day / next-day delivery promises as customers actually see them.
