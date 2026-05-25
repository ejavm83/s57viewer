#!/usr/bin/env python3
"""Copy OpenCPN `s57data` symbology assets into this repository.

OpenCPN ships IHO S-52-related files under ``<OpenCPN install>\\s57data\\`` (Windows).
This script mirrors that folder into ``public/s57data`` and ``static/s57data`` so the
web viewer uses the same ``chartsymbols.xml`` and raster symbol sheets as the desktop
app. OpenCPN itself is GPLv2 — keep ``COPYING.gplv2`` obligations in mind if you
redistribute these files.

Usage::

    python scripts/sync_opencpn_s57data.py
    python scripts/build_preslib.py

Environment::

    OPENCPN_S57DATA   Path to the ``s57data`` directory (optional; otherwise common
                      install paths are tried on Windows).
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ASSETS = (
    "chartsymbols.xml",
    "rastersymbols-day.png",
    "rastersymbols-dusk.png",
    "rastersymbols-dark.png",
    "attdecode.csv",
    "s57attributes.csv",
    "s57expectedinput.csv",
    "s57objectclasses.csv",
    "S52RAZDS.RLE",
)


def find_opencpn_s57data() -> Path:
    env = (os.environ.get("OPENCPN_S57DATA") or "").strip()
    if env:
        p = Path(env)
        if (p / "chartsymbols.xml").is_file():
            return p
        sys.exit(f"OPENCPN_S57DATA={env!r} does not contain chartsymbols.xml")
    for candidate in (
        Path(r"C:\Program Files (x86)\OpenCPN\s57data"),
        Path(r"C:\Program Files\OpenCPN\s57data"),
    ):
        if (candidate / "chartsymbols.xml").is_file():
            return candidate
    sys.exit(
        "OpenCPN s57data not found. Install OpenCPN or set OPENCPN_S57DATA to its "
        "'s57data' directory."
    )


def main() -> None:
    src = find_opencpn_s57data()
    dest_dirs = (
        ROOT / "public" / "s57data",
        ROOT / "static" / "s57data",
    )
    missing = [name for name in ASSETS if not (src / name).is_file()]
    if missing:
        sys.exit(f"Source {src} is missing files: {', '.join(missing)}")

    for d in dest_dirs:
        d.mkdir(parents=True, exist_ok=True)
        for name in ASSETS:
            shutil.copy2(src / name, d / name)
        print(f"Copied {len(ASSETS)} files from {src} -> {d}")

    print("Next: python scripts/build_preslib.py")


if __name__ == "__main__":
    main()
