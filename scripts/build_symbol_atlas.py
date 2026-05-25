#!/usr/bin/env python3
"""Extract OpenCPN raster symbol atlas entries from chartsymbols.xml."""

import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "static" / "s52-symbols.json"


def _chartsymbols_candidates() -> list[Path]:
    cands: list[Path] = []
    env_dir = (os.environ.get("OPENCPN_S57DATA") or "").strip()
    if env_dir:
        cands.append(Path(env_dir) / "chartsymbols.xml")
    env_xml = (os.environ.get("S52_CHARTSYMBOLS_XML") or "").strip()
    if env_xml:
        cands.append(Path(env_xml))
    cands.append(Path(r"C:\Program Files (x86)\OpenCPN\s57data\chartsymbols.xml"))
    cands.append(Path(r"C:\Program Files\OpenCPN\s57data\chartsymbols.xml"))
    cands.append(ROOT / "public" / "s57data" / "chartsymbols.xml")
    cands.append(ROOT / "static" / "s57data" / "chartsymbols.xml")
    return list(dict.fromkeys(cands))


def _find_chartsymbols_xml() -> Path:
    for p in _chartsymbols_candidates():
        if p.is_file():
            return p
    raise SystemExit(
        "chartsymbols.xml not found; run scripts/sync_opencpn_s57data.py or set "
        "OPENCPN_S57DATA / S52_CHARTSYMBOLS_XML."
    )


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
    xml_path = _find_chartsymbols_xml()
    symbols = parse_symbols(xml_path)
    out = {
        "source": str(xml_path),
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
