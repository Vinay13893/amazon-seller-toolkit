FROM python:3.12-slim

# System deps needed by Playwright Chromium (BSR fallback scraper)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python packages first (cached layer — only rebuilds when requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Chromium + all its OS libraries
RUN playwright install-deps chromium \
    && playwright install chromium

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
