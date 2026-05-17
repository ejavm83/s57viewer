#!/usr/bin/env python3
"""Parse IHO S-52 Presentation Library (.dai) into JSON for the web viewer."""

import json
import re
from pathlib import Path

SEP = "\x1f"
ROOT = Path(__file__).resolve().parent.parent
DAI_PATH = ROOT / "public" / "PresLib_e4.0.0.dai"
OUT_PATH = ROOT / "static" / "s52-preslib.json"


def xyY_to_hex(x: float, y: float, Y: float) -> str:
    """Convert S-52 CCIE xyY (x,y chromaticity + luminance 0–100) to sRGB hex."""
    if y < 1e-6:
        return "#000000"
    Yn = Y / 100.0
    X = x * Yn / y
    Z = (1.0 - x - y) * Yn / y
    r = 3.2406 * X + -1.5372 * Yn + -0.4986 * Z
    g = -0.9689 * X + 1.8758 * Yn + 0.0415 * Z
    b = 0.0557 * X + -0.2040 * Yn + 1.0570 * Z

    def gamma(v: float) -> float:
        v = max(0.0, min(1.0, v))
        return 12.92 * v if v <= 0.0031308 else 1.055 * (v ** (1.0 / 2.4)) - 0.055

    ri, gi, bi = int(gamma(r) * 255), int(gamma(g) * 255), int(gamma(b) * 255)
    return f"#{ri:02x}{gi:02x}{bi:02x}"


def parse_colors(text: str) -> dict:
    colors = {}
    in_day = False
    for line in text.split("\r\n"):
        if line.startswith("COLS") and "DAY" in line:
            in_day = True
            continue
        if line.startswith("COLS") and in_day:
            break
        if in_day and line.startswith("CCIE"):
            m = re.match(
                rf"CCIE\s+\d+([A-Z0-9]+)([\d.]+){re.escape(SEP)}([\d.]+){re.escape(SEP)}([\d.]+)",
                line,
            )
            if m:
                token = m.group(1)
                colors[token] = xyY_to_hex(float(m.group(2)), float(m.group(3)), float(m.group(4)))
    return colors


def parse_lookups(text: str) -> dict:
    lookups = {}
    for block in re.split(r"(?=LUPT\s+)", text):
        if not block.startswith("LUPT"):
            continue
        m = re.match(
            rf"LUPT\s+\d+(LU\d+)([A-Z]+)([A-Z]{{6}})([PLA])([A-Z0-9_]+){re.escape(SEP)}",
            block,
        )
        if not m:
            continue
        obj, geom, attrs = m.group(3), m.group(4), m.group(5)
        attc, inst, disc = [], "", ""
        am = re.search(r"ATTC\s+\d+(.*?)(?=INST)", block, re.DOTALL)
        if am:
            attc = [a for a in am.group(1).replace("\r\n", "").split(SEP) if a]
        im = re.search(rf"INST\s+\d+([^{re.escape(SEP)}]+)", block)
        if im:
            inst = im.group(1)
        dm = re.search(r"DISC\s+\d+([A-Z]+)", block)
        if dm:
            disc = dm.group(1)
        lookups.setdefault(obj, []).append(
            {"geom": geom, "attrs": attrs, "attc": attc, "inst": inst, "disc": disc}
        )
    return lookups


def main():
    text = DAI_PATH.read_bytes().decode("latin-1", errors="replace")
    out = {
        "version": "4.0.0",
        "palette": "DAY",
        "source": DAI_PATH.name,
        "colors": parse_colors(text),
        "lookups": parse_lookups(text),
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes, {len(out['lookups'])} objects)")
    for t in ("DEPDW0", "DEPMD0", "LANDA0", "CHGRN0", "CHRED0"):
        print(f"  {t}: {out['colors'].get(t)}")


if __name__ == "__main__":
    main()
