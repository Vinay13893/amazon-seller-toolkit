# Daily Dashboard Auto-Refresh Script
# Runs via Windows Task Scheduler to refresh data daily

$ErrorActionPreference = "Continue"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$logFile = Join-Path $PSScriptRoot "output\auto_refresh.log"

# Ensure output dir exists
$outputDir = Join-Path $PSScriptRoot "output"
if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir | Out-Null }

# Activate venv and run
$venvActivate = "E:\amazon-bsr-tracker\amazon-pincode-checker\amazon_ads_tool\.venv\Scripts\Activate.ps1"
$dashboardScript = Join-Path $PSScriptRoot "run_dashboard.py"

"[$timestamp] === Auto-refresh started ===" | Out-File $logFile -Append -Encoding utf8

try {
    & $venvActivate
    $output = python $dashboardScript 2>&1 | Out-String
    $output | Out-File $logFile -Append -Encoding utf8
    "[$timestamp] === Completed successfully ===" | Out-File $logFile -Append -Encoding utf8
} catch {
    "[$timestamp] ERROR: $_" | Out-File $logFile -Append -Encoding utf8
}
