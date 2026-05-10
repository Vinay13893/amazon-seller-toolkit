#!/bin/bash
# Setup script for Amazon Seller Toolkit on Oracle Cloud Ubuntu 22.04
set -e

echo "=== 1. System update ==="
sudo apt-get update && sudo apt-get upgrade -y

echo "=== 2. Create 2GB swap (needed for 1GB RAM instance) ==="
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

echo "=== 3. Install Python 3.11 + pip ==="
sudo apt-get install -y python3.11 python3.11-venv python3-pip

echo "=== 4. Install Playwright system dependencies ==="
sudo apt-get install -y \
    wget ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxrandr2 xdg-utils libxshmfence1 \
    libglu1-mesa libpango-1.0-0 libcairo2

echo "=== 5. Setup app directory ==="
sudo mkdir -p /opt/amazon-toolkit
sudo chown ubuntu:ubuntu /opt/amazon-toolkit

echo "=== 6. Create virtual environment ==="
cd /opt/amazon-toolkit
python3.11 -m venv venv
source venv/bin/activate

echo "=== 7. Install Python packages ==="
pip install --upgrade pip
pip install flask gunicorn requests beautifulsoup4 lxml playwright

echo "=== 8. Install Playwright Chromium ==="
playwright install chromium

echo "=== 9. Open firewall port 5000 ==="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5000 -j ACCEPT
sudo netfilter-persistent save

echo ""
echo "=== SETUP COMPLETE ==="
echo "Now upload app.py and templates/index.html, then start the service."
