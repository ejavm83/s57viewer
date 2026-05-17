import os
import json
import math
import struct
import hashlib
import shutil
import time
import asyncio
from datetime import date
from pathlib import Path
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, Query, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

import pyogrio
from pyogrio.raw import read as ogr_read

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

VIEWPORT_PAD_RATIO = 0.08
MAX_FEATURES_RESPONSE = 100_000
SOUNDG_MAX_BY_ZOOM: dict[int, int | None] = {
    9: 2500,
    10: 6000,
    11: 15_000,
    12: 30_000,
    13: 50_000,
    14: 80_000,
}

S57_DIR: Path | None = Path(os.environ["S57_DIR"]) if os.environ.get("S57_DIR") else None
CACHE_DIR = Path(os.environ.get("CACHE_DIR", Path(__file__).parent / "cache"))
SAMPLE_DATA_DIR = Path(os.environ.get("SAMPLE_DATA_DIR", Path(__file__).parent / "sample_data"))


def _dir_has_charts(root: Path) -> bool:
    return root.is_dir() and any(root.rglob("*.000"))


def _resolve_default_sample_dir() -> Path:
    """Prefer the small bundled demo set (korea-regional) over the full public/sample ENC."""
    base = Path(__file__).parent
    regional = base / "sample_data" / "korea-regional"
    if _dir_has_charts(regional):
        return regional
    legacy = base / "public" / "sample"
    if _dir_has_charts(legacy):
        return legacy
    return regional


DEFAULT_SAMPLE_DIR = (
    Path(os.environ["DEFAULT_SAMPLE_DIR"])
    if os.environ.get("DEFAULT_SAMPLE_DIR")
    else _resolve_default_sample_dir()
)
UPLOAD_DIR = CACHE_DIR / "uploads"
chart_source_dirs: list[Path] = []
datasource_mode: str = "default"
CACHE_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)
VIEWPORT_RESPONSE_DIR = CACHE_DIR / "viewport_responses"
VIEWPORT_RESPONSE_DIR.mkdir(exist_ok=True)
_CHARTS_POOL = ThreadPoolExecutor(
    max_workers=min(8, (os.cpu_count() or 4)),
    thread_name_prefix="s57charts",
)
_LAYER_POOL = ThreadPoolExecutor(
    max_workers=min(6, (os.cpu_count() or 4)),
    thread_name_prefix="s57layer",
)

_datasource_lock = Lock()
_load_progress_lock = Lock()
_visitors_lock = Lock()

_load_progress: dict = {
    "status": "idle",
    "phase": "",
    "current": 0,
    "total": 0,
    "message": "",
    "percent": 0,
    "error": None,
    "result": None,
}
VISITORS_FILE = CACHE_DIR / "visitors.json"

FEATURE_LAYERS = [
    "DEPARE", "DEPCNT", "DRGARE", "LNDARE", "COALNE", "SOUNDG",
    "LIGHTS", "BOYCAR", "BOYISD", "BOYLAT", "BOYSAW", "BOYSPP",
    "BCNCAR", "BCNISD", "BCNLAT", "BCNSAW", "BCNSPP",
    "OBSTRN", "UWTROC", "WRECKS",
    "SEAARE", "LAKARE", "BRIDGE", "SLCONS",
    "TOPMAR", "LNDMRK", "LNDELV", "LNDRGN",
    "FERYRT", "RDOSTA", "PILPNT", "PILBOP", "FOGSIG",
    "CBLOHD", "CBLSUB", "PIPSOL",
    "MORFAC", "DAMCON", "PONTON", "HULKES", "PYLONS",
    "ACHBRT", "ACHARE", "CTRPNT", "FSHFAC", "MARCUL",
    "DWRTPT", "TWRTPT", "RTPBCN", "RDOCAL",
    "UNSARE", "SBDARE", "WEDKLP", "BUAARE",
    "FAIRWY", "RIVERS", "CANALS",
    "RESARE", "TSSBND", "TSELNE", "ISTZNE", "TSSLPT", "TSSRON",
    "M_COVR", "M_QUAL",
]

DISPLAY_CATEGORIES = {
    "depth": ["DEPARE", "DEPCNT", "SBDARE"],
    "sounding": ["SOUNDG"],
    "light": ["LIGHTS", "FOGSIG"],
    "beacon": ["BCNCAR", "BCNISD", "BCNLAT", "RTPBCN", "TOPMAR"],
    "buoy": ["BOYISD", "BOYLAT", "BOYSAW", "BOYSPP"],
    "obstruction": ["OBSTRN", "UWTROC"],
    "wreck": ["WRECKS"],
    "land": ["LNDARE", "LNDMRK", "LNDELV", "LNDRGN", "LAKARE"],
    "coastline": ["COALNE", "SLCONS"],
    "navigation": ["DWRTPT", "TWRTPT", "FERYRT", "RDOCAL", "RDOSTA", "ACHBRT", "CTRPNT",
                   "PILPNT", "PILBOP", "RESARE", "TSSBND", "TSELNE", "ISTZNE"],
    "infrastructure": ["BRIDGE", "CBLOHD", "CBLSUB", "PIPSOL", "MORFAC", "DAMCON", "PONTON", "PYLONS"],
    "coverage": ["M_COVR", "M_QUAL"],
}

chart_index: dict = {}
s52_mariner_settings: dict = {
    "shallowContour": 2,
    "safetyContour": 3,
    "deepContour": 6,
    "safetyDepth": 3,
    "source": "default",
}
last_load_report: dict | None = None

SCALE_BAND_LABELS = {
    1: "1:3,500,000 (Ocean)",
    2: "1:700,000 (Coastal)",
    3: "1:180,000 (Approach)",
    4: "1:90,000 (Coastal detail)",
    5: "1:22,000 (Harbour approach)",
    6: "1:12,000 (Harbour)",
}

# Nominal display scale denominator per map zoom (matches static/app.js).
ZOOM_TO_SCALE_DENOM = {
    4: 50_000_000, 5: 25_000_000, 6: 10_000_000,
    7: 5_000_000, 8: 3_500_000, 9: 700_000,
    10: 350_000, 11: 180_000, 12: 90_000,
    13: 45_000, 14: 22_000, 15: 12_000,
    16: 6_000, 17: 3_000, 18: 1_500,
}

# Nominal compilation scale per ENC band (KR1xx = band 1, KR2xx = band 2, …).
SCALE_BAND_NOMINAL_DENOM = {
    1: 3_500_000,
    2: 700_000,
    3: 180_000,
    4: 90_000,
    5: 22_000,
    6: 12_000,
}

# Bump when chart quilting / viewport response shape changes (invalidates disk cache).
CHARTS_API_VERSION = 2


def _primary_scale_band_for_zoom(zoom: int) -> int:
    """Map view zoom to the ENC compilation band that best matches its nominal scale."""
    denom = ZOOM_TO_SCALE_DENOM.get(zoom, 90_000)
    best_band = 1
    best_diff = float("inf")
    for band, nominal in SCALE_BAND_NOMINAL_DENOM.items():
        diff = abs(nominal - denom)
        if diff < best_diff:
            best_diff = diff
            best_band = band
    return best_band


def _target_scale_bands_for_zoom(zoom: int) -> list[int]:
    """ENC quilting: one band coarser through two finer than the view's primary band."""
    primary = _primary_scale_band_for_zoom(zoom)
    lo = max(1, primary - 1)
    hi = min(6, primary + 2)
    return list(range(lo, hi + 1))

LAYER_CACHE_VERSION = 2

GLOBAL_S57_ATTRS = ("SCAMIN", "SCAMAX", "QUAPOS")


class DatasourcePath(BaseModel):
    path: str
    mode: str = "replace"


def find_chart_files(root: Path) -> list[Path]:
    return sorted(root.rglob("*.000"))


def _normalize_load_mode(mode: str | None) -> str:
    if mode in ("add", "replace", "default"):
        return mode
    return "replace"


def _source_label(root: Path) -> str:
    try:
        if root.resolve() == DEFAULT_SAMPLE_DIR.resolve():
            return "sample"
    except OSError:
        pass
    return root.name or "user"


