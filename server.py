import os
import json
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

import pyogrio
from pyogrio.raw import read as ogr_read

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

S57_DIR: Path | None = Path(os.environ["S57_DIR"]) if os.environ.get("S57_DIR") else None
CACHE_DIR = Path(os.environ.get("CACHE_DIR", Path(__file__).parent / "cache"))
DEFAULT_SAMPLE_DIR = Path(
    os.environ.get("DEFAULT_SAMPLE_DIR", Path(__file__).parent / "public" / "sample")
)
SAMPLE_DATA_DIR = Path(os.environ.get("SAMPLE_DATA_DIR", Path(__file__).parent / "sample_data"))
UPLOAD_DIR = CACHE_DIR / "uploads"
chart_source_dirs: list[Path] = []
datasource_mode: str = "default"
CACHE_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)

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
    "DEPARE", "DEPCNT", "LNDARE", "COALNE", "SOUNDG",
    "LIGHTS", "BOYISD", "BOYLAT", "BOYSAW", "BOYSPP",
    "BCNCAR", "BCNISD", "BCNLAT",
    "OBSTRN", "UWTROC", "WRECKS",
    "SEAARE", "LAKARE", "BRIDGE", "SLCONS",
    "TOPMAR", "LNDMRK", "LNDELV", "LNDRGN",
    "FERYRT", "RDOSTA", "PILPNT", "FOGSIG",
    "CBLOHD", "CBLSUB", "PIPSOL",
    "MORFAC", "DAMCON", "PONTON", "PYLONS",
    "ACHBRT", "CTRPNT", "FSHFAC", "MARCUL",
    "DWRTPT", "TWRTPT", "RTPBCN", "RDOCAL",
    "UNSARE", "SBDARE", "WEDKLP",
    "M_COVR", "M_QUAL",
]

DISPLAY_CATEGORIES = {
    "depth": ["DEPARE", "DEPCNT", "SBDARE"],
    "sounding": ["SOUNDG"],
    "light": ["LIGHTS", "FOGSIG"],
    "beacon": ["BCNCAR", "BCNISD", "BCNLAT", "RTPBCN"],
    "buoy": ["BOYISD", "BOYLAT", "BOYSAW", "BOYSPP"],
    "obstruction": ["OBSTRN", "UWTROC"],
    "wreck": ["WRECKS"],
    "land": ["LNDARE", "LNDMRK", "LNDELV", "LNDRGN", "LAKARE"],
    "coastline": ["COALNE", "SLCONS"],
    "navigation": ["DWRTPT", "TWRTPT", "FERYRT", "RDOCAL", "RDOSTA", "ACHBRT", "CTRPNT"],
    "infrastructure": ["BRIDGE", "CBLOHD", "CBLSUB", "PIPSOL", "MORFAC", "DAMCON", "PONTON", "PYLONS"],
    "coverage": ["M_COVR", "M_QUAL"],
}

chart_index: dict = {}
last_load_report: dict | None = None

SCALE_BAND_LABELS = {
    1: "1:3,500,000 (Ocean)",
    2: "1:700,000 (Coastal)",
    3: "1:180,000 (Approach)",
    4: "1:90,000 (Coastal detail)",
    5: "1:22,000 (Harbour approach)",
    6: "1:12,000 (Harbour)",
}


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
                "name": "Default sample (public/sample)",
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
    return payload


def _pick_folder_dialog() -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return None

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    path = filedialog.askdirectory(title="Select ENC folder (S-57 .000 files)")
    root.destroy()
    return path or None


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
        chart_index = {}
        build_chart_index()

    return _datasource_result_payload()


