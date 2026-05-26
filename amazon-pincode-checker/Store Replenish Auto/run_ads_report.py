"""Download all ad reports and generate the monthly analysis."""
import sys
sys.path.insert(0, ".")
from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient
from amazon_ads_tool.reports import ReportManager
from amazon_ads_tool.optimizer import BidOptimizer, SearchTermHarvester
from amazon_ads_tool.analyzer import PerformanceAnalyzer

config = load_config()
client = AmazonAdsClient(config)
report_mgr = ReportManager(client, config)

days = 30

print("Downloading SP campaigns report...")
sp_data = report_mgr.download_report("sp_campaigns", days_back=days)
print(f"  SP campaigns: {len(sp_data)} rows")

print("Downloading SD campaigns report...")
try:
    sd_data = report_mgr.download_report("sd_campaigns", days_back=days)
    print(f"  SD campaigns: {len(sd_data)} rows")
except Exception as e:
    print(f"  SD campaigns: skipped ({e})")
    sd_data = []

print("Downloading SB campaigns report...")
try:
    sb_data = report_mgr.download_report("sb_campaigns", days_back=days)
    print(f"  SB campaigns: {len(sb_data)} rows")
except Exception as e:
    print(f"  SB campaigns: skipped ({e})")
    sb_data = []

print("\nDownloading SP targeting report...")
try:
    targeting_data = report_mgr.download_report("sp_targeting", days_back=days)
    print(f"  SP targeting: {len(targeting_data)} rows")
except Exception as e:
    print(f"  SP targeting: skipped ({e})")
    targeting_data = []

print("Downloading SP search terms report...")
try:
    search_term_data = report_mgr.download_report("sp_search_terms", days_back=days)
    print(f"  SP search terms: {len(search_term_data)} rows")
except Exception as e:
    print(f"  SP search terms: skipped ({e})")
    search_term_data = []

# Run optimization analysis
print("\nRunning bid optimization analysis...")
bid_actions = []
st_actions = []
if targeting_data:
    bid_optimizer = BidOptimizer(client, config)
    bid_actions = bid_optimizer.analyze_targeting_report(targeting_data)

if search_term_data:
    harvester = SearchTermHarvester(client, config)
    st_actions = harvester.analyze_search_terms(search_term_data)

# Generate report
print("\nGenerating monthly report...")
analyzer = PerformanceAnalyzer(config)
report = analyzer.generate_monthly_report(
    sp_data, sd_data, sb_data,
    bid_actions=bid_actions,
    search_term_actions=st_actions,
)

print("\n" + report)
print("\nReport saved to reports/ directory.")
