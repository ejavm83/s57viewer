#!/usr/bin/env python3
"""Parse the OpenCPN/IHO S-52 presentation library (`chartsymbols.xml`) into a
self-contained JSON consumed by the web renderer.

The output bundles everything the JS renderer needs to honour the standard:

* All five day/dusk/night color palettes
* Plain + Symbolized lookups (with `disp-prio`, `radar-prio`, `display-cat`,
  attribute filters, instruction strings)
* Pattern / line-style / symbol vector definitions (HPGL preserved verbatim
  for client-side canvas rendering) plus their raster atlas coordinates
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XML_SOURCES = [
    ROOT / "public" / "s57data" / "chartsymbols.xml",
    ROOT / "static" / "s57data" / "chartsymbols.xml",
]
PRESLIB_OUT = ROOT / "static" / "s52-preslib.json"
SYMBOL_ATLAS_OUT = ROOT / "static" / "s52-symbols.json"

PALETTE_FILES = {
    "DAY_BRIGHT": "/s57data/rastersymbols-day.png",
    "DAY_BLACKBACK": "/s57data/rastersymbols-day.png",
    "DAY_WHITEBACK": "/s57data/rastersymbols-day.png",
    "DUSK": "/s57data/rastersymbols-dusk.png",
    "NIGHT": "/s57data/rastersymbols-dark.png",
}

# All ENC display tables from chartsymbols.xml (Lines = line geometry rules
# such as TSELNE/TSSBND; Paper = detailed point symbology for lights, etc.).
KEEP_TABLES = {"Plain", "Symbolized", "Simplified", "Lines", "Paper"}


def find_source() -> Path:
    for path in XML_SOURCES:
        if path.is_file():
            return path
    raise SystemExit(
        f"chartsymbols.xml not found; checked: {', '.join(str(p) for p in XML_SOURCES)}"
    )


def hex_color(r: str, g: str, b: str) -> str:
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def parse_color_tables(root: ET.Element) -> dict:
    """Return `{palette: {COLOR0: '#rrggbb', ...}}`.

    Token names are stored with the trailing `0` suffix the renderer uses
    (matches the `dai`-derived naming convention).
    """
    palettes: dict[str, dict[str, str]] = {}
    for tbl in root.findall("color-tables/color-table"):
        name = tbl.get("name")
        if not name:
            continue
        colors = {}
        for c in tbl.findall("color"):
            cname = c.get("name")
            if not cname:
                continue
            colors[f"{cname}0"] = hex_color(c.get("r"), c.get("g"), c.get("b"))
        palettes[name] = colors
    return palettes


def parse_lookups(root: ET.Element) -> dict:
    """Group lookups by S-57 object class.

    Each entry retains the geometry (`P`/`L`/`A`), display priority, radar
    priority, table name, attribute filters and the instruction string – the
    same fields the renderer evaluates.
    """
    geom_map = {"Point": "P", "Line": "L", "Area": "A"}
    prio_map = {
        "No data": 0,
        "Group 1": 1,
        "Area 1": 2,
        "Area 2": 3,
        "Point Symbol": 4,
        "Line Symbol": 5,
        "Area Symbol": 6,
        "Routing": 7,
        "Hazards": 8,
        "Mariners": 9,
    }
    lookups: dict[str, list] = {}

    for lp in root.findall("lookups/lookup"):
        name = lp.get("name") or ""
        if not name or name.startswith("#"):
            continue
        table = (lp.findtext("table-name") or "").strip()
        if KEEP_TABLES and table not in KEEP_TABLES:
            continue
        gtype = geom_map.get((lp.findtext("type") or "").strip())
        if not gtype:
            continue
        attrs = [
            (a.text or "").strip()
            for a in lp.findall("attrib-code")
            if (a.text or "").strip()
        ]
        instr = (lp.findtext("instruction") or "").strip()
        disp_prio = (lp.findtext("disp-prio") or "Point Symbol").strip()
        radar_prio = (lp.findtext("radar-prio") or "On Top").strip()
        disp_cat = (lp.findtext("display-cat") or "Standard").strip() or "Standard"
        comment = (lp.findtext("comment") or "").strip()
        lookups.setdefault(name, []).append(
            {
                "geom": gtype,
                "table": table,
                "attc": attrs,
                "inst": instr,
                "disp": disp_cat,
                "prio": prio_map.get(disp_prio, 4),
                "radar": 1 if radar_prio == "On Top" else 0,
                "comment": comment,
            }
        )
    return lookups


def parse_vector_box(elem: ET.Element | None) -> dict | None:
    if elem is None:
        return None
    dist = elem.find("distance")
    dmin = int(dist.get("min", 0) or 0) if dist is not None else 0
    dmax = int(dist.get("max", 0) or 0) if dist is not None else 0
    return {
        "w": int(elem.get("width", 0)),
        "h": int(elem.get("height", 0)),
        "pivot": _xy(elem.find("pivot")),
        "origin": _xy(elem.find("origin")),
        "min": dmin,
        "max": dmax,
    }


def _xy(elem: ET.Element | None) -> list[int] | None:
    if elem is None:
        return None
    try:
        return [int(elem.get("x", 0)), int(elem.get("y", 0))]
    except (TypeError, ValueError):
        return None


def parse_bitmap(elem: ET.Element | None) -> dict | None:
    if elem is None:
        return None
    w = int(elem.get("width", 0))
    h = int(elem.get("height", 0))
    pivot = _xy(elem.find("pivot")) or [w // 2, h // 2]
    origin = _xy(elem.find("origin")) or [0, 0]
    gloc = _xy(elem.find("graphics-location")) or [0, 0]
    anchor = [
        (pivot[0] / w) if w else 0.5,
        1.0 - ((pivot[1] / h) if h else 0.5),
    ]
    return {
        "w": w,
        "h": h,
        "px": pivot[0],
        "py": pivot[1],
        "ox": origin[0],
        "oy": origin[1],
        "x": gloc[0],
        "y": gloc[1],
        "anchor": anchor,
    }


def parse_glyph(elem: ET.Element, kind: str) -> dict | None:
    """Common parser for `<symbol>` / `<pattern>` / `<line-style>` entries."""
    name = (elem.findtext("name") or "").strip()
    if not name:
        return None
    bitmap = parse_bitmap(elem.find("bitmap"))
    vector_elem = elem.find("vector")
    vector_box = parse_vector_box(vector_elem)
    hpgl_text = None
    if vector_elem is not None:
        # Symbol HPGL lives inside <vector>; pattern/line-style at root.
        hpgl_text = (vector_elem.findtext("HPGL") or elem.findtext("HPGL") or "").strip()
    if not hpgl_text:
        hpgl_text = (elem.findtext("HPGL") or "").strip()
    color_ref = (elem.findtext("color-ref") or "").strip()
    out: dict = {
        "kind": kind,
        "definition": (elem.findtext("definition") or "V").strip() or "V",
        "color_ref": color_ref,
    }
    if bitmap:
        out["bitmap"] = bitmap
    if vector_box:
        out["vector"] = vector_box
    if hpgl_text:
        out["hpgl"] = hpgl_text
    if kind == "pattern":
        out["filltype"] = (elem.findtext("filltype") or "S").strip()
        out["spacing"] = (elem.findtext("spacing") or "C").strip()
    return name, out


def parse_glyph_group(root: ET.Element, container: str, child: str, kind: str) -> dict:
    glyphs: dict[str, dict] = {}
    for el in root.findall(f"{container}/{child}"):
        parsed = parse_glyph(el, kind)
        if not parsed:
            continue
        name, payload = parsed
        glyphs[name] = payload
    return glyphs


def build_symbol_atlas(symbols: dict) -> dict:
    """Subset symbol metadata for the legacy raster atlas consumer."""
    out: dict[str, dict] = {}
    for name, entry in symbols.items():
        bm = entry.get("bitmap")
        if not bm:
            continue
        out[name] = {
            "w": bm["w"],
            "h": bm["h"],
            "px": bm["px"],
            "py": bm["py"],
            "x": bm["x"],
            "y": bm["y"],
            "anchor": bm["anchor"],
        }
    return out


def main() -> None:
    src = find_source()
    tree = ET.parse(src)
    root = tree.getroot()

    palettes = parse_color_tables(root)
    lookups = parse_lookups(root)
    line_styles = parse_glyph_group(root, "line-styles", "line-style", "line")
    patterns = parse_glyph_group(root, "patterns", "pattern", "pattern")
    symbols = parse_glyph_group(root, "symbols", "symbol", "symbol")

    bundle = {
        "version": "OpenCPN-S52-PresLib",
        "source": str(src.relative_to(ROOT)).replace("\\", "/"),
        "palettes": palettes,
        "palette_sprites": PALETTE_FILES,
        "default_palette": "DAY_BRIGHT",
        "lookups": lookups,
        "line_styles": line_styles,
        "patterns": patterns,
        "symbols": symbols,
    }

    PRESLIB_OUT.write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")
    atlas = {
        "source": str(src.relative_to(ROOT)).replace("\\", "/"),
        "sprite": PALETTE_FILES["DAY_BRIGHT"],
        "sprites": PALETTE_FILES,
        "count": len(atlas_entries := build_symbol_atlas(symbols)),
        "symbols": atlas_entries,
    }
    SYMBOL_ATLAS_OUT.write_text(json.dumps(atlas, separators=(",", ":")), encoding="utf-8")

    print(f"Source: {src}")
    print(
        f"Lookups: {sum(len(v) for v in lookups.values())} rules across {len(lookups)} object classes"
    )
    print(
        f"Symbols: {len(symbols)} (with bitmap: {sum(1 for s in symbols.values() if s.get('bitmap'))})"
    )
    print(f"Patterns: {len(patterns)}   Line-styles: {len(line_styles)}")
    print(f"Palettes: {', '.join(palettes)}")
    print(f"Wrote {PRESLIB_OUT} ({PRESLIB_OUT.stat().st_size:,} bytes)")
    print(f"Wrote {SYMBOL_ATLAS_OUT} ({SYMBOL_ATLAS_OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
