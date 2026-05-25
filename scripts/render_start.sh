#!/bin/sh
set -e

PORT="${PORT:-10000}"
echo "s57viewer: starting on 0.0.0.0:${PORT} (RENDER=${RENDER:-})"

python3 -c "import pyogrio; print('pyogrio', pyogrio.__version__)"

exec uvicorn server:app \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --timeout-keep-alive 75 \
  --log-level info
