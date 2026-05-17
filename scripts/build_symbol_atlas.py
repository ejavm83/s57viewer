#!/usr/bin/env python3
"""Extract OpenCPN raster symbol atlas entries from chartsymbols.xml."""

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XML_PATH = ROOT / "static" / "s57data" / "chartsymbols.xml"
OUT_PATH = ROOT / "static" / "s52-symbols.json"


def parse_symbols(xml_path: Path) -> dict:
    text = xml_path.read_text(encoding="utf-8", errors="replace")
    symbols: dict[str, dict] = {}

    for block in re.finditer(r"<symbol\b[^>]*>.*?</symbol>", text, re.DOTALL | re.IGNORECASE):
        frag = block.group(0)
        name_m = re.search(r"<name>([^<]+)</name>", frag, re.IGNORECASE)
        if not name_m:
            continue
        name = name_m.group(1).strip()
        if name in symbols:
            continue

        bm_m = re.search(
            r"<bitmap\s+width=\"(\d+)\"\s+height=\"(\d+)\">.*?<pivot\s+x=\"(\d+)\"\s+y=\"(\d+)\".*?<graphics-location\s+x=\"(\d+)\"\s+y=\"(\d+)\"",
            frag,
            re.DOTALL | re.IGNORECASE,
        )
        if not bm_m:
            continue

        w, h = int(bm_m.group(1)), int(bm_m.group(2))
        px, py = int(bm_m.group(3)), int(bm_m.group(4))
        gx, gy = int(bm_m.group(5)), int(bm_m.group(6))
        symbols[name] = {
            "w": w,
            "h": h,
            "px": px,
            "py": py,
            "x": gx,
            "y": gy,
            "anchor": [px / w if w else 0.5, 1.0 - (py / h if h else 0.5)],
        }

    return symbols


def main():
    if not XML_PATH.is_file():
        raise SystemExit(f"Missing {XML_PATH} — download OpenCPN data/s57data/chartsymbols.xml first")

    symbols = parse_symbols(XML_PATH)
    out = {
        "source": "OpenCPN chartsymbols.xml",
        "sprite": "/s57data/rastersymbols-day.png",
        "count": len(symbols),
        "symbols": symbols,
    }
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({len(symbols)} symbols)")
    for key in ("BOYLAT13", "BOYLAT14", "BCNLAT21", "LITDEF11", "WRECKS01", "OBSTRN11"):
        if key in symbols:
            print(f"  {key}: {symbols[key]}")


if __name__ == "__main__":
    main()
