"""List all advertising profiles associated with the current credentials."""
from dotenv import load_dotenv
load_dotenv()

from amazon_ads_tool.config import load_config
from amazon_ads_tool.api_client import AmazonAdsClient

config = load_config()
# Clear profile_id so we can list all profiles
config.profile_id = ""
client = AmazonAdsClient(config)

print("Fetching all advertising profiles...\n")
profiles = client.get("/v2/profiles", accept="application/json")

for p in profiles:
    print(f"  Profile ID: {p.get('profileId')}")
    print(f"  Country:    {p.get('countryCode')}")
    print(f"  Currency:   {p.get('currencyCode')}")
    print(f"  Timezone:   {p.get('timezone')}")
    print(f"  Type:       {p.get('accountInfo', {}).get('type')}")
    print(f"  Name:       {p.get('accountInfo', {}).get('name')}")
    print(f"  MarketID:   {p.get('accountInfo', {}).get('marketplaceStringId')}")
    print(f"  Seller ID:  {p.get('accountInfo', {}).get('id')}")
    print()
