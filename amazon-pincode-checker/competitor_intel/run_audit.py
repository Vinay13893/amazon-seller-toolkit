"""
Run Full Competitive Audit
===========================
Orchestrates all three competitor intelligence tools in sequence:
  1. Placement Audit    (Ads API — ~3 min)
  2. SERP Audit         (Playwright scraper — ~20-40 min depending on categories)
  3. FC Delivery Audit  (Playwright scraper — ~10-15 min)

Usage:
    cd e:\\amazon-bsr-tracker\\amazon-pincode-checker
    & amazon_ads_tool\.venv\Scripts\Activate.ps1

    # Run everything (all categories):
    python competitor_intel/run_audit.py

    # Run only specific categories for SERP audit:
    python competitor_intel/run_audit.py --categories ASM Storage

    # Skip SERP (just placement + FC):
    python competitor_intel/run_audit.py --skip-serp

    # Skip FC audit (just placement + SERP):
    python competitor_intel/run_audit.py --skip-fc

    # Placement only (fastest, API only):
    python competitor_intel/run_audit.py --placement-only
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)
PYTHON = sys.executable


def run_step(label, script_path, extra_args=None):
    """Run a Python script as a subprocess and stream output."""
    print(f"\n{'=' * 70}")
    print(f"  STEP: {label}")
    print(f"  Script: {script_path}")
    print(f"  Started: {datetime.now().strftime('%H:%M:%S')}")
    print("=" * 70)

    cmd = [PYTHON, script_path]
    if extra_args:
        cmd.extend(extra_args)

    result = subprocess.run(cmd, cwd=PARENT_DIR)
    if result.returncode != 0:
        print(f"\n⚠️  {label} exited with code {result.returncode}")
        return False

    print(f"\n  ✅ {label} completed at {datetime.now().strftime('%H:%M:%S')}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Full Competitive Audit Orchestrator")
    parser.add_argument("--categories", nargs="+", default=[],
                        help="Categories for SERP audit (default: all). E.g. ASM Storage BPM")
    parser.add_argument("--skip-serp", action="store_true", help="Skip SERP audit")
    parser.add_argument("--skip-fc", action="store_true", help="Skip FC delivery audit")
    parser.add_argument("--placement-only", action="store_true", help="Run only placement audit")
    parser.add_argument("--from-serp-output", action="store_true",
                        help="Use SERP audit output for FC audit competitor ASINs")
    args = parser.parse_args()

    print("=" * 70)
    print("  EMOUNT VENTURES — FULL COMPETITIVE INTELLIGENCE AUDIT")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    placement_script = os.path.join(SCRIPT_DIR, "placement_audit.py")
    serp_script = os.path.join(SCRIPT_DIR, "serp_audit.py")
    fc_script = os.path.join(SCRIPT_DIR, "fc_delivery_audit.py")

    steps_run = []

    # ── Step 1: Placement Audit ──────────────────────────────────────────────
    ok = run_step("Placement Audit (Ads API)", placement_script)
    steps_run.append(("Placement Audit", ok))

    if args.placement_only:
        print("\n✅ --placement-only flag set, stopping here.")
        return

    # ── Step 2: SERP Audit ───────────────────────────────────────────────────
    if not args.skip_serp:
        serp_extra = args.categories if args.categories else []
        ok = run_step("SERP Competitor Audit (Playwright)", serp_script, serp_extra)
        steps_run.append(("SERP Audit", ok))
    else:
        print("\n⏭  Skipping SERP audit (--skip-serp)")
        steps_run.append(("SERP Audit", "SKIPPED"))

    # ── Step 3: FC Delivery Audit ────────────────────────────────────────────
    if not args.skip_fc:
        fc_extra = ["--from-serp-output"] if args.from_serp_output else []
        ok = run_step("FC Delivery Audit (Playwright)", fc_script, fc_extra)
        steps_run.append(("FC Delivery Audit", ok))
    else:
        print("\n⏭  Skipping FC audit (--skip-fc)")
        steps_run.append(("FC Delivery Audit", "SKIPPED"))

    # ── Final summary ────────────────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print("  AUDIT COMPLETE — Summary")
    print(f"{'=' * 70}")
    for step, status in steps_run:
        icon = "✅" if status is True else ("⏭" if status == "SKIPPED" else "❌")
        print(f"  {icon}  {step}")

    out_dir = os.path.join(SCRIPT_DIR, "output")
    print(f"\n  📁 All outputs in: {out_dir}")
    print(f"  Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)


if __name__ == "__main__":
    main()