def _resolve_chart_sources(mode: str, user_root: Path | None) -> list[Path]:
    default = DEFAULT_SAMPLE_DIR.resolve()
    if mode == "default":
        return [default]
    if user_root is None:
        return [default]
    user_root = user_root.resolve()
    if mode == "add":
        if user_root == default:
            return [default]
        return [default, user_root]
    return [user_root]


def _apply_chart_sources(mode: str, user_root: Path | None) -> None:
    global chart_source_dirs, S57_DIR, datasource_mode

    mode = _normalize_load_mode(mode)
    chart_source_dirs = _resolve_chart_sources(mode, user_root)
    datasource_mode = mode

    if mode == "add" and user_root is not None and len(chart_source_dirs) > 1:
        S57_DIR = user_root.resolve()
    elif mode == "replace" and user_root is not None:
        S57_DIR = user_root.resolve()
    else:
        S57_DIR = DEFAULT_SAMPLE_DIR.resolve()


def _iter_indexed_chart_files() -> list[tuple[str, Path]]:
    """Return (chart_key, absolute_path) for all configured sources."""
    items: list[tuple[str, Path]] = []
    for root in chart_source_dirs:
        if not root.is_dir():
            continue
        label = _source_label(root)
        multi = len(chart_source_dirs) > 1
        for fpath in find_chart_files(root):
            rel = fpath.relative_to(root).as_posix()
            key = f"{label}/{rel}" if multi else rel
            items.append((key, fpath.resolve()))
    return items


def _format_datasource_paths() -> str | None:
    if not chart_source_dirs:
        return None
    if len(chart_source_dirs) == 1:
        return str(chart_source_dirs[0])
    labels = [_source_label(p) for p in chart_source_dirs]
    return " + ".join(f"{label} ({p})" for label, p in zip(labels, chart_source_dirs))


