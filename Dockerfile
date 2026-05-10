FROM python:3.12-slim

# Install minimal system tools needed before pip/playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Chromium and ALL its system dependencies automatically
RUN playwright install-deps chromium \
    && playwright install chromium

COPY app.py .
COPY templates/ templates/

EXPOSE 5000

CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "4", "--timeout", "120"]