def parse_wkb_point(wkb: bytes):
    bo = "<" if wkb[0] == 1 else ">"
    wkb_type = struct.unpack(f"{bo}I", wkb[1:5])[0]
    if wkb_type == 1:
        x, y = struct.unpack(f"{bo}dd", wkb[5:21])
        return {"type": "Point", "coordinates": [round(x, 7), round(y, 7)]}
    elif wkb_type == 1001:
        x, y, z = struct.unpack(f"{bo}ddd", wkb[5:29])
        return {"type": "Point", "coordinates": [round(x, 7), round(y, 7), round(z, 2)]}
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
        if sub_type == 1001:
            x, y, z = struct.unpack(f"{sub_bo}ddd", wkb[offset + 5:offset + 29])
            points.append([round(x, 7), round(y, 7), round(z, 2)])
            offset += 29
        elif sub_type == 1:
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

        important_attrs = {
            "SOUNDG": ["OBJNAM"],
            "LIGHTS": ["COLOUR", "CATLIT", "SECTR1", "SECTR2", "SIGPER", "SIGGRP", "LITCHR", "HEIGHT", "VALNMR", "OBJNAM"],
            "DEPARE": ["DRVAL1", "DRVAL2"],
            "DEPCNT": ["VALDCO"],
            "BOYISD": ["COLOUR", "BOYSHP", "OBJNAM"],
            "BOYLAT": ["COLOUR", "BOYSHP", "CATLAM", "OBJNAM"],
            "BOYSAW": ["COLOUR", "BOYSHP", "OBJNAM"],
            "BOYSPP": ["COLOUR", "BOYSHP", "CATSPM", "OBJNAM"],
            "BCNCAR": ["COLOUR", "BCNSHP", "CATCAM", "OBJNAM"],
            "BCNISD": ["COLOUR", "BCNSHP", "OBJNAM"],
            "BCNLAT": ["COLOUR", "BCNSHP", "CATLAM", "OBJNAM"],
            "OBSTRN": ["CATOBS", "VALSOU", "WATLEV", "OBJNAM"],
            "UWTROC": ["VALSOU", "WATLEV", "OBJNAM"],
            "WRECKS": ["CATWRK", "VALSOU", "WATLEV", "OBJNAM"],
            "LNDMRK": ["CATLMK", "CONVIS", "OBJNAM", "NOBJNM"],
            "LNDARE": ["OBJNAM", "NOBJNM"],
            "SEAARE": ["OBJNAM", "NOBJNM"],
            "COALNE": ["CATCOA"],
            "BRIDGE": ["VERCLR", "VERCCL", "VERCOP", "OBJNAM"],
        }
        keep_attrs = important_attrs.get(layer, ["OBJNAM", "NOBJNM"])
        keep_indices = []
        for attr in keep_attrs:
            if attr in field_names:
                keep_indices.append((attr, field_names.index(attr)))

        for i, geom_wkb in enumerate(geometries):
            geom = parse_wkb(geom_wkb)
            if geom is None:
                continue

            props = {"layer": layer}
            for attr_name, idx in keep_indices:
                val = field_arrays[idx][i]
                if val is not None and str(val) != "" and str(val) != "nan":
                    if hasattr(val, "item"):
                        val = val.item()
                    props[attr_name] = val

            if layer == "SOUNDG" and geom["type"] == "MultiPoint":
                for coord in geom["coordinates"]:
                    features.append({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": coord},
                        "properties": {**props, "depth": coord[2] if len(coord) > 2 else None},
                    })
            else:
                features.append({
                    "type": "Feature",
                    "geometry": geom,
                    "properties": props,
                })
    except Exception as e:
        pass
    return features


@app.on_event("startup")
async def startup():
    """Always load bundled public/sample on server start."""
    if DEFAULT_SAMPLE_DIR.is_dir() and find_chart_files(DEFAULT_SAMPLE_DIR):
        _start_datasource_load(None, mode="default")


@app.get("/api/datasource")
async def get_datasource_status():
    return JSONResponse(datasource_payload())


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
    path = await loop.run_in_executor(None, _pick_folder_dialog)
    if not path:
        return JSONResponse({"cancelled": True})
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


@app.get("/api/charts")
async def get_charts(
    west: float = Query(...),
    south: float = Query(...),
    east: float = Query(...),
    north: float = Query(...),
    zoom: int = Query(5),
    layers: str = Query(""),
):
    if zoom <= 5:
        target_scales = [1, 2]
    elif zoom <= 7:
        target_scales = [1, 2, 3]
    elif zoom <= 9:
        target_scales = [2, 3, 4]
    elif zoom <= 11:
        target_scales = [3, 4, 5]
    elif zoom <= 13:
        target_scales = [4, 5, 6]
    else:
        target_scales = [5, 6]

    if not chart_index:
        return JSONResponse({
            "type": "FeatureCollection",
            "features": [],
            "meta": {
                "charts_loaded": 0,
                "charts_matched": 0,
                "total_features": 0,
                "zoom": zoom,
                "target_scales": target_scales,
            },
        })

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

    max_charts = 30
    loaded_charts = matching_charts[:max_charts]

    all_features = []
    features_by_layer: dict[str, int] = {}
    chart_details = []
    for chart_name, chart in loaded_charts:
        chart_features = 0
        for layer in chart["layers"]:
            if requested_layers and layer not in requested_layers:
                continue

            cache_key = hashlib.md5(f"{chart['path']}:{layer}".encode()).hexdigest()
            cache_file = CACHE_DIR / f"{cache_key}.json"

            if cache_file.exists():
                with open(cache_file, "r") as f:
                    features = json.load(f)
            else:
                features = read_s57_layer(chart["path"], layer)
                with open(cache_file, "w") as f:
                    json.dump(features, f)

            n = len(features)
            chart_features += n
            features_by_layer[layer] = features_by_layer.get(layer, 0) + n
            all_features.extend(features)

        chart_details.append({
            "name": chart_name,
            "file": _chart_display_name(chart_name),
            "scale": chart["scale"],
            "scale_label": SCALE_BAND_LABELS.get(chart["scale"], f"Band {chart['scale']}"),
            "features": chart_features,
            "layers_used": len([
                l for l in chart["layers"]
                if not requested_layers or l in requested_layers
            ]),
        })

    layer_breakdown = [
        {"layer": layer, "features": count}
        for layer, count in sorted(features_by_layer.items(), key=lambda x: (-x[1], x[0]))
    ]

    return JSONResponse({
        "type": "FeatureCollection",
        "features": all_features,
        "meta": {
            "charts_loaded": len(loaded_charts),
            "charts_matched": charts_matched,
            "charts_capped": charts_matched > max_charts,
            "max_charts": max_charts,
            "total_features": len(all_features),
            "zoom": zoom,
            "target_scales": target_scales,
            "target_scale_labels": [SCALE_BAND_LABELS.get(s, str(s)) for s in target_scales],
            "viewport": {"west": west, "south": south, "east": east, "north": north},
            "charts": chart_details,
            "features_by_layer": layer_breakdown[:20],
        }
    })


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
