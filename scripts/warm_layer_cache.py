#!/usr/bin/env python3
"""Pre-read S-57 layers into CACHE_DIR for faster first /api/charts on cold deploys."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    import server

    root = server.DEFAULT_SAMPLE_DIR.resolve()
    print(f"Warming layer cache from {root} → {server.CACHE_DIR}")
    server.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    server._apply_chart_sources("default", root)
    if not server._iter_indexed_chart_files():
        print("No .000 chart files found.", file=sys.stderr)
        return 1

    server.build_chart_index()
    chart_count = len(server.chart_index)
    print(f"Indexed {chart_count} chart(s)")

    warmed = 0
    for name, info in sorted(server.chart_index.items()):
        path = info["path"]
        for layer in info["layers"]:
            server._load_layer_features(path, layer)
            warmed += 1
            if warmed % 50 == 0:
                print(f"  …{warmed} layer(s)")

    print(f"Warmed {warmed} layer cache file(s) for {chart_count} chart(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