def _load_sample_manifest() -> list[dict]:
    manifest_path = SAMPLE_DATA_DIR / "manifest.json"
    if not manifest_path.is_file():
        return []
    try:
        with open(manifest_path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("sets", []) if isinstance(data, dict) else []
    except (json.JSONDecodeError, OSError):
        return []


def list_sample_datasets() -> list[dict]:
    """Bundled chart sets: default public/sample plus optional SAMPLE_DATA_DIR sets."""
    samples: list[dict] = []
    if DEFAULT_SAMPLE_DIR.is_dir():
        chart_count = len(find_chart_files(DEFAULT_SAMPLE_DIR))
        if chart_count > 0:
            samples.append({
                "id": "default",
                "name": f"Default sample ({DEFAULT_SAMPLE_DIR.name})",
                "description": "Bundled ENC — auto-loaded on startup",
                "chart_count": chart_count,
                "available": True,
                "is_default": True,
            })

    entries: dict[str, dict] = {}
    for item in _load_sample_manifest():
        sample_id = item.get("id")
        if sample_id:
            entries[str(sample_id)] = dict(item)

    if SAMPLE_DATA_DIR.is_dir():
        for child in sorted(SAMPLE_DATA_DIR.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            chart_count = len(find_chart_files(child))
            if chart_count == 0:
                continue
            if child.name not in entries:
                entries[child.name] = {
                    "id": child.name,
                    "name": child.name,
                    "description": "Bundled sample charts",
                }
            meta = entries[child.name]
            meta["chart_count"] = chart_count
            meta["available"] = True
            meta["path"] = str(child.resolve())

    for sample_id, meta in entries.items():
        if sample_id == "default":
            continue
        root = SAMPLE_DATA_DIR / sample_id
        chart_count = meta.get("chart_count") or (
            len(find_chart_files(root)) if root.is_dir() else 0
        )
        samples.append({
            "id": sample_id,
            "name": meta.get("name", sample_id),
            "description": meta.get("description", ""),
            "region": meta.get("region"),
            "chart_count": chart_count,
            "available": chart_count > 0,
        })
    samples.sort(key=lambda s: (not s.get("is_default"), s["id"]))
    return samples


def resolve_sample_path(sample_id: str) -> Path | None:
    if sample_id in ("default", "bundled"):
        root = DEFAULT_SAMPLE_DIR.resolve()
        return root if root.is_dir() and find_chart_files(root) else None
    if not sample_id or ".." in sample_id or "/" in sample_id or "\\" in sample_id:
        return None
    root = (SAMPLE_DATA_DIR / sample_id).resolve()
    try:
        root.relative_to(SAMPLE_DATA_DIR.resolve())
    except ValueError:
        return None
    if not root.is_dir():
        return None
    if not find_chart_files(root):
        return None
    return root


def index_cache_path() -> Path | None:
    if not chart_source_dirs:
        return None
    key_src = "|".join(str(p.resolve()) for p in chart_source_dirs)
    key = hashlib.md5(key_src.encode()).hexdigest()[:16]
    return CACHE_DIR / f"chart_index_{key}.json"


def combined_bounds(entries: dict) -> list[float] | None:
    if not entries:
        return None
    west = south = float("inf")
    east = north = float("-inf")
    for info in entries.values():
        b = info["bounds"]
        west = min(west, b[0])
        south = min(south, b[1])
        east = max(east, b[2])
        north = max(north, b[3])
    return [west, south, east, north]


def _chart_display_name(chart_key: str) -> str:
    return Path(chart_key.replace("\\", "/")).name


def _layer_frequency(entries: dict, limit: int = 12) -> list[dict]:
    freq: dict[str, int] = {}
    for info in entries.values():
        for layer in info.get("layers", []):
            freq[layer] = freq.get(layer, 0) + 1
    ranked = sorted(freq.items(), key=lambda x: (-x[1], x[0]))
    return [{"layer": name, "charts": count} for name, count in ranked[:limit]]


def _build_load_report(
    *,
    files_found: int,
    indexed: list[dict],
    failed: list[dict],
    from_cache: bool,
    duration_sec: float | None = None,
) -> dict:
    indexed_ok = len(indexed)
    failed_count = len(failed)
    scale_counts = {}
    for item in indexed:
        band = str(item["scale"])
        scale_counts[band] = scale_counts.get(band, 0) + 1

    layer_counts = [item["layer_count"] for item in indexed]
    summary = {
        "files_found": files_found,
        "indexed_ok": indexed_ok,
        "indexed_failed": failed_count,
        "from_cache": from_cache,
        "duration_sec": round(duration_sec, 2) if duration_sec is not None else None,
        "scale_bands": {
            band: {
                "count": scale_counts.get(band, 0),
                "label": SCALE_BAND_LABELS.get(int(band), f"Band {band}"),
            }
            for band in sorted(scale_counts.keys(), key=int)
        },
        "bounds": combined_bounds(chart_index),
        "layers_per_chart": {
            "min": min(layer_counts) if layer_counts else 0,
            "max": max(layer_counts) if layer_counts else 0,
            "avg": round(sum(layer_counts) / len(layer_counts), 1) if layer_counts else 0,
        },
        "top_layers": _layer_frequency(chart_index),
    }
    return {
        "generated_at": time.time(),
        "path": _format_datasource_paths(),
        "paths": [str(p) for p in chart_source_dirs],
        "mode": datasource_mode,
        "summary": summary,
        "indexed": indexed,
        "failed": failed,
    }


def _finalize_load_report(
    files_found: int,
    indexed_entries: list[dict],
    failed_entries: list[dict],
    *,
    from_cache: bool,
    started_at: float | None = None,
) -> dict:
    global last_load_report
    duration = (time.time() - started_at) if started_at else None
    last_load_report = _build_load_report(
        files_found=files_found,
        indexed=indexed_entries,
        failed=failed_entries,
        from_cache=from_cache,
        duration_sec=duration,
    )
    return last_load_report


def datasource_payload() -> dict:
    bounds = combined_bounds(chart_index)
    payload = {
        "loaded": len(chart_index) > 0,
        "path": _format_datasource_paths(),
        "paths": [str(p) for p in chart_source_dirs],
        "mode": datasource_mode,
        "default_sample_dir": str(DEFAULT_SAMPLE_DIR.resolve()),
        "includes_default_sample": any(
            p.resolve() == DEFAULT_SAMPLE_DIR.resolve() for p in chart_source_dirs
        ),
        "chart_count": len(chart_index),
        "bounds": bounds,
    }
    if last_load_report:
        payload["report"] = {
            "summary": last_load_report["summary"],
            "generated_at": last_load_report["generated_at"],
        }
    payload["s52_settings"] = s52_mariner_settings
    return payload


def _pick_folder_dialog() -> tuple[str | None, str | None]:
    """Return (path, cancel_reason). cancel_reason is set when no path was chosen."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return None, "no_dialog"

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    path = filedialog.askdirectory(title="Select ENC folder (S-57 .000 files)")
    root.destroy()
    if path:
        return path, None
    return None, "cancelled"


def _progress_snapshot() -> dict:
    with _load_progress_lock:
        snap = {
            "status": _load_progress["status"],
            "phase": _load_progress["phase"],
            "current": _load_progress["current"],
            "total": _load_progress["total"],
            "message": _load_progress["message"],
            "percent": _load_progress["percent"],
            "error": _load_progress["error"],
        }
        if _load_progress["status"] == "done" and _load_progress["result"] is not None:
            snap["result"] = _load_progress["result"]
        return snap


def _set_load_progress(
    phase: str,
    current: int = 0,
    total: int = 0,
    message: str = "",
    *,
    status: str | None = None,
    error: str | None = None,
    result: dict | None = None,
) -> None:
    with _load_progress_lock:
        if status is not None:
            _load_progress["status"] = status
        _load_progress["phase"] = phase
        _load_progress["current"] = current
        _load_progress["total"] = total
        _load_progress["message"] = message
        if total > 0:
            _load_progress["percent"] = min(100, int(100 * current / total))
        elif status == "done":
            _load_progress["percent"] = 100
        elif phase in ("scan", "cache"):
            _load_progress["percent"] = 0
        if error is not None:
            _load_progress["error"] = error
        if result is not None:
            _load_progress["result"] = result


def _datasource_result_payload() -> dict:
    payload = datasource_payload()
    if last_load_report:
        payload["report"] = last_load_report
    return payload


def _load_datasource_worker(root: Path | None, mode: str = "replace") -> None:
    global chart_index

    try:
        mode = _normalize_load_mode(mode)
        if mode == "default":
            root = DEFAULT_SAMPLE_DIR.resolve()
        elif root is not None:
            root = root.resolve()
            if not root.is_dir():
                raise ValueError(f"Not a directory: {root}")
        else:
            raise ValueError("No chart folder specified.")

        _set_load_progress("scan", 0, 0, "Scanning for .000 chart files…", status="running")
        _apply_chart_sources(mode, root)
        chart_files = _iter_indexed_chart_files()
        if not chart_files:
            raise ValueError("No .000 chart files found in the configured data source(s).")

        clear_viewport_response_cache()
        chart_index = {}
        build_chart_index(on_progress=_index_progress_callback)

        result = _datasource_result_payload()
        mode_label = {"default": "default sample", "add": "added to sample", "replace": "replaced"}[mode]
        _set_load_progress(
            "done",
            len(chart_index),
            len(chart_index),
            f"Ready — {len(chart_index)} chart(s) ({mode_label})",
            status="done",
            result=result,
        )
    except Exception as exc:
        _set_load_progress(
            "error",
            0,
            0,
            str(exc),
            status="error",
            error=str(exc),
        )


def _index_progress_callback(current: int, total: int, message: str) -> None:
    _set_load_progress("index", current, total, message)


def _start_datasource_load(
    root: Path | None,
    *,
    mode: str = "replace",
    already_running: bool = False,
) -> None:
    with _load_progress_lock:
        if not already_running:
            if _load_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Chart data is already loading.")
            _load_progress["status"] = "running"
            _load_progress["error"] = None
            _load_progress["result"] = None
            _load_progress["percent"] = 0

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _load_datasource_worker, root, mode)


def set_datasource(root: Path, mode: str = "replace") -> dict:
    """Synchronous load (startup / env). For UI loads use background worker + progress API."""
    global chart_index

    root = root.resolve()
    if not root.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {root}")

    _apply_chart_sources(_normalize_load_mode(mode), root)
    if not _iter_indexed_chart_files():
        raise HTTPException(
            status_code=400,
            detail="No .000 chart files found in the configured data source(s).",
        )

    with _datasource_lock:
        clear_viewport_response_cache()
        chart_index = {}
        build_chart_index()

    return _datasource_result_payload()


def parse_wkb_point(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    wkb_type = struct.unpack(f"{bo}I", wkb[1:5])[0]
    base_type = wkb_type & 0xFF
    has_z = (wkb_type & 0x80000000) or (wkb_type >= 1000 and wkb_type < 2000)
    if base_type == 1 and has_z and len(wkb) >= 29:
        x, y, z = struct.unpack(f"{bo}ddd", wkb[5:29])
        return {"type": "Point", "coordinates": [round(x, 7), round(y, 7), round(z, 2)]}
    elif base_type == 1:
        x, y = struct.unpack(f"{bo}dd", wkb[5:21])
        return {"type": "Point", "coordinates": [round(x, 7), round(y, 7)]}
    return None


def parse_wkb_linestring(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    n_points = struct.unpack(f"{bo}I", wkb[5:9])[0]
    coords = []
    offset = 9
    for _ in range(n_points):
        x, y = struct.unpack(f"{bo}dd", wkb[offset:offset + 16])
        coords.append([round(x, 7), round(y, 7)])
        offset += 16
    return {"type": "LineString", "coordinates": coords}


def parse_wkb_polygon(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    n_rings = struct.unpack(f"{bo}I", wkb[5:9])[0]
    rings = []
    offset = 9
    for _ in range(n_rings):
        n_points = struct.unpack(f"{bo}I", wkb[offset:offset + 4])[0]
        offset += 4
        ring = []
        for _ in range(n_points):
            x, y = struct.unpack(f"{bo}dd", wkb[offset:offset + 16])
            ring.append([round(x, 7), round(y, 7)])
            offset += 16
        rings.append(ring)
    return {"type": "Polygon", "coordinates": rings}


def parse_wkb_multipoint(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    wkb_type = struct.unpack(f"{bo}I", wkb[1:5])[0]
    n_geoms = struct.unpack(f"{bo}I", wkb[5:9])[0]
    points = []
    offset = 9
    for _ in range(n_geoms):
        sub_bo = "<" if wkb[offset] == 1 else ">"
        sub_type = struct.unpack(f"{sub_bo}I", wkb[offset + 1:offset + 5])[0]
        sub_base = sub_type & 0xFF
        has_z = (sub_type & 0x80000000) or (sub_type >= 1000 and sub_type < 2000)
        if sub_base == 1 and has_z:
            x, y, z = struct.unpack(f"{sub_bo}ddd", wkb[offset + 5:offset + 29])
            points.append([round(x, 7), round(y, 7), round(z, 2)])
            offset += 29
        elif sub_base == 1:
            x, y = struct.unpack(f"{sub_bo}dd", wkb[offset + 5:offset + 21])
            points.append([round(x, 7), round(y, 7)])
            offset += 21
        else:
            break
    if wkb_type in (1004, 0x80000004):
        return {"type": "MultiPoint", "coordinates": points}
    return {"type": "MultiPoint", "coordinates": points}


def parse_wkb(wkb: bytes):
    if wkb is None or len(wkb) < 5:
        return None
    bo = "<" if wkb[0] == 1 else ">"
    wkb_type = struct.unpack(f"{bo}I", wkb[1:5])[0]
    base_type = wkb_type & 0xFF
    try:
        if base_type == 1:
            return parse_wkb_point(wkb)
        elif base_type == 2:
            return parse_wkb_linestring(wkb)
        elif base_type == 3:
            return parse_wkb_polygon(wkb)
        elif base_type == 4:
            return parse_wkb_multipoint(wkb)
        elif base_type == 5:
            return parse_wkb_multilinestring(wkb)
        elif base_type == 6:
            return parse_wkb_multipolygon(wkb)
    except Exception:
        pass
    return None


def parse_wkb_multilinestring(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    n_geoms = struct.unpack(f"{bo}I", wkb[5:9])[0]
    lines = []
    offset = 9
    for _ in range(n_geoms):
        sub_bo = "<" if wkb[offset] == 1 else ">"
        sub_type = struct.unpack(f"{sub_bo}I", wkb[offset + 1:offset + 5])[0]
        n_points = struct.unpack(f"{sub_bo}I", wkb[offset + 5:offset + 9])[0]
        offset += 9
        coords = []
        for _ in range(n_points):
            x, y = struct.unpack(f"{sub_bo}dd", wkb[offset:offset + 16])
            coords.append([round(x, 7), round(y, 7)])
            offset += 16
        lines.append(coords)
    return {"type": "MultiLineString", "coordinates": lines}


def parse_wkb_multipolygon(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    n_geoms = struct.unpack(f"{bo}I", wkb[5:9])[0]
    polygons = []
    offset = 9
    for _ in range(n_geoms):
        sub_bo = "<" if wkb[offset] == 1 else ">"
        offset += 5
        n_rings = struct.unpack(f"{sub_bo}I", wkb[offset:offset + 4])[0]
        offset += 4
        rings = []
        for _ in range(n_rings):
            n_points = struct.unpack(f"{sub_bo}I", wkb[offset:offset + 4])[0]
            offset += 4
            ring = []
            for _ in range(n_points):
                x, y = struct.unpack(f"{sub_bo}dd", wkb[offset:offset + 16])
                ring.append([round(x, 7), round(y, 7)])
                offset += 16
            rings.append(ring)
        polygons.append(rings)
    return {"type": "MultiPolygon", "coordinates": polygons}


# S-57 line features (cables, pipelines) often store disjoint legs as one vertex chain.
# Connecting those legs draws long spurious chords; split at large coordinate gaps.
LINE_VERTEX_GAP_DEG = 0.025


def _split_line_coords(coords: list, max_gap_deg: float = LINE_VERTEX_GAP_DEG) -> list[list]:
    if len(coords) < 2:
        return []
    parts: list[list] = []
    current = [coords[0]]
    for i in range(1, len(coords)):
        prev, pt = coords[i - 1], coords[i]
        gap = math.hypot(pt[0] - prev[0], pt[1] - prev[1])
        if gap > max_gap_deg and len(current) >= 2:
            parts.append(current)
            current = [pt]
        else:
            current.append(pt)
    if len(current) >= 2:
        parts.append(current)
    return parts


def _normalize_line_geometry(geom: dict | None) -> dict | None:
    if not geom:
        return geom
    gtype = geom.get("type")
    if gtype == "LineString":
        parts = _split_line_coords(geom["coordinates"])
        if len(parts) <= 1:
            return geom
        return {"type": "MultiLineString", "coordinates": parts}
    if gtype == "MultiLineString":
        parts: list[list] = []
        for line in geom["coordinates"]:
            parts.extend(_split_line_coords(line))
        if not parts:
            return geom
        if len(parts) == 1 and len(geom["coordinates"]) == 1:
            return {"type": "LineString", "coordinates": parts[0]}
        return {"type": "MultiLineString", "coordinates": parts}
    return geom


def _normalize_attr_value(val):
    if val is None:
        return None
    s = str(val)
    if s == "" or s == "nan":
        return None
    if hasattr(val, "item"):
        val = val.item()
        s = str(val)
        if s == "nan":
            return None
        return val
    if hasattr(val, "__len__") and not isinstance(val, (str, bytes)):
        try:
            parts = []
            for x in val:
                if x is None or str(x) == "nan":
                    continue
                parts.append(str(x.item() if hasattr(x, "item") else x))
            return ",".join(parts) if parts else None
        except TypeError:
            pass
    return val


def compute_s52_settings_from_index() -> dict:
    """Derive mariner contour settings from indexed chart DEPCNT layers."""
    contours: list[float] = []
    for info in chart_index.values():
        path = info.get("path")
        if not path:
            continue
        try:
            result = ogr_read(path, layer="DEPCNT")
            field_names = list(result[0]["fields"])
            if "VALDCO" not in field_names:
                continue
            idx = field_names.index("VALDCO")
            for raw in result[3][idx]:
                v = _normalize_attr_value(raw)
                if v is None:
                    continue
                try:
                    contours.append(float(v))
                except (TypeError, ValueError):
                    pass
        except Exception:
            continue

    settings = {
        "shallowContour": 2,
        "safetyContour": 3,
        "deepContour": 6,
        "safetyDepth": 3,
        "source": "default",
    }
    if not contours:
        return settings

    uniq = sorted({round(c, 2) for c in contours if c >= 0})
    shallow_candidates = [c for c in uniq if 1 <= c <= 5]
    safety_candidates = [c for c in uniq if 2 <= c <= 10]
    deep_candidates = [c for c in uniq if 5 <= c <= 30]
    if shallow_candidates:
        settings["shallowContour"] = shallow_candidates[0]
    if safety_candidates:
        for c in safety_candidates:
            if c > settings["shallowContour"]:
                settings["safetyContour"] = c
                settings["safetyDepth"] = c
                break
    if deep_candidates:
        for c in deep_candidates:
            if c > settings["safetyContour"]:
                settings["deepContour"] = c
                break
    settings["source"] = "depcnt"
    return settings


def _write_s52_settings_file(settings: dict) -> None:
    path = Path(__file__).parent / "static" / "s52-settings.json"
    try:
        path.write_text(json.dumps(settings, separators=(",", ":")), encoding="utf-8")
    except OSError as exc:
        print(f"Warning: could not write {path.name}: {exc}")


def refresh_s52_mariner_settings() -> dict:
    global s52_mariner_settings
    s52_mariner_settings = compute_s52_settings_from_index()
    _write_s52_settings_file(s52_mariner_settings)
    return s52_mariner_settings


def _view_scale_denominator(zoom: int) -> int:
    return ZOOM_TO_SCALE_DENOM.get(zoom, 90_000)


def _passes_scale_limits(props: dict, view_scale_denom: int) -> bool:
    """Hide objects outside SCAMIN/SCAMAX (IHO S-52 / OpenCPN behaviour)."""
    raw_min = props.get("SCAMIN")
    if raw_min is not None and raw_min != "":
        try:
            if view_scale_denom > int(float(raw_min)):
                return False
        except (TypeError, ValueError):
            pass
    raw_max = props.get("SCAMAX")
    if raw_max is not None and raw_max != "":
        try:
            if view_scale_denom < int(float(raw_max)):
                return False
        except (TypeError, ValueError):
            pass
    return True


def _attrs_for_layer(layer: str, field_names: list[str]) -> list[tuple[str, int]]:
    important_attrs = {
        "SOUNDG": ["OBJNAM", "NOBJNM"],
        "LIGHTS": ["COLOUR", "CATLIT", "SECTR1", "SECTR2", "SIGPER", "SIGGRP", "LITCHR", "HEIGHT", "VALNMR", "OBJNAM", "NOBJNM"],
        "DEPARE": ["DRVAL1", "DRVAL2"],
        "DEPCNT": ["VALDCO"],
        "BOYISD": ["COLOUR", "BOYSHP", "OBJNAM", "NOBJNM", "ORIENT"],
        "BOYLAT": ["COLOUR", "BOYSHP", "CATLAM", "OBJNAM", "NOBJNM", "ORIENT"],
        "BOYCAR": ["COLOUR", "BOYSHP", "CATCAM", "OBJNAM", "NOBJNM", "ORIENT"],
        "BOYSAW": ["COLOUR", "BOYSHP", "OBJNAM", "NOBJNM", "ORIENT"],
        "BOYSPP": ["COLOUR", "BOYSHP", "CATSPM", "OBJNAM", "NOBJNM", "ORIENT"],
        "BCNCAR": ["COLOUR", "BCNSHP", "CATCAM", "OBJNAM", "NOBJNM", "ORIENT"],
        "BCNISD": ["COLOUR", "BCNSHP", "OBJNAM", "NOBJNM", "ORIENT"],
        "BCNLAT": ["COLOUR", "BCNSHP", "CATLAM", "OBJNAM", "NOBJNM", "ORIENT"],
        "BCNSAW": ["COLOUR", "BCNSHP", "OBJNAM", "NOBJNM", "ORIENT"],
        "BCNSPP": ["COLOUR", "BCNSHP", "OBJNAM", "NOBJNM", "ORIENT"],
        "TOPMAR": ["TOPSHP", "COLOUR"],
        "OBSTRN": ["CATOBS", "VALSOU", "WATLEV", "OBJNAM", "NOBJNM"],
        "UWTROC": ["VALSOU", "WATLEV", "OBJNAM", "NOBJNM"],
        "WRECKS": ["CATWRK", "VALSOU", "WATLEV", "OBJNAM", "NOBJNM"],
        "LNDMRK": ["CATLMK", "CONVIS", "OBJNAM", "NOBJNM"],
        "LNDARE": ["OBJNAM", "NOBJNM"],
        "LNDELV": ["ELEVAT", "OBJNAM", "NOBJNM"],
        "LNDRGN": ["CATLND", "OBJNAM", "NOBJNM"],
        "SEAARE": ["OBJNAM", "NOBJNM"],
        "LAKARE": ["OBJNAM", "NOBJNM"],
        "COALNE": ["CATCOA"],
        "SLCONS": ["CATSLC", "WATLEV"],
        "BRIDGE": ["VERCLR", "VERCCL", "VERCOP", "OBJNAM", "NOBJNM"],
        "RDOCAL": ["OBJNAM", "NOBJNM", "COMCHA", "ORIENT"],
        "RDOSTA": ["OBJNAM", "NOBJNM"],
        "RTPBCN": ["OBJNAM", "NOBJNM"],
        "PILPNT": ["OBJNAM", "NOBJNM"],
        "RESARE": ["OBJNAM", "NOBJNM", "CATREA", "RESTRN"],
        "ACHBRT": ["OBJNAM", "NOBJNM"],
        "ACHARE": ["OBJNAM", "NOBJNM"],
        "FOGSIG": ["OBJNAM", "NOBJNM"],
        "BUAARE": ["OBJNAM", "NOBJNM"],
        "TSELNE": ["OBJNAM", "NOBJNM"],
        "TSSBND": ["OBJNAM", "NOBJNM"],
        "TSSLPT": ["OBJNAM", "NOBJNM"],
        "FAIRWY": ["OBJNAM", "NOBJNM"],
        "DWRTPT": ["OBJNAM", "NOBJNM"],
        "TWRTPT": ["OBJNAM", "NOBJNM"],
    }
    names = list(important_attrs.get(layer, ["OBJNAM", "NOBJNM"]))
    for attr in GLOBAL_S57_ATTRS:
        if attr not in names:
            names.append(attr)
    keep: list[tuple[str, int]] = []
    for attr in names:
        if attr in field_names:
            keep.append((attr, field_names.index(attr)))
    return keep


def get_scale_from_filename(filename: str) -> int:
    prefix = filename[:4]
    if prefix.startswith("KR"):
        c = filename[2]
        scale_map = {
            "1": 1,   # ~3,500,000
            "2": 2,   # ~700,000
            "3": 3,   # ~180,000
            "4": 4,   # ~90,000
            "5": 5,   # ~22,000
            "6": 6,   # ~12,000
        }
        return scale_map.get(c, 4)
    return 4


def build_chart_index(on_progress=None):
    global chart_index
    if not chart_source_dirs:
        print("No chart sources configured, skipping index build")
        return

    started_at = time.time()
    chart_file_entries = _iter_indexed_chart_files()
    files_found = len(chart_file_entries)
    file_keys = {key for key, _ in chart_file_entries}

    cache_path = index_cache_path()
    if cache_path and cache_path.exists():
        if on_progress:
            on_progress(0, 0, "Loading chart index from cache…")
        with open(cache_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        with _datasource_lock:
            chart_index = loaded
        print(f"Loaded chart index from cache: {len(chart_index)} charts")
        indexed_entries = [
            {
                "name": name,
                "file": _chart_display_name(name),
                "scale": info["scale"],
                "scale_label": SCALE_BAND_LABELS.get(info["scale"], f"Band {info['scale']}"),
                "layer_count": len(info.get("layers", [])),
                "bounds": info["bounds"],
            }
            for name, info in sorted(chart_index.items())
        ]
        index_keys = set(chart_index.keys())
        failed_entries = [
            {"name": key, "file": _chart_display_name(key), "error": "Not indexed (missing from cache)"}
            for key in sorted(file_keys - index_keys)
        ]
        failed_entries.extend(
            {
                "name": key,
                "file": _chart_display_name(key),
                "error": "Indexed but source file no longer present",
            }
            for key in sorted(index_keys - file_keys)
        )
        _finalize_load_report(
            files_found,
            indexed_entries,
            failed_entries,
            from_cache=True,
            started_at=started_at,
        )
        if on_progress:
            n = len(chart_index)
            on_progress(n, n, f"Loaded {n} chart(s) from cache")
        refresh_s52_mariner_settings()
        return

    print(f"Building chart index from {len(chart_source_dirs)} source(s)…")
    total = files_found
    if on_progress:
        on_progress(0, total, f"Indexing charts (0/{total})…")

    indexed_entries: list[dict] = []
    failed_entries: list[dict] = []

    def process_file(chart_key: str, fpath: Path):
        try:
            info = pyogrio.read_info(str(fpath), layer="M_COVR")
            bounds = info["total_bounds"]
            layers = [l[0] for l in pyogrio.list_layers(str(fpath))]
            feature_layers = [l for l in layers if l in FEATURE_LAYERS]
            scale = get_scale_from_filename(fpath.stem)
            data = {
                "path": str(fpath),
                "bounds": list(bounds),
                "scale": scale,
                "layers": feature_layers,
                "source": chart_key.split("/")[0] if "/" in chart_key else _source_label(fpath.parent),
            }
            entry = {
                "name": chart_key,
                "file": _chart_display_name(chart_key),
                "scale": scale,
                "scale_label": SCALE_BAND_LABELS.get(scale, f"Band {scale}"),
                "layer_count": len(feature_layers),
                "bounds": list(bounds),
            }
            return chart_key, data, entry, None
        except Exception as exc:
            return chart_key, None, None, str(exc)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(process_file, key, fpath): (key, fpath)
            for key, fpath in chart_file_entries
        }
        done = 0
        for future in as_completed(futures):
            done += 1
            name, data, entry, err = future.result()
            if data and entry:
                with _datasource_lock:
                    chart_index[name] = data
                indexed_entries.append(entry)
            else:
                failed_entries.append({
                    "name": name,
                    "file": _chart_display_name(name),
                    "error": err or "Unknown error",
                })
            if on_progress and (done == 1 or done % 5 == 0 or done == total):
                on_progress(done, total, f"Indexing charts ({done}/{total})…")
            elif done % 50 == 0:
                print(f"  Indexed {done}/{total} files...")

    indexed_entries.sort(key=lambda x: (x["scale"], x["file"]))
    failed_entries.sort(key=lambda x: x["file"])

    print(f"Indexed {len(chart_index)} charts ({len(failed_entries)} failed)")
    refresh_s52_mariner_settings()
    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(chart_index, f)
    _finalize_load_report(
        files_found,
        indexed_entries,
        failed_entries,
        from_cache=False,
        started_at=started_at,
    )
    if on_progress:
        n = len(chart_index)
        on_progress(n, n, f"Indexed {n} chart file(s)")


def read_s57_layer(filepath: str, layer: str):
    features = []
    try:
        result = ogr_read(filepath, layer=layer)
        meta = result[0]
        geometries = result[2]
        field_arrays = result[3]
        field_names = list(meta["fields"])

        keep_indices = _attrs_for_layer(layer, field_names)

        for i, geom_wkb in enumerate(geometries):
            geom = parse_wkb(geom_wkb)
            if geom is None:
                continue
            geom = _normalize_line_geometry(geom)

            props = {"layer": layer}
            for attr_name, idx in keep_indices:
                val = _normalize_attr_value(field_arrays[idx][i])
                if val is not None:
                    props[attr_name] = val

            if layer == "SOUNDG" and geom["type"] == "MultiPoint":
                for coord in geom["coordinates"]:
                    pt_feat = {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": coord},
                        "properties": {**props, "depth": coord[2] if len(coord) > 2 else None},
                    }
                    _attach_bbox_to_feature(pt_feat)
                    features.append(pt_feat)
            else:
                feat = {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": props,
                }
                _attach_bbox_to_feature(feat)
                features.append(feat)
    except Exception as e:
        pass
    return features


@app.on_event("startup")
async def startup():
    """Load bundled sample charts on start (skip when SKIP_STARTUP_CHART_LOAD=1)."""
    if os.environ.get("SKIP_STARTUP_CHART_LOAD", "").lower() in ("1", "true", "yes"):
        return
    if DEFAULT_SAMPLE_DIR.is_dir() and find_chart_files(DEFAULT_SAMPLE_DIR):
        _start_datasource_load(None, mode="default")


@app.get("/api/datasource")
async def get_datasource_status():
    return JSONResponse(datasource_payload())


@app.get("/api/s52-settings")
@app.get("/api/s57-settings")  # legacy typo in older clients
async def get_s52_settings():
    return JSONResponse(s52_mariner_settings)


@app.get("/api/datasource/samples")
async def get_datasource_samples():
    return JSONResponse({"samples": list_sample_datasets()})


@app.post("/api/datasource/default")
async def load_default_sample():
    if not DEFAULT_SAMPLE_DIR.is_dir():
        raise HTTPException(status_code=404, detail="Default sample directory is missing.")
    if not find_chart_files(DEFAULT_SAMPLE_DIR):
        raise HTTPException(status_code=404, detail="No .000 files in default sample directory.")

    with _load_progress_lock:
        if _load_progress["status"] == "running":
            return JSONResponse({
                "status": "started",
                "path": str(DEFAULT_SAMPLE_DIR.resolve()),
                "mode": "default",
            })

    default_only = (
        len(chart_source_dirs) == 1
        and chart_source_dirs[0].resolve() == DEFAULT_SAMPLE_DIR.resolve()
    )
    if datasource_mode == "default" and len(chart_index) > 0 and default_only:
        return JSONResponse(_datasource_result_payload())

    _start_datasource_load(None, mode="default")
    return JSONResponse({
        "status": "started",
        "path": str(DEFAULT_SAMPLE_DIR.resolve()),
        "mode": "default",
    })


@app.post("/api/datasource/sample/{sample_id}")
async def load_sample_datasource(sample_id: str, mode: str = Query("replace")):
    if sample_id == "default" or sample_id == "bundled":
        return await load_default_sample()
    root = resolve_sample_path(sample_id)
    if root is None:
        raise HTTPException(status_code=404, detail=f"Sample dataset not found: {sample_id}")
    _start_datasource_load(root, mode=_normalize_load_mode(mode))
    return JSONResponse({
        "status": "started",
        "path": str(root),
        "sample_id": sample_id,
        "mode": _normalize_load_mode(mode),
    })


@app.get("/api/datasource/report")
async def get_datasource_report():
    if not last_load_report:
        raise HTTPException(status_code=404, detail="No load report for the current folder.")
    return JSONResponse(last_load_report)


@app.get("/api/datasource/progress")
async def get_datasource_progress():
    return JSONResponse(_progress_snapshot())


@app.post("/api/datasource")
async def set_datasource_path(body: DatasourcePath):
    return JSONResponse(set_datasource(Path(body.path), mode=body.mode))


@app.post("/api/datasource/browse")
async def browse_datasource_folder(mode: str = Query("replace")):
    loop = asyncio.get_event_loop()
    path, cancel_reason = await loop.run_in_executor(None, _pick_folder_dialog)
    if not path:
        payload: dict = {"cancelled": True}
        if cancel_reason:
            payload["reason"] = cancel_reason
        return JSONResponse(payload)
    load_mode = _normalize_load_mode(mode)
    _start_datasource_load(Path(path), mode=load_mode)
    return JSONResponse({"status": "started", "path": path, "mode": load_mode})


@app.post("/api/datasource/upload")
async def upload_datasource(
    files: list[UploadFile] = File(...),
    mode: str = Query("replace"),
):
    with _load_progress_lock:
        if _load_progress["status"] == "running":
            raise HTTPException(status_code=409, detail="Chart data is already loading.")

    chart_files = [f for f in files if f.filename and f.filename.lower().endswith(".000")]
    if not chart_files:
        raise HTTPException(status_code=400, detail="No .000 files in selection.")

    upload_root = UPLOAD_DIR / hashlib.md5(str(time.time()).encode()).hexdigest()[:12]
    upload_root.mkdir(parents=True, exist_ok=True)
    total = len(chart_files)

    with _load_progress_lock:
        _load_progress["status"] = "running"
        _load_progress["error"] = None
        _load_progress["result"] = None
        _load_progress["percent"] = 0

    try:
        for i, uf in enumerate(chart_files, start=1):
            _set_load_progress(
                "upload",
                i,
                total,
                f"Uploading chart files ({i}/{total})…",
                status="running",
            )
            rel = Path((uf.filename or "chart.000").replace("\\", "/").lstrip("/"))
            safe_parts = [p for p in rel.parts if p not in ("..", "")]
            dest = upload_root.joinpath(*safe_parts) if safe_parts else upload_root / "chart.000"
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as out:
                shutil.copyfileobj(uf.file, out)
    except Exception as exc:
        shutil.rmtree(upload_root, ignore_errors=True)
        _set_load_progress("error", 0, 0, str(exc), status="error", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}") from exc

    load_mode = _normalize_load_mode(mode)
    _start_datasource_load(upload_root, mode=load_mode, already_running=True)
    return JSONResponse({
        "status": "started",
        "path": str(upload_root),
        "chart_count": total,
        "mode": load_mode,
    })


def clear_viewport_response_cache() -> None:
    if VIEWPORT_RESPONSE_DIR.exists():
        shutil.rmtree(VIEWPORT_RESPONSE_DIR, ignore_errors=True)
    VIEWPORT_RESPONSE_DIR.mkdir(exist_ok=True)


def _charts_response_cache_key(
    west: float, south: float, east: float, north: float, zoom: int, layers: str,
    apply_scamin: bool = False,
) -> str:
    rounded = (
        CHARTS_API_VERSION,
        round(west, 3), round(south, 3), round(east, 3), round(north, 3),
        zoom, layers, int(apply_scamin),
    )
    return hashlib.sha256(repr(rounded).encode()).hexdigest()[:32]


def _attach_bbox_to_feature(feature: dict) -> None:
    if feature.get("bbox"):
        return
    geom = feature.get("geometry")
    if not geom:
        return
    bbox = _coords_bbox(geom["coordinates"], geom["type"])
    if bbox is not None:
        feature["bbox"] = [bbox[0], bbox[1], bbox[2], bbox[3]]


def _ensure_layer_features_bbox(features: list[dict]) -> bool:
    if not features or features[0].get("bbox"):
        return False
    for feature in features:
        _attach_bbox_to_feature(feature)
    return True


def _load_layer_features(chart_path: str, layer: str) -> list[dict]:
    cache_key = hashlib.md5(f"{chart_path}:{layer}:v{LAYER_CACHE_VERSION}".encode()).hexdigest()
    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        with open(cache_file, "r", encoding="utf-8") as f:
            features = json.load(f)
        if _ensure_layer_features_bbox(features):
            try:
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(features, f)
            except OSError:
                pass
        return features
    features = read_s57_layer(chart_path, layer)
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(features, f)
    return features


def _public_features(features: list[dict]) -> list[dict]:
    out = []
    for feature in features:
        if "bbox" in feature:
            public = {k: v for k, v in feature.items() if k != "bbox"}
            out.append(public)
        else:
            out.append(feature)
    return out


def _padded_viewport(west: float, south: float, east: float, north: float) -> tuple[float, float, float, float]:
    lon_pad = (east - west) * VIEWPORT_PAD_RATIO
    lat_pad = (north - south) * VIEWPORT_PAD_RATIO
    return west - lon_pad, south - lat_pad, east + lon_pad, north + lat_pad


def _bbox_intersects(
    a_west: float, a_south: float, a_east: float, a_north: float,
    b_west: float, b_south: float, b_east: float, b_north: float,
) -> bool:
    return not (a_east < b_west or a_west > b_east or a_north < b_south or a_south > b_north)


def _update_bbox(
    west: float, south: float, east: float, north: float,
    lon: float, lat: float,
) -> tuple[float, float, float, float]:
    return min(west, lon), min(south, lat), max(east, lon), max(north, lat)


def _coords_bbox(coords, geom_type: str) -> tuple[float, float, float, float] | None:
    try:
        if geom_type == "Point":
            return _update_bbox(float("inf"), float("inf"), float("-inf"), float("-inf"), coords[0], coords[1])

        if geom_type in ("LineString", "MultiPoint"):
            west = south = float("inf")
            east = north = float("-inf")
            for pt in coords:
                west, south, east, north = _update_bbox(west, south, east, north, pt[0], pt[1])
            return west, south, east, north

        if geom_type == "Polygon":
            west = south = float("inf")
            east = north = float("-inf")
            for ring in coords:
                for pt in ring:
                    west, south, east, north = _update_bbox(west, south, east, north, pt[0], pt[1])
            return west, south, east, north

        if geom_type == "MultiLineString":
            west = south = float("inf")
            east = north = float("-inf")
            for line in coords:
                for pt in line:
                    west, south, east, north = _update_bbox(west, south, east, north, pt[0], pt[1])
            return west, south, east, north

        if geom_type == "MultiPolygon":
            west = south = float("inf")
            east = north = float("-inf")
            for poly in coords:
                for ring in poly:
                    for pt in ring:
                        west, south, east, north = _update_bbox(west, south, east, north, pt[0], pt[1])
            return west, south, east, north
    except (IndexError, TypeError, ValueError):
        return None

    return None


def _feature_intersects_viewport(feature: dict, vp: tuple[float, float, float, float]) -> bool:
    cached = feature.get("bbox")
    if cached and len(cached) == 4:
        return _bbox_intersects(
            cached[0], cached[1], cached[2], cached[3], vp[0], vp[1], vp[2], vp[3],
        )
    geom = feature.get("geometry")
    if not geom:
        return False
    bbox = _coords_bbox(geom["coordinates"], geom["type"])
    if bbox is None:
        return False
    return _bbox_intersects(bbox[0], bbox[1], bbox[2], bbox[3], vp[0], vp[1], vp[2], vp[3])


def _layers_skipped_at_zoom(zoom: int) -> set[str]:
    skip: set[str] = set()
    if zoom <= 6:
        skip.add("SOUNDG")
    if zoom <= 5:
        skip.add("DEPCNT")
    return skip


def _sounding_cap(zoom: int) -> int | None:
    if zoom <= 8:
        return 0
    if zoom >= 14:
        return None
    return SOUNDG_MAX_BY_ZOOM.get(zoom)


def _filter_features_for_viewport(
    features: list[dict],
    vp: tuple[float, float, float, float],
    layer: str,
    zoom: int,
    view_scale_denom: int | None = None,
    apply_scamin: bool = False,
) -> list[dict]:
    scale_denom = view_scale_denom if view_scale_denom is not None else _view_scale_denominator(zoom)
    filtered = []
    for f in features:
        if not _feature_intersects_viewport(f, vp):
            continue
        if apply_scamin and not _passes_scale_limits(f.get("properties") or {}, scale_denom):
            continue
        filtered.append(f)
    if layer != "SOUNDG":
        return filtered
    cap = _sounding_cap(zoom)
    if cap is None or len(filtered) <= cap:
        return filtered
    if cap <= 0:
        return []
    step = max(1, len(filtered) // cap)
    return filtered[::step][:cap]


@app.get("/api/index")
async def get_index():
    summaries = []
    for name, info in chart_index.items():
        summaries.append({
            "name": name,
            "bounds": info["bounds"],
            "scale": info["scale"],
            "layers": info["layers"],
        })
    return JSONResponse(summaries)


def _collect_chart_viewport_features(
    chart_name: str,
    chart: dict,
    vp: tuple[float, float, float, float],
    zoom: int,
    requested_layers: list[str] | None,
    skipped_layers: set[str],
    apply_scamin: bool = False,
) -> tuple[list[dict], dict, dict[str, int], int]:
    try:
        return _collect_chart_viewport_features_impl(
            chart_name, chart, vp, zoom, requested_layers, skipped_layers, apply_scamin,
        )
    except Exception as exc:
        print(f"Warning: viewport load failed for {chart_name}: {exc}")
        return [], {
            "name": chart_name,
            "file": _chart_display_name(chart_name),
            "scale": chart.get("scale"),
            "scale_label": SCALE_BAND_LABELS.get(chart.get("scale"), ""),
            "features": 0,
            "layers_used": 0,
            "error": str(exc),
        }, {}, 0


def _load_chart_layer_viewport(
    chart_path: str,
    layer: str,
    vp: tuple[float, float, float, float],
    zoom: int,
    apply_scamin: bool,
) -> tuple[str, list[dict], int]:
    layer_features = _load_layer_features(chart_path, layer)
    raw_count = len(layer_features)
    filtered = _filter_features_for_viewport(
        layer_features, vp, layer, zoom,
        view_scale_denom=_view_scale_denominator(zoom),
        apply_scamin=apply_scamin,
    )
    return layer, filtered, raw_count


def _collect_chart_viewport_features_impl(
    chart_name: str,
    chart: dict,
    vp: tuple[float, float, float, float],
    zoom: int,
    requested_layers: list[str] | None,
    skipped_layers: set[str],
    apply_scamin: bool = False,
) -> tuple[list[dict], dict, dict[str, int], int]:
    chart_features = 0
    features_by_layer: dict[str, int] = {}
    collected: list[dict] = []
    raw_count = 0

    layers_to_load = [
        layer for layer in chart["layers"]
        if layer not in skipped_layers
        and (not requested_layers or layer in requested_layers)
    ]

    if len(layers_to_load) <= 2:
        layer_results = [
            _load_chart_layer_viewport(chart["path"], layer, vp, zoom, apply_scamin)
            for layer in layers_to_load
        ]
    else:
        futures = [
            _LAYER_POOL.submit(
                _load_chart_layer_viewport, chart["path"], layer, vp, zoom, apply_scamin,
            )
            for layer in layers_to_load
        ]
        layer_results = [future.result() for future in futures]

    for layer, filtered, layer_raw in layer_results:
        raw_count += layer_raw
        n = len(filtered)
        chart_features += n
        features_by_layer[layer] = features_by_layer.get(layer, 0) + n
        collected.extend(filtered)

    detail = {
        "name": chart_name,
        "file": _chart_display_name(chart_name),
        "scale": chart["scale"],
        "scale_label": SCALE_BAND_LABELS.get(chart["scale"], f"Band {chart['scale']}"),
        "features": chart_features,
        "layers_used": len([
            l for l in chart["layers"]
            if l not in skipped_layers and (not requested_layers or l in requested_layers)
        ]),
    }
    return collected, detail, features_by_layer, raw_count


def _build_charts_response(
    west: float,
    south: float,
    east: float,
    north: float,
    zoom: int,
    layers: str,
    apply_scamin: bool = False,
) -> dict:
    target_scales = _target_scale_bands_for_zoom(zoom)

    if chart_index:
        available_scales = set()
        for name, info in chart_index.items():
            b = info["bounds"]
            if b[2] < west or b[0] > east or b[3] < south or b[1] > north:
                continue
            available_scales.add(info["scale"])
        if available_scales and not available_scales.intersection(target_scales):
            target_scales = sorted(available_scales)

    if not chart_index:
        return {
            "type": "FeatureCollection",
            "features": [],
            "meta": {
                "charts_loaded": 0,
                "charts_matched": 0,
                "total_features": 0,
                "zoom": zoom,
                "target_scales": target_scales,
            },
        }

    requested_layers = [l.strip() for l in layers.split(",") if l.strip()] if layers else None

    matching_charts: list[tuple[str, dict]] = []
    for name, info in chart_index.items():
        b = info["bounds"]
        if info["scale"] not in target_scales:
            continue
        if b[2] < west or b[0] > east or b[3] < south or b[1] > north:
            continue
        matching_charts.append((name, info))

    matching_charts.sort(key=lambda item: item[1]["scale"])
    charts_matched = len(matching_charts)

    max_charts = 50
    loaded_charts = matching_charts[:max_charts]
    vp = _padded_viewport(west, south, east, north)
    skipped_layers = _layers_skipped_at_zoom(zoom)

    all_features: list[dict] = []
    features_by_layer: dict[str, int] = {}
    chart_details = []
    features_capped = False
    raw_feature_count = 0

    if len(loaded_charts) <= 1:
        chart_results = [
            _collect_chart_viewport_features(
                chart_name, chart, vp, zoom, requested_layers, skipped_layers, apply_scamin,
            )
            for chart_name, chart in loaded_charts
        ]
    else:
        futures = [
            _CHARTS_POOL.submit(
                _collect_chart_viewport_features,
                chart_name, chart, vp, zoom, requested_layers, skipped_layers, apply_scamin,
            )
            for chart_name, chart in loaded_charts
        ]
        chart_results = [future.result() for future in futures]

    for collected, detail, by_layer, raw_count in chart_results:
        raw_feature_count += raw_count
        remaining = MAX_FEATURES_RESPONSE - len(all_features)
        if remaining <= 0:
            features_capped = True
            chart_details.append(detail)
            break
        if len(collected) > remaining:
            collected = collected[:remaining]
            features_capped = True

        all_features.extend(collected)
        for layer, count in by_layer.items():
            features_by_layer[layer] = features_by_layer.get(layer, 0) + count
        chart_details.append(detail)
        if features_capped:
            break

    layer_breakdown = [
        {"layer": layer, "features": count}
        for layer, count in sorted(features_by_layer.items(), key=lambda x: (-x[1], x[0]))
    ]

    return {
        "type": "FeatureCollection",
        "features": _public_features(all_features),
        "meta": {
            "charts_loaded": len(chart_details),
            "charts_matched": charts_matched,
            "charts_capped": charts_matched > max_charts,
            "max_charts": max_charts,
            "total_features": len(all_features),
            "raw_features_before_viewport": raw_feature_count,
            "features_capped": features_capped,
            "max_features": MAX_FEATURES_RESPONSE,
            "skipped_layers": sorted(skipped_layers),
            "zoom": zoom,
            "target_scales": target_scales,
            "target_scale_labels": [SCALE_BAND_LABELS.get(s, str(s)) for s in target_scales],
            "apply_scamin": apply_scamin,
            "viewport": {"west": west, "south": south, "east": east, "north": north},
            "charts": chart_details,
            "features_by_layer": layer_breakdown[:20],
            "s52_settings": s52_mariner_settings,
        },
    }


@app.get("/api/charts")
async def get_charts(
    west: float = Query(...),
    south: float = Query(...),
    east: float = Query(...),
    north: float = Query(...),
    zoom: int = Query(5),
    layers: str = Query(""),
    scamin: int = Query(0, ge=0, le=1),
):
    apply_scamin = bool(scamin)
    cache_key = _charts_response_cache_key(west, south, east, north, zoom, layers, apply_scamin)
    cache_file = VIEWPORT_RESPONSE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            return FileResponse(cache_file, media_type="application/json")
        except OSError:
            pass

    try:
        payload = await asyncio.to_thread(
            _build_charts_response, west, south, east, north, zoom, layers, apply_scamin,
        )
    except Exception as exc:
        print(f"Error building charts response: {exc}")
        raise HTTPException(status_code=500, detail=f"Chart load failed: {exc}") from exc

    tmp_file = cache_file.with_suffix(".json.tmp")
    try:
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        tmp_file.replace(cache_file)
    except OSError:
        if tmp_file.exists():
            try:
                tmp_file.unlink()
            except OSError:
                pass
    return JSONResponse(payload)


@app.get("/api/chart/{chart_name}")
async def get_single_chart(chart_name: str, layers: str = Query("")):
    if chart_name not in chart_index:
        return JSONResponse({"error": "Chart not found"}, status_code=404)

    info = chart_index[chart_name]
    requested_layers = [l.strip() for l in layers.split(",") if l.strip()] if layers else None

    all_features = []
    for layer in info["layers"]:
        if requested_layers and layer not in requested_layers:
            continue

        cache_key = hashlib.md5(f"{info['path']}:{layer}".encode()).hexdigest()
        cache_file = CACHE_DIR / f"{cache_key}.json"

        if cache_file.exists():
            with open(cache_file, "r") as f:
                features = json.load(f)
        else:
            features = read_s57_layer(info["path"], layer)
            with open(cache_file, "w") as f:
                json.dump(features, f)

        all_features.extend(features)

    return JSONResponse({
        "type": "FeatureCollection",
        "features": all_features,
        "meta": {"chart": chart_name, "bounds": info["bounds"]},
    })


@app.get("/api/categories")
async def get_categories():
    return JSONResponse(DISPLAY_CATEGORIES)


def _load_visitors() -> dict:
    today_str = date.today().isoformat()
    if VISITORS_FILE.exists():
        try:
            with open(VISITORS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("date") != today_str:
                data["date"] = today_str
                data["today"] = 0
            return {
                "date": data.get("date", today_str),
                "today": int(data.get("today", 0)),
                "total": int(data.get("total", 0)),
            }
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    return {"date": today_str, "today": 0, "total": 0}


def _save_visitors(data: dict) -> None:
    with open(VISITORS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


def record_visit() -> dict:
    with _visitors_lock:
        data = _load_visitors()
        data["today"] += 1
        data["total"] += 1
        _save_visitors(data)
        return {"today": data["today"], "total": data["total"]}


@app.get("/api/visitors")
async def get_visitors():
    return JSONResponse(record_visit())


_static = Path(__file__).parent / "static"
_public = Path(__file__).parent / "public"
_static_root = _static.resolve()

app.mount("/public", StaticFiles(directory=str(_public)), name="public")


def _resolve_static_file(relative_path: str) -> Path:
    candidate = (_static / relative_path).resolve()
    if not str(candidate).startswith(str(_static_root)):
        raise HTTPException(status_code=404, detail="Not found")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return candidate


@app.get("/")
async def serve_index():
    return FileResponse(_static / "index.html")


@app.get("/{filepath:path}")
async def serve_static(filepath: str):
    if filepath == "api" or filepath.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(_resolve_static_file(filepath))


def _find_available_port(start: int, host: str = "127.0.0.1", max_attempts: int = 50) -> int:
    import socket

    for port in range(start, start + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(
        f"No free port in range {start}–{start + max_attempts - 1} (host {host})"
    )


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    start_port = int(os.environ.get("PORT", "8080"))
    port = _find_available_port(start_port, host)
    if port != start_port:
        print(f"Port {start_port} is in use; using port {port}", flush=True)
    print(f"Open http://{host}:{port}", flush=True)

    reload = os.environ.get("RELOAD", "1").lower() not in ("0", "false", "no")
    if reload:
        uvicorn.run("server:app", host=host, port=port, reload=True)
    else:
        uvicorn.run(app, host=host, port=port)
