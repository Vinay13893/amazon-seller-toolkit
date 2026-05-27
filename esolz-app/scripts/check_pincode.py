#!/usr/bin/env python3
"""
Single ASIN x Pincode checker for Sociomonkey integration.

Wraps the existing amazon_pincode_checker.py tool to support single-check workflow.
Outputs JSON to stdout for consumption by Node.js TypeScript adapter.

Usage:
    python check_pincode.py \
        --asin B0822GYVNX \
        --pincode 110001 \
        --marketplace IN \
        --profile-dir ../../amazon-pincode-checker/pincode_checker/amazon_profile

Output (stdout):
    {
      "asin": "B0822GYVNX",
      "pincode": "110001",
      "marketplace": "IN",
      "url": "https://www.amazon.in/dp/B0822GYVNX",
      "title": "Product Title",
      "is_buyable": true,
      "availability_text": "In stock",
      "amazon_fulfilled": true,
      "merchant_text": "Ships from Amazon | Sold by Seller Name",
      "delivery_type": "same_day",
      "delivery_text": "FREE Same-Day Delivery by 9 PM",
      "captcha_seen": false,
      "error": "",
      "checked_at": "2026-05-26T16:00:00+00:00"
    }
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

# Import the existing pincode checker tool
# Adjust path to locate the tool relative to this script
TOOL_DIR = Path(__file__).resolve().parent.parent.parent / "amazon-pincode-checker" / "pincode_checker"
sys.path.insert(0, str(TOOL_DIR))

try:
    from amazon_pincode_checker import (
        check_asin,
        set_pincode,
        sync_playwright,
        USER_AGENT,
    )
except ImportError as e:
    print(
        json.dumps({
            "error": f"Failed to import pincode checker tool: {e}",
            "asin": "",
            "pincode": "",
            "marketplace": "",
        }),
        file=sys.stdout,
    )
    sys.exit(1)


def run_check(asin: str, pincode: str, marketplace: str, profile_dir: Path) -> dict:
    """
    Run a single pincode check using the existing tool's functions.
    
    Returns a dict matching CheckResult structure with added marketplace field.
    """
    # Marketplace URL mapping (same as existing tool, extended for clarity)
    AMAZON_BASE = {
        "IN": "https://www.amazon.in",
        "US": "https://www.amazon.com",
        "UK": "https://www.amazon.co.uk",
        "DE": "https://www.amazon.de",
    }
    
    base_url = AMAZON_BASE.get(marketplace.upper(), AMAZON_BASE["IN"])
    
    with sync_playwright() as p:
        # Launch persistent browser context (same as existing tool)
        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=False,  # Keep headful for CAPTCHA handling
            viewport={"width": 1440, "height": 1200},
            user_agent=USER_AGENT,
            locale="en-IN",
            timezone_id="Asia/Kolkata",
            ignore_https_errors=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        )
        
        page = browser.new_page()
        page.set_default_timeout(25000)
        
        # Set pincode first
        print(f"[check_pincode] Setting pincode: {pincode}", file=sys.stderr)
        pincode_ok = set_pincode(page, pincode)
        if not pincode_ok:
            print(f"[check_pincode] WARNING: Could not confidently set pincode", file=sys.stderr)
        
        # Check ASIN
        print(f"[check_pincode] Checking ASIN: {asin}", file=sys.stderr)
        result = check_asin(page, asin, pincode)
        
        browser.close()
    
    # Convert dataclass to dict
    result_dict = asdict(result)
    
    # Add marketplace field
    result_dict["marketplace"] = marketplace.upper()
    
    # Add ISO timestamp if not present
    if "checked_at" not in result_dict or not result_dict["checked_at"]:
        result_dict["checked_at"] = datetime.now(timezone.utc).isoformat()
    
    print(f"[check_pincode] Check complete: buyable={result.is_buyable} delivery={result.delivery_type}", file=sys.stderr)
    
    return result_dict


def main() -> int:
    parser = argparse.ArgumentParser(description="Single ASIN x Pincode availability check")
    parser.add_argument("--asin", required=True, help="Amazon ASIN (10 chars)")
    parser.add_argument("--pincode", required=True, help="Delivery pincode (6 digits for IN)")
    parser.add_argument("--marketplace", default="IN", help="Marketplace: IN / US / UK / DE")
    parser.add_argument(
        "--profile-dir",
        default="../../amazon-pincode-checker/pincode_checker/amazon_profile",
        help="Persistent browser profile directory",
    )
    
    args = parser.parse_args()
    
    profile_dir = Path(args.profile_dir).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"[check_pincode] Profile dir: {profile_dir}", file=sys.stderr)
    print(f"[check_pincode] ASIN: {args.asin}, Pincode: {args.pincode}, Marketplace: {args.marketplace}", file=sys.stderr)
    
    try:
        result = run_check(
            asin=args.asin.strip().upper(),
            pincode=args.pincode.strip(),
            marketplace=args.marketplace.strip().upper(),
            profile_dir=profile_dir,
        )
        
        # Output JSON to stdout (TypeScript adapter will parse this)
        print(json.dumps(result))
        return 0
        
    except Exception as exc:
        # Output error as JSON to stdout
        error_result = {
            "asin": args.asin,
            "pincode": args.pincode,
            "marketplace": args.marketplace,
            "url": "",
            "title": "",
            "is_buyable": False,
            "availability_text": "",
            "amazon_fulfilled": False,
            "merchant_text": "",
            "delivery_type": "error",
            "delivery_text": "",
            "captcha_seen": False,
            "error": f"{type(exc).__name__}: {str(exc)}",
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        print(json.dumps(error_result))
        print(f"[check_pincode] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("[check_pincode] Interrupted by user", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f"[check_pincode] Fatal error: {exc}", file=sys.stderr)
        sys.exit(1)
