"""
Amazon Ads API Authentication using Login with Amazon (LWA) OAuth2.
Handles token refresh and credential management.
"""

import time
import logging
import requests
from typing import Optional

from .config import AmazonAdsConfig, TOKEN_URL

logger = logging.getLogger(__name__)


class AmazonAdsAuth:
    """Manages OAuth2 authentication for the Amazon Advertising API."""

    def __init__(self, config: AmazonAdsConfig):
        self.config = config
        self._access_token: Optional[str] = None
        self._token_expiry: float = 0

    def get_access_token(self) -> str:
        """Get a valid access token, refreshing if needed."""
        if self._access_token and time.time() < self._token_expiry - 60:
            return self._access_token

        self._refresh_token()
        return self._access_token

    def _refresh_token(self):
        """Refresh the access token using the refresh token."""
        if not self.config.client_id or not self.config.client_secret or not self.config.refresh_token:
            raise ValueError(
                "Missing credentials. Set AMZN_ADS_CLIENT_ID, AMZN_ADS_CLIENT_SECRET, "
                "and AMZN_ADS_REFRESH_TOKEN in your .env file."
            )

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self.config.refresh_token,
            "client_id": self.config.client_id,
            "client_secret": self.config.client_secret,
        }

        resp = requests.post(TOKEN_URL, data=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        self._access_token = data["access_token"]
        self._token_expiry = time.time() + data.get("expires_in", 3600)
        logger.info("Access token refreshed successfully (expires in %ds)", data.get("expires_in", 3600))

    def get_headers(self) -> dict:
        """Get authorization headers for API requests."""
        token = self.get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Amazon-Advertising-API-ClientId": self.config.client_id,
            "Content-Type": "application/json",
        }
        if self.config.profile_id:
            headers["Amazon-Advertising-API-Scope"] = self.config.profile_id
        return headers
