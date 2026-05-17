#!/usr/bin/env python3
"""Parse IHO S-52 Presentation Library (.dai) into JSON for the web viewer."""

import colorsys
import json
import re
from pathlib import Path

SEP = "\x1f"
ROOT = Path(__file__).resolve().parent.parent
DAI_PATH = ROOT / "public" / "PresLib_e4.0.0.dai"
OUT_PATH = ROOT / "static" / "s52-preslib.json"


def hsl_to_hex(h: str, s: str, l: str) -> str:
    h_f, s_f, l_f = float(h), float(s), float(l) / 100.0
    r, g, b = colorsys.hls_to_rgb(h_f % 1.0, l_f, s_f)
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


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
                colors[m.group(1)] = hsl_to_hex(*m.groups()[1:])
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


if __name__ == "__main__":
    main()
