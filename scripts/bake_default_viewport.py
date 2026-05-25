#!/usr/bin/env python3
"""Bake default demo viewport GeoJSON for instant first paint (static/default-viewport.json)."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Match static/app.js
KOREA_FOCUS_BOUNDS = [118.0, 32.0, 132.0, 42.0]
VIEWPORT_FETCH_BUFFER = 0.22
DEFAULT_ZOOM = 7
BOOT_CACHE_VERSION = "1"

CATEGORIES = {
    "depth": ["DEPARE", "DEPCNT", "DRGARE", "SBDARE", "SEAARE"],
    "sounding": ["SOUNDG"],
    "light": ["LIGHTS", "FOGSIG"],
    "beacon": ["BCNCAR", "BCNISD", "BCNLAT", "BCNSAW", "BCNSPP", "RTPBCN", "TOPMAR"],
    "buoy": ["BOYCAR", "BOYISD", "BOYLAT", "BOYSAW", "BOYSPP"],
    "obstruction": ["OBSTRN", "UWTROC"],
    "wreck": ["WRECKS"],
    "land": ["LNDARE", "LNDMRK", "LNDELV", "LNDRGN", "LAKARE", "BUAARE", "RIVERS", "CANALS"],
    "coastline": ["COALNE", "SLCONS"],
    "traffic": [
        "RESARE", "TSSBND", "TSELNE", "ISTZNE", "TSSLPT", "TSSRON", "ACHBRT", "ACHARE",
    ],
    "navigation": [
        "DWRTPT", "TWRTPT", "FAIRWY", "FERYRT", "RDOCAL", "RDOSTA", "CTRPNT", "PILPNT", "PILBOP",
    ],
    "infrastructure": ["BRIDGE", "CBLOHD", "CBLSUB", "PIPSOL", "MORFAC", "DAMCON", "PONTON", "HULKES", "PYLONS"],
    "coverage": ["M_COVR", "M_QUAL"],
}


def expand_viewport_bounds(west: float, south: float, east: float, north: float) -> tuple[float, float, float, float]:
    span_lon = east - west
    span_lat = north - south
    pad_lon = span_lon * VIEWPORT_FETCH_BUFFER
    pad_lat = span_lat * VIEWPORT_FETCH_BUFFER
    return (
        west - pad_lon,
        south - pad_lat,
        east + pad_lon,
        north + pad_lat,
    )


def all_visible_layers() -> str:
    layers: list[str] = []
    for cat_layers in CATEGORIES.values():
        layers.extend(cat_layers)
    return ",".join(dict.fromkeys(layers))


def main() -> int:
    import server

    out_path = ROOT / "static" / "default-viewport.json"
    w, s, e, n = KOREA_FOCUS_BOUNDS
    west, south, east, north = expand_viewport_bounds(w, s, e, n)
    layers = all_visible_layers()
    zoom = DEFAULT_ZOOM

    print(f"Loading default sample from {server.DEFAULT_SAMPLE_DIR}…")
    server._apply_chart_sources("default", server.DEFAULT_SAMPLE_DIR.resolve())
    if not server._iter_indexed_chart_files():
        print("No .000 chart files in default sample directory.", file=sys.stderr)
        return 1
    server.build_chart_index()
    print(f"Indexed {len(server.chart_index)} chart(s)")
    server.s52_mariner_settings = server.compute_s52_settings_from_index()

    payload = server._build_charts_response(west, south, east, north, zoom, layers)
    feature_count = len(payload.get("features", []))
    print(f"Viewport features: {feature_count}")

    bundle = {
        "version": BOOT_CACHE_VERSION,
        "bounds": KOREA_FOCUS_BOUNDS,
        "viewport": {
            "west": west,
            "south": south,
            "east": east,
            "north": north,
            "zoom": zoom,
            "layers": layers,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data": payload,
    }

    out_path.write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"Wrote {out_path} ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
