"""
Helper script to get Amazon Ads API refresh token via OAuth2 flow.
Opens a browser for login and catches the callback locally.

Usage: python get_refresh_token.py
"""

import http.server
import urllib.parse
import webbrowser
import requests
import json
import sys
import ssl
import os
import subprocess
import tempfile

# Your credentials
CLIENT_ID = "amzn1.application-oa2-client.a15bdf83fcb4431ea5a6f0cfddbc0a79"
CLIENT_SECRET = os.environ.get("AMZN_SECRET", "")  # Will prompt if not set

REDIRECT_URI = "https://localhost:3000/callback"
TOKEN_URL = "https://api.amazon.com/auth/o2/token"
AUTH_URL = "https://www.amazon.in/ap/oa"

SCOPE = "advertising::campaign_management"


class OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """Handle the OAuth callback."""

    auth_code = None

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if "code" in params:
            OAuthCallbackHandler.auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"""
            <html><body style="font-family:Arial;text-align:center;padding:50px">
            <h1 style="color:green">Authorization Successful!</h1>
            <p>You can close this tab and go back to the terminal.</p>
            </body></html>
            """)
        elif "error" in params:
            error = params.get("error", ["unknown"])[0]
            error_desc = params.get("error_description", ["No description"])[0]
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(f"""
            <html><body style="font-family:Arial;text-align:center;padding:50px">
            <h1 style="color:red">Authorization Failed</h1>
            <p>Error: {error}</p>
            <p>{error_desc}</p>
            </body></html>
            """.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logs


def generate_self_signed_cert():
    """Generate a self-signed certificate for localhost HTTPS."""
    cert_dir = tempfile.mkdtemp()
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")

    # Use openssl to generate cert
    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", key_file, "-out", cert_file,
            "-days", "1", "-nodes",
            "-subj", "/CN=localhost"
        ], capture_output=True, check=True)
        return cert_file, key_file
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None, None


def main():
    print("=" * 60)
    print("  Amazon Ads API - Get Refresh Token")
    print("=" * 60)

    client_secret = CLIENT_SECRET
    if not client_secret:
        client_secret = input("\nEnter your Client Secret: ").strip()
        if not client_secret:
            print("Client Secret is required!")
            sys.exit(1)

    # Try HTTPS with self-signed cert first
    use_https = False
    cert_file, key_file = generate_self_signed_cert()
    redirect_uri = REDIRECT_URI

    if cert_file:
        use_https = True
        print("\nUsing HTTPS with self-signed certificate...")
    else:
        # Fallback to HTTP
        redirect_uri = "http://localhost:3000/callback"
        print("\nUsing HTTP (openssl not found for HTTPS)...")
        print("NOTE: You may need to update the Allowed Return URLs in your")
        print("Security Profile to include: http://localhost:3000/callback")

    # Build authorization URL
    auth_params = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "scope": SCOPE,
        "response_type": "code",
        "redirect_uri": redirect_uri,
    })
    auth_url = f"{AUTH_URL}?{auth_params}"

    # Start local server
    server = http.server.HTTPServer(("localhost", 3000), OAuthCallbackHandler)

    if use_https:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_file, key_file)
        server.socket = context.wrap_socket(server.socket, server_side=True)

    print(f"\nOpening browser for Amazon login...")
    print(f"If browser doesn't open, visit this URL manually:\n")
    print(auth_url)
    print(f"\nWaiting for authorization callback on port 3000...")

    webbrowser.open(auth_url)

    # Wait for the callback
    while OAuthCallbackHandler.auth_code is None:
        server.handle_request()

    server.server_close()
    auth_code = OAuthCallbackHandler.auth_code
    print(f"\nAuthorization code received!")

    # Exchange code for tokens
    print("Exchanging code for refresh token...")
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": CLIENT_ID,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }, timeout=30)

    if resp.status_code != 200:
        print(f"\nError: {resp.status_code}")
        print(resp.text)
        sys.exit(1)

    tokens = resp.json()
    refresh_token = tokens.get("refresh_token", "")

    print("\n" + "=" * 60)
    print("  SUCCESS! Here are your tokens:")
    print("=" * 60)
    print(f"\nRefresh Token: {refresh_token}")
    print(f"\n(Access Token: {tokens.get('access_token', '')[:30]}...)")

    # Save to .env
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    save = input(f"\nSave to {env_path}? (yes/no): ").strip().lower()
    if save == "yes":
        env_content = f"""# Amazon Ads API Credentials
AMZN_ADS_CLIENT_ID={CLIENT_ID}
AMZN_ADS_CLIENT_SECRET={client_secret}
AMZN_ADS_REFRESH_TOKEN={refresh_token}
AMZN_ADS_REGION=eu
AMZN_ADS_MARKETPLACE=IN
AMZN_ADS_PROFILE_ID=
AMZN_ADS_TARGET_ACOS=25.0
AMZN_ADS_MAX_BID=50.0
AMZN_ADS_MIN_BID=1.0
"""
        with open(env_path, "w") as f:
            f.write(env_content)
        print(f"Saved to {env_path}")
        print("\nNext step: run 'python -m amazon_ads_tool profiles' to get your Profile ID")
    else:
        print("\nAdd this to your .env file:")
        print(f"  AMZN_ADS_REFRESH_TOKEN={refresh_token}")


if __name__ == "__main__":
    main()
