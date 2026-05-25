FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && python3 -c "import multipart; print('python-multipart OK')"

COPY server.py .
COPY scripts/ scripts/
COPY public/logo.svg public/
COPY public/PresLib_e4.0.0.dai public/
COPY sample_data/ sample_data/
COPY static/ static/

RUN chmod +x scripts/render_start.sh

ENV DEFAULT_SAMPLE_DIR=/app/sample_data/korea-regional
ENV CACHE_DIR=/app/cache
ENV SKIP_STARTUP_CHART_LOAD=1

RUN mkdir -p /app/cache \
    && python3 scripts/warm_layer_cache.py \
    && python3 scripts/bake_default_viewport.py

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','10000')+'/health')"

CMD ["scripts/render_start.sh"]
