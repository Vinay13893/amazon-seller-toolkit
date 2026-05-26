"""
Core API client for Amazon Advertising API v3.
Handles all HTTP communication, rate limiting, and error handling.
"""

import time
import gzip
import json
import logging
from io import BytesIO
from typing import Any, Optional

import requests

from .config import AmazonAdsConfig, API_ENDPOINTS
from .auth import AmazonAdsAuth

logger = logging.getLogger(__name__)

# Rate limit: max 10 requests per second
RATE_LIMIT_DELAY = 0.15  # seconds between requests


class AmazonAdsApiError(Exception):
    """Custom exception for API errors."""
    def __init__(self, status_code: int, message: str, response: Optional[dict] = None):
        self.status_code = status_code
        self.response = response
        super().__init__(f"HTTP {status_code}: {message}")


class AmazonAdsClient:
    """Low-level client for Amazon Ads API v3."""

    def __init__(self, config: AmazonAdsConfig):
        self.config = config
        self.auth = AmazonAdsAuth(config)
        self.base_url = API_ENDPOINTS[config.region]
        self._last_request_time = 0.0

    def _rate_limit(self):
        """Simple rate limiter."""
        elapsed = time.time() - self._last_request_time
        if elapsed < RATE_LIMIT_DELAY:
            time.sleep(RATE_LIMIT_DELAY - elapsed)
        self._last_request_time = time.time()

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        params: Optional[dict] = None,
        extra_headers: Optional[dict] = None,
        accept: str = "application/vnd.createasyncreportrequest.v3+json",
        content_type: Optional[str] = None,
    ) -> requests.Response:
        """Make an authenticated API request with rate limiting and retry."""
        self._rate_limit()
        url = f"{self.base_url}{path}"
        headers = self.auth.get_headers()
        if accept:
            headers["Accept"] = accept
        # Set Content-Type: use explicit content_type, or match Accept header for v3+ APIs
        if content_type:
            headers["Content-Type"] = content_type
        elif accept and accept != "application/json":
            headers["Content-Type"] = accept
        if extra_headers:
            headers.update(extra_headers)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                resp = requests.request(
                    method,
                    url,
                    json=body,
                    params=params,
                    headers=headers,
                    timeout=60,
                )

                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", 5))
                    logger.warning("Rate limited. Retrying after %ds...", retry_after)
                    time.sleep(retry_after)
                    continue

                if resp.status_code >= 500 and attempt < max_retries - 1:
                    logger.warning("Server error %d. Retrying...", resp.status_code)
                    time.sleep(2 ** attempt)
                    continue

                return resp

            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                if attempt < max_retries - 1:
                    logger.warning("Request error (%s). Retrying...", exc)
                    time.sleep(2 ** attempt)
                    continue
                raise

        return resp

    def get(self, path: str, params: Optional[dict] = None, **kwargs) -> dict:
        resp = self._request("GET", path, params=params, **kwargs)
        if resp.status_code >= 400:
            raise AmazonAdsApiError(resp.status_code, resp.text, resp.json() if resp.text else None)
        return resp.json()

    def post(self, path: str, body: Optional[dict] = None, **kwargs) -> dict:
        resp = self._request("POST", path, body=body, **kwargs)
        if resp.status_code >= 400:
            raise AmazonAdsApiError(resp.status_code, resp.text)
        return resp.json()

    def put(self, path: str, body: Optional[dict] = None, **kwargs) -> dict:
        resp = self._request("PUT", path, body=body, **kwargs)
        if resp.status_code >= 400:
            raise AmazonAdsApiError(resp.status_code, resp.text)
        return resp.json()

    def delete(self, path: str, **kwargs) -> dict:
        resp = self._request("DELETE", path, **kwargs)
        if resp.status_code >= 400:
            raise AmazonAdsApiError(resp.status_code, resp.text)
        return resp.json() if resp.text else {}

    # ── Profile Management ──────────────────────────────────────────

    def list_profiles(self) -> list[dict]:
        """List all advertising profiles (accounts) you have access to."""
        return self.get("/v2/profiles", accept="application/json")

    def get_profile(self, profile_id: str) -> dict:
        return self.get(f"/v2/profiles/{profile_id}", accept="application/json")

    # ── Sponsored Products ──────────────────────────────────────────

    def sp_list_campaigns(self, states: Optional[list[str]] = None) -> list[dict]:
        """List SP campaigns. States: ENABLED, PAUSED, ARCHIVED."""
        all_campaigns = []
        body = {"maxResults": 100}
        if states:
            body["stateFilter"] = {"include": states}

        while True:
            resp = self._request("POST", "/sp/campaigns/list", body=body, accept="application/vnd.spCampaign.v3+json")
            if resp.status_code >= 400:
                raise AmazonAdsApiError(resp.status_code, resp.text)
            data = resp.json()
            campaigns = data.get("campaigns", []) if isinstance(data, dict) else data
            all_campaigns.extend(campaigns)
            next_token = data.get("nextToken") if isinstance(data, dict) else None
            if not next_token:
                break
            body["nextToken"] = next_token

        return all_campaigns

    def sp_update_campaign(self, campaign_id: str, updates: dict) -> dict:
        """Update an SP campaign (budget, status, etc.)."""
        body = {"campaigns": [{"campaignId": campaign_id, **updates}]}
        return self.put("/sp/campaigns", body=body, accept="application/vnd.spCampaign.v3+json")

    def sp_list_ad_groups(self, campaign_id: Optional[str] = None) -> list[dict]:
        body = {}
        if campaign_id:
            body["campaignIdFilter"] = {"include": [campaign_id]}
        return self.post("/sp/adGroups/list", body=body, accept="application/vnd.spAdGroup.v3+json")

    def sp_list_keywords(self, ad_group_id: Optional[str] = None) -> list[dict]:
        body = {}
        if ad_group_id:
            body["adGroupIdFilter"] = {"include": [ad_group_id]}
        return self.post("/sp/keywords/list", body=body, accept="application/vnd.spKeyword.v3+json")

    def sp_update_keyword(self, keyword_id: str, updates: dict) -> dict:
        body = {"keywords": [{"keywordId": keyword_id, **updates}]}
        return self.put("/sp/keywords", body=body, accept="application/vnd.spKeyword.v3+json")

    def sp_create_keywords(self, keywords: list[dict]) -> dict:
        """Create new SP keywords (for search term harvesting)."""
        body = {"keywords": keywords}
        return self.post("/sp/keywords", body=body, accept="application/vnd.spKeyword.v3+json")

    def sp_create_negative_keywords(self, neg_keywords: list[dict]) -> dict:
        """Create negative keywords (for negating bad search terms)."""
        body = {"negativeKeywords": neg_keywords}
        return self.post("/sp/negativeKeywords", body=body, accept="application/vnd.spNegativeKeyword.v3+json")

    def sp_list_targets(self, ad_group_id: Optional[str] = None) -> list[dict]:
        body = {}
        if ad_group_id:
            body["adGroupIdFilter"] = {"include": [ad_group_id]}
        return self.post("/sp/targets/list", body=body, accept="application/vnd.spTargetingClause.v3+json")

    def sp_update_target(self, target_id: str, updates: dict) -> dict:
        body = {"targetingClauses": [{"targetId": target_id, **updates}]}
        return self.put("/sp/targets", body=body, accept="application/vnd.spTargetingClause.v3+json")

    # ── Sponsored Brands ────────────────────────────────────────────

    def sb_list_campaigns(self) -> list[dict]:
        body = {}
        resp = self._request("POST", "/sb/v4/campaigns/list", body=body, accept="application/vnd.sbcampaignresource.v4+json")
        if resp.status_code >= 400:
            raise AmazonAdsApiError(resp.status_code, resp.text)
        return resp.json().get("campaigns", resp.json() if isinstance(resp.json(), list) else [])

    def sb_update_campaign(self, campaign_id: str, updates: dict) -> dict:
        body = {"campaigns": [{"campaignId": campaign_id, **updates}]}
        return self.put("/sb/v4/campaigns", body=body, accept="application/vnd.sbcampaignresource.v4+json")

    # ── Sponsored Display ───────────────────────────────────────────

    def sd_list_campaigns(self) -> list[dict]:
        return self.get("/sd/campaigns", accept="application/json")

    def sd_update_campaign(self, campaign_id: str, updates: dict) -> dict:
        body = {"campaigns": [{"campaignId": campaign_id, **updates}]}
        return self.put("/sd/campaigns", body=body, accept="application/vnd.sdCampaign.v3+json")

    # ── Report Downloads (async v3) ─────────────────────────────────

    def download_gzip_report(self, url: str) -> list[dict]:
        """Download and decompress a gzip report from the given URL."""
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        decompressed = gzip.decompress(resp.content)
        return json.loads(decompressed)
