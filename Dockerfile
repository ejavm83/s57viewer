FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY server.py .
COPY scripts/ scripts/
COPY public/ public/
COPY sample_data/ sample_data/
COPY static/ static/

ENV DEFAULT_SAMPLE_DIR=/app/sample_data/korea-regional

ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-10000}"]
