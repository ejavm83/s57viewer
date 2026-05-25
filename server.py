import os
import json
import math
import struct
import hashlib
import shutil
import time
import asyncio
import logging
from collections import deque
from datetime import date
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, Query, File, UploadFile, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

import pyogrio
from pyogrio.raw import read as ogr_read

logger = logging.getLogger("s57viewer")

# HTTP paths polled often — not logged per request (progress is logged from _set_load_progress).
_HTTP_QUIET_PATHS = frozenset({"/api/datasource/progress", "/health"})
# Routine map pan/zoom; log only when slow or failed.
_CHARTS_LOG_SLOW_MS = 400

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _format_http_log(
    method: str,
    path: str,
    status: int,
    elapsed_ms: float,
    query: str,
) -> str | None:
    if path in _HTTP_QUIET_PATHS:
        return None
    if path == "/api/charts" and status == 200 and elapsed_ms < _CHARTS_LOG_SLOW_MS:
        return None

    label = _HTTP_PATH_LABELS.get(path)
    if label is None and path.startswith("/api/datasource/sample/"):
        label = "샘플 데이터셋 로드"
    elif label is None and path.startswith("/api/chart/"):
        label = "단일 차트 조회"
    elif label is None and method == "GET" and path == "/":
        label = "메인 페이지"
    elif label is None:
        label = path.removeprefix("/api/") or path

    if path == "/api/charts":
        zoom = ""
        for part in query.split("&"):
            if part.startswith("zoom="):
                zoom = part[5:]
                break
        zoom_note = f", zoom {zoom}" if zoom else ""
        return f"{label} — HTTP {status}, {elapsed_ms:.0f}ms{zoom_note}"

    verb = {"GET": "조회", "POST": "요청", "PUT": "변경", "DELETE": "삭제"}.get(method, method)
    return f"{label} ({verb}) — HTTP {status}, {elapsed_ms:.0f}ms"


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/admin/logs"):
        return await call_next(request)
    start = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    except Exception:
        logger.exception("요청 처리 오류: %s %s", request.method, path)
        raise
    finally:
        elapsed_ms = (time.perf_counter() - start) * 1000
        if path.startswith("/api/") or path in ("/", "/health"):
            msg = _format_http_log(
                request.method, path, status_code, elapsed_ms, request.url.query
            )
            if msg:
                if status_code >= 500:
                    logger.error(msg)
                elif status_code >= 400:
                    logger.warning(msg)
                else:
                    logger.info(msg)

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

# WGS84 min/max lon/lat — bundled default sample only: skip ENC cells that do not overlap this
# box (fewer charts → faster index & first map load). Set DEFAULT_SAMPLE_INDEX_BOUNDS=all to index every .000.
KOREA_DEFAULT_SAMPLE_INDEX_BOUNDS: tuple[float, float, float, float] = (
    123.95,
    33.45,
    131.05,
    38.72,
)


def _wgs84_bounds_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def _use_default_sample_index_bounds_filter() -> bool:
    """Narrow index only for the single-folder bundled default demo (not user uploads / multi-root)."""
    if len(chart_source_dirs) != 1 or datasource_mode != "default":
        return False
    try:
        return chart_source_dirs[0].resolve() == DEFAULT_SAMPLE_DIR.resolve()
    except OSError:
        return False


def _default_sample_index_clip_bounds() -> tuple[float, float, float, float] | None:
    """WGS84 box [west,south,east,north] to intersect; None = index all .000 in the default folder."""
    if not _use_default_sample_index_bounds_filter():
        return None
    raw = (os.environ.get("DEFAULT_SAMPLE_INDEX_BOUNDS") or "").strip()
    if raw.lower() in ("all", "full", "none", "off", "0"):
        return None
    if not raw:
        return KOREA_DEFAULT_SAMPLE_INDEX_BOUNDS
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        logger.warning(
            "DEFAULT_SAMPLE_INDEX_BOUNDS must be west,south,east,north — ignoring invalid value %r",
            raw,
        )
        return KOREA_DEFAULT_SAMPLE_INDEX_BOUNDS
    try:
        w, s, e, n = (float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]))
    except ValueError:
        logger.warning("DEFAULT_SAMPLE_INDEX_BOUNDS has non-numeric parts — using built-in Korea clip")
        return KOREA_DEFAULT_SAMPLE_INDEX_BOUNDS
    return (w, s, e, n)


def _sample_index_bounds_sig(clip: tuple[float, float, float, float] | None) -> str:
    if clip is None:
        return "none"
    return f"{clip[0]:.5f},{clip[1]:.5f},{clip[2]:.5f},{clip[3]:.5f}"


UPLOAD_DIR = CACHE_DIR / "uploads"
DATASOURCE_STATE_FILE = CACHE_DIR / "datasource_state.json"
chart_source_dirs: list[Path] = []
datasource_mode: str = "default"
CACHE_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)
LOG_DIR = CACHE_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"
LOG_DIR.mkdir(exist_ok=True)
VIEWPORT_RESPONSE_DIR = CACHE_DIR / "viewport_responses"
VIEWPORT_RESPONSE_DIR.mkdir(exist_ok=True)

_log_records: deque = deque(maxlen=4000)
_log_buf_lock = Lock()
_last_progress_log_key = ""

_HTTP_PATH_LABELS: dict[str, str] = {
    "/": "메인 페이지",
    "/api/datasource": "데이터 소스 상태",
    "/api/datasource/default": "기본 샘플 로드",
    "/api/datasource/browse": "폴더 선택 로드",
    "/api/datasource/upload": "파일 업로드",
    "/api/datasource/report": "로드 리포트",
    "/api/datasource/samples": "샘플 목록",
    "/api/charts": "지도 레이어",
    "/api/index": "차트 인덱스",
    "/api/categories": "레이어 카테고리",
    "/api/s52-settings": "S-52 설정",
    "/api/s57-settings": "S-52 설정",
    "/api/visitors": "방문자",
    "/api/admin/status": "관리자 상태",
}


class _ServerLogFilter(logging.Filter):
    """Short, readable uvicorn / watchfiles lines on the console."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "WatchFiles detected changes" in msg:
            record.msg = "코드 변경 감지 — 서버 재시작 중…"
            record.args = ()
        elif msg.startswith("Started server process"):
            record.msg = "서버 워커 시작"
            record.args = ()
        elif msg == "Waiting for application startup.":
            record.msg = "앱 초기화 중…"
            record.args = ()
        elif msg == "Application startup complete.":
            record.msg = "서버 준비 완료 — 요청을 받을 수 있습니다"
            record.args = ()
        elif msg.startswith("Shutting down"):
            record.msg = "서버 종료 중…"
            record.args = ()
        elif msg.startswith("Waiting for application shutdown."):
            record.msg = "앱 종료 처리 중…"
            record.args = ()
        elif msg == "Application shutdown complete.":
            record.msg = "서버 종료 완료"
            record.args = ()
        elif msg == "Finished server process":
            record.msg = "서버 프로세스 종료"
            record.args = ()
        elif "Uvicorn running on" in msg:
            record.msg = msg.replace("Uvicorn running on", "서버 주소")
            record.args = ()
        elif '"GET ' in msg or '"POST ' in msg:
            return False
        return True


class _RingBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = _log_record_to_dict(record)
            with _log_buf_lock:
                _log_records.append(entry)
        except Exception:
            self.handleError(record)


def _log_record_to_dict(record: logging.LogRecord) -> dict:
    return {
        "ts": record.created,
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(record.created)),
        "level": record.levelname,
        "logger": record.name,
        "message": record.getMessage(),
    }


def _configure_app_logging() -> None:
    root = logging.getLogger("s57viewer")
    if root.handlers:
        return
    root.setLevel(logging.DEBUG)
    file_fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    console_fmt = logging.Formatter("[%(asctime)s] %(message)s", datefmt="%H:%M:%S")

    console = logging.StreamHandler()
    console.setFormatter(console_fmt)
    console.setLevel(logging.INFO)
    root.addHandler(console)

    ring = _RingBufferHandler()
    ring.setFormatter(file_fmt)
    root.addHandler(ring)
    try:
        file_handler = RotatingFileHandler(
            LOG_FILE,
            maxBytes=2_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setFormatter(file_fmt)
        root.addHandler(file_handler)
    except OSError as exc:
        import sys
        print(f"Warning: could not open log file {LOG_FILE}: {exc}", file=sys.stderr)


def _uvicorn_log_config() -> dict:
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "human": {
                "format": "[%(asctime)s] %(message)s",
                "datefmt": "%H:%M:%S",
            },
        },
        "filters": {
            "friendly": {"()": "server._ServerLogFilter"},
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "human",
                "filters": ["friendly"],
                "stream": "ext://sys.stderr",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["console"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"handlers": ["console"], "level": "INFO", "propagate": False},
            "uvicorn.access": {"handlers": [], "level": "CRITICAL", "propagate": False},
            "watchfiles": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        },
    }


_configure_app_logging()


def _parse_log_line(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        if len(line) >= 19 and line[4] == "-" and line[10] == " ":
            time_part = line[:19]
            rest = line[20:]
            level, _, message = rest.partition(" ")
            if level in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
                logger_name = ""
                if ": " in message:
                    logger_name, _, message = message.partition(": ")
                return {
                    "ts": time.mktime(time.strptime(time_part, "%Y-%m-%d %H:%M:%S")),
                    "time": time_part,
                    "level": level,
                    "logger": logger_name,
                    "message": message,
                }
    except (ValueError, OSError):
        pass
    return {"ts": time.time(), "time": "", "level": "INFO", "logger": "", "message": line}


def _read_log_file_tail(max_lines: int) -> list[dict]:
    if not LOG_FILE.is_file() or max_lines <= 0:
        return []
    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    entries: list[dict] = []
    for line in lines[-max_lines:]:
        entry = _parse_log_line(line)
        if entry:
            entries.append(entry)
    return entries


def _collect_log_entries(*, max_lines: int = 500, level: str | None = None) -> list[dict]:
    level_filter = (level or "").upper()
    with _log_buf_lock:
        buffer_entries = list(_log_records)
    file_entries = _read_log_file_tail(max_lines * 2)
    merged: dict[tuple, dict] = {}
    for entry in file_entries + buffer_entries:
        key = (entry.get("time"), entry.get("level"), entry.get("message"))
        merged[key] = entry
    entries = sorted(merged.values(), key=lambda e: e.get("ts", 0))
    if level_filter:
        entries = [e for e in entries if e.get("level") == level_filter]
    return entries[-max_lines:]


def _require_admin_access(request: Request) -> None:
    expected_key = os.environ.get("ADMIN_LOG_KEY", "").strip()
    if expected_key:
        provided = request.headers.get("X-S57-Admin-Key", "")
        if provided == expected_key:
            return
        raise HTTPException(status_code=403, detail="Admin log access denied.")
    client = request.client
    host = (client.host if client else "").lower()
    if host in ("127.0.0.1", "::1", "localhost"):
        return
    raise HTTPException(
        status_code=403,
        detail="Admin logs are only available on localhost (or set ADMIN_LOG_KEY).",
    )
def _executor_workers(default: int, cap: int) -> int:
    """Keep GDAL/pyogrio thread pools small on Render free tier (512MB RAM)."""
    if os.environ.get("RENDER") == "true":
        try:
            cpus = float(os.environ.get("RENDER_CPU_COUNT", "0.5"))
        except ValueError:
            cpus = 0.5
        return max(1, min(cap, int(cpus * 4) or 1))
    return min(default, os.cpu_count() or 4)


_CHARTS_POOL = ThreadPoolExecutor(
    max_workers=_executor_workers(12, 6),
    thread_name_prefix="s57charts",
)
_LAYER_POOL = ThreadPoolExecutor(
    max_workers=_executor_workers(6, 3),
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
    "files_found": 0,
    "indexed_ok": 0,
    "indexed_failed": 0,
    "current_file": "",
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
    "traffic": ["RESARE", "TSSBND", "TSELNE", "ISTZNE", "TSSLPT", "TSSRON", "ACHBRT", "ACHARE"],
    "navigation": ["DWRTPT", "TWRTPT", "FAIRWY", "FERYRT", "RDOCAL", "RDOSTA", "CTRPNT",
                   "PILPNT", "PILBOP"],
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
CHARTS_API_VERSION = 5


def _viewport_intersection_area(
    bounds: tuple[float, float, float, float],
    west: float,
    south: float,
    east: float,
    north: float,
) -> float:
    iw = max(0.0, min(bounds[2], east) - max(bounds[0], west))
    ih = max(0.0, min(bounds[3], north) - max(bounds[1], south))
    return iw * ih


def _chart_viewport_rank(
    info: dict,
    west: float,
    south: float,
    east: float,
    north: float,
    primary_scale: int,
) -> tuple:
    overlap = _viewport_intersection_area(info["bounds"], west, south, east, north)
    scale_dist = abs(info["scale"] - primary_scale)
    return (-overlap, scale_dist, info["bounds"][0], info["bounds"][1])


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


def _save_datasource_state() -> None:
    if not chart_source_dirs:
        return
    state = {
        "mode": datasource_mode,
        "chart_source_dirs": [str(p.resolve()) for p in chart_source_dirs],
        "chart_count": len(chart_index),
    }
    try:
        tmp = DATASOURCE_STATE_FILE.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        tmp.replace(DATASOURCE_STATE_FILE)
    except OSError as exc:
        logger.warning("Could not save datasource state: %s", exc)


def _load_datasource_state() -> dict | None:
    if not DATASOURCE_STATE_FILE.is_file():
        return None
    try:
        with open(DATASOURCE_STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def _restore_persisted_datasource() -> bool:
    """Resume last user-selected folder after dev-server reload, if still on disk."""
    if os.environ.get("S57_DIR"):
        return False
    state = _load_datasource_state()
    if not state:
        return False
    mode = _normalize_load_mode(state.get("mode", "replace"))
    if mode == "default":
        return False
    raw_dirs = state.get("chart_source_dirs") or []
    roots: list[Path] = []
    for item in raw_dirs:
        p = Path(item)
        if p.is_dir() and _dir_has_charts(p):
            roots.append(p.resolve())
    if not roots:
        return False
    default_resolved = DEFAULT_SAMPLE_DIR.resolve()
    if mode == "add":
        user_root = next((p for p in roots if p != default_resolved), None)
        if not user_root:
            return False
        _apply_chart_sources("add", user_root)
    else:
        _apply_chart_sources("replace", roots[0])
    return True


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
    clip = _default_sample_index_clip_bounds()
    if clip is not None:
        key_src += "|clip=" + _sample_index_bounds_sig(clip)
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


def _enrich_indexed_entries(indexed: list[dict]) -> list[dict]:
    """Attach path, source, and layer list from chart_index for detailed reports."""
    enriched: list[dict] = []
    for entry in indexed:
        name = entry.get("name")
        info = chart_index.get(name) if name else None
        if not info:
            enriched.append(entry)
            continue
        item = dict(entry)
        item["path"] = info.get("path", "")
        item["source"] = info.get("source", "")
        layers = list(info.get("layers", []))
        item["layers"] = layers
        scale = entry.get("scale")
        if scale is not None:
            item["nominal_scale"] = SCALE_BAND_NOMINAL_DENOM.get(int(scale))
        enriched.append(item)
    return enriched


def _build_load_report(
    *,
    files_found: int,
    indexed: list[dict],
    failed: list[dict],
    from_cache: bool,
    duration_sec: float | None = None,
    skipped_bounds: list[dict] | None = None,
) -> dict:
    indexed_ok = len(indexed)
    failed_count = len(failed)
    skipped_bounds = skipped_bounds or []
    scale_counts = {}
    for item in indexed:
        band = str(item["scale"])
        scale_counts[band] = scale_counts.get(band, 0) + 1

    layer_counts = [item["layer_count"] for item in indexed]
    summary = {
        "files_found": files_found,
        "indexed_ok": indexed_ok,
        "indexed_failed": failed_count,
        "skipped_outside_bounds": len(skipped_bounds),
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
        "all_layers": _layer_frequency(chart_index, limit=9999),
        "total_layer_instances": sum(len(info.get("layers", [])) for info in chart_index.values()),
        "unique_layers": len({layer for info in chart_index.values() for layer in info.get("layers", [])}),
    }
    return {
        "generated_at": time.time(),
        "path": _format_datasource_paths(),
        "paths": [str(p) for p in chart_source_dirs],
        "mode": datasource_mode,
        "summary": summary,
        "indexed": _enrich_indexed_entries(indexed),
        "failed": failed,
        "skipped_bounds": skipped_bounds,
    }


def _finalize_load_report(
    files_found: int,
    indexed_entries: list[dict],
    failed_entries: list[dict],
    *,
    from_cache: bool,
    started_at: float | None = None,
    skipped_bounds: list[dict] | None = None,
) -> dict:
    global last_load_report
    duration = (time.time() - started_at) if started_at else None
    skipped_bounds = skipped_bounds or []
    last_load_report = _build_load_report(
        files_found=files_found,
        indexed=indexed_entries,
        failed=failed_entries,
        from_cache=from_cache,
        duration_sec=duration,
        skipped_bounds=skipped_bounds,
    )
    summary = last_load_report["summary"]
    cache_note = " (cache)" if from_cache else ""
    duration_note = f", {summary['duration_sec']}s" if summary.get("duration_sec") is not None else ""
    logger.info(
        "로드 리포트%s: .000 %d개, 성공 %d, 실패 %d, 범위외 제외 %d%s — %s",
        cache_note,
        summary["files_found"],
        summary["indexed_ok"],
        summary["indexed_failed"],
        summary.get("skipped_outside_bounds", 0),
        duration_note,
        _format_datasource_paths() or "(경로 없음)",
    )
    if failed_entries:
        for item in failed_entries[:5]:
            logger.warning("Chart index failed: %s — %s", item.get("file"), item.get("error"))
        if len(failed_entries) > 5:
            logger.warning("… and %d more failed chart(s)", len(failed_entries) - 5)
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
            "files_found": _load_progress.get("files_found", 0),
            "indexed_ok": _load_progress.get("indexed_ok", 0),
            "indexed_failed": _load_progress.get("indexed_failed", 0),
            "current_file": _load_progress.get("current_file", ""),
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
    files_found: int | None = None,
    indexed_ok: int | None = None,
    indexed_failed: int | None = None,
    current_file: str | None = None,
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
        if files_found is not None:
            _load_progress["files_found"] = files_found
        if indexed_ok is not None:
            _load_progress["indexed_ok"] = indexed_ok
        if indexed_failed is not None:
            _load_progress["indexed_failed"] = indexed_failed
        if current_file is not None:
            _load_progress["current_file"] = current_file
    _emit_load_progress_log()


def _emit_load_progress_log() -> None:
    global _last_progress_log_key
    with _load_progress_lock:
        status = _load_progress["status"]
        phase = _load_progress["phase"]
        pct = _load_progress["percent"]
        current = _load_progress["current"]
        total = _load_progress["total"]
        message = _load_progress["message"]
        error = _load_progress.get("error")

    if status == "idle":
        return

    if status in ("done", "error"):
        key = status
    elif phase == "index" and total > 0:
        key = f"index:{pct // 10}"
    else:
        key = f"{status}:{phase}:{message[:48]}"

    if key == _last_progress_log_key:
        return
    _last_progress_log_key = key

    if status == "done":
        logger.info("차트 로드 완료 — %s", message)
    elif status == "error":
        logger.error("차트 로드 실패 — %s", error or message)
    elif phase == "index" and total > 0:
        logger.info("차트 인덱싱 %d%% — %s (%d/%d)", pct, message, current, total)
    elif phase == "scan":
        logger.info("차트 폴더 스캔 — %s", message)
    else:
        logger.info("차트 로드 — %s", message)


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

        path_label = _format_datasource_paths() or str(root)
        logger.info("차트 폴더 로드 시작 (mode=%s): %s", mode, path_label)
        _set_load_progress("scan", 0, 0, ".000 차트 파일 검색 중…", status="running")
        _apply_chart_sources(mode, root)
        chart_files = _iter_indexed_chart_files()
        files_found = len(chart_files)
        if not chart_files:
            raise ValueError("No .000 chart files found in the configured data source(s).")

        logger.info("스캔 완료: %d개 .000 파일 (%s)", files_found, path_label)
        _set_load_progress(
            "scan",
            0,
            files_found,
            f"Found {files_found} .000 chart file(s) — building index…",
            files_found=files_found,
        )

        clear_viewport_response_cache()
        chart_index = {}
        build_chart_index(on_progress=_index_progress_callback)

        result = _datasource_result_payload()
        mode_label = {"default": "default sample", "add": "added to sample", "replace": "replaced"}[mode]
        _save_datasource_state()
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


def _index_progress_callback(
    current: int,
    total: int,
    message: str,
    *,
    indexed_ok: int | None = None,
    indexed_failed: int | None = None,
    current_file: str | None = None,
) -> None:
    _set_load_progress(
        "index",
        current,
        total,
        message,
        indexed_ok=indexed_ok,
        indexed_failed=indexed_failed,
        current_file=current_file,
    )


def _start_datasource_load(
    root: Path | None,
    *,
    mode: str = "replace",
    already_running: bool = False,
) -> None:
    global _last_progress_log_key
    with _load_progress_lock:
        if not already_running:
            if _load_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="Chart data is already loading.")
            _load_progress["status"] = "running"
            _load_progress["error"] = None
            _load_progress["result"] = None
            _load_progress["percent"] = 0
            _load_progress["files_found"] = 0
            _load_progress["indexed_ok"] = 0
            _load_progress["indexed_failed"] = 0
            _load_progress["current_file"] = ""
    _last_progress_log_key = ""

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

    _save_datasource_state()
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


# S-57 line features (e.g. some TSS / admin boundaries) sometimes chain disjoint legs in one
# vertex list. Connecting those legs draws spurious chords — split when a step exceeds the gap.
LINE_VERTEX_GAP_DEG = 0.025
# Cables / pipelines / long infrastructure lines often have legitimately sparse vertices ( ≫ 0.025°
# apart). Using the default gap falsely splits one feature and **drops** the long edge (see
# _split_line_coords: large gaps end a part and start a new part without drawing the jump).
LINE_SPARSE_VERTEX_GAP_DEG = 2.5
LINE_SPARSE_VERTEX_LAYERS = frozenset(
    {"CBLSUB", "CBLOHD", "PIPSOL", "BRIDGE", "MORFAC", "DAMCON", "PONTON", "PYLONS", "HULKES"}
)


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


def _line_split_gap_deg_for_layer(layer: str | None) -> float:
    if layer and layer in LINE_SPARSE_VERTEX_LAYERS:
        return LINE_SPARSE_VERTEX_GAP_DEG
    return LINE_VERTEX_GAP_DEG


def _normalize_line_geometry(geom: dict | None, layer: str | None = None) -> dict | None:
    if not geom:
        return geom
    max_gap = _line_split_gap_deg_for_layer(layer)
    gtype = geom.get("type")
    if gtype == "LineString":
        parts = _split_line_coords(geom["coordinates"], max_gap_deg=max_gap)
        if len(parts) <= 1:
            return geom
        return {"type": "MultiLineString", "coordinates": parts}
    if gtype == "MultiLineString":
        parts: list[list] = []
        for line in geom["coordinates"]:
            parts.extend(_split_line_coords(line, max_gap_deg=max_gap))
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
        logger.warning("Could not write %s: %s", path.name, exc)


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
        logger.info("No chart sources configured, skipping index build")
        return

    started_at = time.time()
    chart_file_entries = _iter_indexed_chart_files()
    files_found = len(chart_file_entries)
    file_keys = {key for key, _ in chart_file_entries}
    clip_bounds = _default_sample_index_clip_bounds()

    cache_path = index_cache_path()
    if cache_path and cache_path.exists():
        if on_progress:
            on_progress(0, 0, "Loading chart index from cache…")
        with open(cache_path, "r", encoding="utf-8") as f:
            loaded_raw = json.load(f)
        if not isinstance(loaded_raw, dict):
            loaded_raw = {}
        meta = loaded_raw.pop("__index_meta__", None)
        loaded = loaded_raw
        loaded_keys = set(loaded.keys())

        if clip_bounds is not None:
            cache_ok = (
                isinstance(meta, dict)
                and meta.get("bounds_sig") == _sample_index_bounds_sig(clip_bounds)
                and set(meta.get("disk_keys", [])) == file_keys
                and loaded_keys <= file_keys
            )
        else:
            cache_ok = file_keys.issubset(loaded_keys) and len(loaded_keys) == len(file_keys)

        if not cache_ok:
            logger.info(
                "Chart index cache stale (%d cached, %d on disk, clip=%s); rebuilding",
                len(loaded_keys),
                len(file_keys),
                _sample_index_bounds_sig(clip_bounds),
            )
        else:
            with _datasource_lock:
                chart_index = loaded
            logger.info("Loaded chart index from cache: %d charts", len(chart_index))
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
            failed_entries: list[dict] = []
            if clip_bounds is None:
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
                skipped_bounds=[],
            )
            if on_progress:
                n = len(chart_index)
                on_progress(
                    n,
                    n,
                    f"Loaded {n} chart(s) from cache",
                    indexed_ok=len(indexed_entries),
                    indexed_failed=len(failed_entries),
                )
            refresh_s52_mariner_settings()
            return

    logger.info(
        "Building chart index from %d source(s); default-sample clip=%s",
        len(chart_source_dirs),
        _sample_index_bounds_sig(clip_bounds),
    )
    total = files_found
    if on_progress:
        on_progress(
            0,
            total,
            f"Indexing charts (0/{total})…",
            indexed_ok=0,
            indexed_failed=0,
        )

    with _datasource_lock:
        chart_index = {}

    indexed_entries: list[dict] = []
    failed_entries: list[dict] = []
    skipped_bounds: list[dict] = []

    def process_file(chart_key: str, fpath: Path):
        try:
            info = pyogrio.read_info(str(fpath), layer="M_COVR")
            bounds = info["total_bounds"]
            tb = tuple(float(x) for x in bounds)
            if clip_bounds is not None and not _wgs84_bounds_overlap(tb, clip_bounds):
                return chart_key, None, None, "outside_demo_bounds"
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
            elif err == "outside_demo_bounds":
                skipped_bounds.append({
                    "name": name,
                    "file": _chart_display_name(name),
                    "reason": "outside DEFAULT_SAMPLE_INDEX_BOUNDS (demo clip)",
                })
            else:
                failed_entries.append({
                    "name": name,
                    "file": _chart_display_name(name),
                    "error": err or "Unknown error",
                })
            display_name = _chart_display_name(name)
            ok_count = len(indexed_entries)
            fail_count = len(failed_entries)
            if on_progress and (done == 1 or done % 5 == 0 or done == total):
                on_progress(
                    done,
                    total,
                    f"Indexing ({done}/{total}): {display_name}",
                    indexed_ok=ok_count,
                    indexed_failed=fail_count,
                    current_file=display_name,
                )

    indexed_entries.sort(key=lambda x: (x["scale"], x["file"]))
    failed_entries.sort(key=lambda x: x["file"])

    logger.info(
        "Indexed %d charts (%d failed, %d skipped outside demo bounds)",
        len(chart_index),
        len(failed_entries),
        len(skipped_bounds),
    )
    refresh_s52_mariner_settings()
    if cache_path:
        out_obj: dict = dict(chart_index)
        if clip_bounds is not None:
            out_obj["__index_meta__"] = {
                "bounds_sig": _sample_index_bounds_sig(clip_bounds),
                "disk_keys": sorted(file_keys),
            }
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(out_obj, f)
    _finalize_load_report(
        files_found,
        indexed_entries,
        failed_entries,
        from_cache=False,
        started_at=started_at,
        skipped_bounds=skipped_bounds,
    )
    if on_progress:
        n = len(chart_index)
        on_progress(
            n,
            n,
            f"Indexed {n} chart file(s) ({len(failed_entries)} failed, {len(skipped_bounds)} skipped)",
            indexed_ok=len(indexed_entries),
            indexed_failed=len(failed_entries),
        )


def read_s57_layer(
    filepath: str,
    layer: str,
    bbox: tuple[float, float, float, float] | None = None,
):
    features = []
    try:
        read_kwargs: dict = {}
        if bbox is not None:
            read_kwargs["bbox"] = bbox
        result = ogr_read(filepath, layer=layer, **read_kwargs)
        meta = result[0]
        geometries = result[2]
        field_arrays = result[3]
        field_names = list(meta["fields"])

        keep_indices = _attrs_for_layer(layer, field_names)

        for i, geom_wkb in enumerate(geometries):
            geom = parse_wkb(geom_wkb)
            if geom is None:
                continue
            geom = _normalize_line_geometry(geom, layer=layer)

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
    logger.info("S-57 Web Viewer starting (log file: %s)", LOG_FILE)
    if os.environ.get("S57_DIR"):
        root = Path(os.environ["S57_DIR"]).resolve()
        if root.is_dir() and _dir_has_charts(root):
            _start_datasource_load(root, mode="replace")
        return
    if _restore_persisted_datasource():
        _start_datasource_load(chart_source_dirs[0], mode=datasource_mode)
        return
    if not DEFAULT_SAMPLE_DIR.is_dir() or not find_chart_files(DEFAULT_SAMPLE_DIR):
        return
    if os.environ.get("SKIP_STARTUP_CHART_LOAD", "").lower() in ("1", "true", "yes"):
        _apply_chart_sources("default", DEFAULT_SAMPLE_DIR.resolve())
        await asyncio.to_thread(build_chart_index)
        return
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

    global _last_progress_log_key
    with _load_progress_lock:
        _load_progress["status"] = "running"
        _load_progress["error"] = None
        _load_progress["result"] = None
        _load_progress["percent"] = 0
        _load_progress["files_found"] = total
        _load_progress["indexed_ok"] = 0
        _load_progress["indexed_failed"] = 0
        _load_progress["current_file"] = ""
    _last_progress_log_key = ""

    try:
        for i, uf in enumerate(chart_files, start=1):
            safe_name = Path((uf.filename or "chart.000").replace("\\", "/").lstrip("/")).name
            _set_load_progress(
                "upload",
                i,
                total,
                f"Uploading ({i}/{total}): {safe_name}",
                status="running",
                files_found=total,
                current_file=safe_name,
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
    logger.info("Uploaded %d chart file(s) to %s (mode=%s)", total, upload_root, load_mode)
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


def _load_layer_features(
    chart_path: str,
    layer: str,
    vp: tuple[float, float, float, float] | None = None,
) -> list[dict]:
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
    features = read_s57_layer(chart_path, layer, bbox=vp)
    if vp is None:
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(features, f)
        except OSError:
            pass
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


_LOW_ZOOM_SYMBOL_LAYERS = frozenset({
    "LIGHTS", "FOGSIG",
    "BCNCAR", "BCNISD", "BCNLAT", "BCNSAW", "BCNSPP", "RTPBCN", "TOPMAR",
    "BOYCAR", "BOYISD", "BOYLAT", "BOYSAW", "BOYSPP",
    "PILPNT", "PILBOP", "RDOSTA", "CTRPNT", "RDOCAL",
    "LNDMRK", "LNDELV",
})


def _layers_skipped_at_zoom(zoom: int) -> set[str]:
    skip: set[str] = set()
    if zoom <= 8:
        skip.update(_LOW_ZOOM_SYMBOL_LAYERS)
    if zoom <= 7:
        skip.update({"OBSTRN", "UWTROC", "WRECKS", "SOUNDG"})
    elif zoom <= 6:
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
        logger.warning("Viewport load failed for %s: %s", chart_name, exc)
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
    layer_features = _load_layer_features(chart_path, layer, vp)
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

    primary_scale = _primary_scale_band_for_zoom(zoom)
    matching_charts.sort(
        key=lambda item: _chart_viewport_rank(item[1], west, south, east, north, primary_scale),
    )
    charts_matched = len(matching_charts)
    loaded_charts = matching_charts
    max_charts = charts_matched
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
            "charts_capped": False,
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
        except (OSError, FileNotFoundError):
            pass

    try:
        payload = await asyncio.to_thread(
            _build_charts_response, west, south, east, north, zoom, layers, apply_scamin,
        )
    except Exception as exc:
        logger.error("Error building charts response: %s", exc)
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


@app.get("/health")
async def health():
    """Lightweight probe for Render / load balancers (no GDAL work)."""
    return {"ok": True}


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


@app.get("/api/admin/logs")
async def get_admin_logs(
    request: Request,
    lines: int = Query(500, ge=1, le=5000),
    level: str | None = Query(None),
):
    _require_admin_access(request)
    entries = _collect_log_entries(max_lines=lines, level=level)
    file_size = LOG_FILE.stat().st_size if LOG_FILE.is_file() else 0
    with _log_buf_lock:
        buffer_count = len(_log_records)
    return JSONResponse({
        "entries": entries,
        "count": len(entries),
        "buffer_count": buffer_count,
        "file": str(LOG_FILE),
        "file_size": file_size,
    })


@app.delete("/api/admin/logs")
async def clear_admin_logs(request: Request):
    _require_admin_access(request)
    with _log_buf_lock:
        _log_records.clear()
    if LOG_FILE.is_file():
        try:
            LOG_FILE.write_text("", encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not clear log file: {exc}") from exc
    logger.info("Admin cleared application log")
    return JSONResponse({"cleared": True})


@app.get("/api/admin/status")
async def get_admin_status(request: Request):
    _require_admin_access(request)
    file_size = LOG_FILE.stat().st_size if LOG_FILE.is_file() else 0
    with _log_buf_lock:
        buffer_count = len(_log_records)
    return JSONResponse({
        "log_file": str(LOG_FILE),
        "file_size": file_size,
        "buffer_count": buffer_count,
        "chart_count": len(chart_index),
        "datasource_mode": datasource_mode,
        "datasource_paths": [str(p) for p in chart_source_dirs],
        "load_progress": _progress_snapshot(),
    })


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
        logger.warning("포트 %s 사용 중 — %s 포트로 시작합니다", start_port, port)
    logger.info("브라우저에서 열기: http://%s:%s", host, port)

    reload = os.environ.get("RELOAD", "1").lower() not in ("0", "false", "no")
    uvicorn_kwargs = {
        "host": host,
        "port": port,
        "access_log": False,
        "log_config": _uvicorn_log_config(),
    }
    if reload:
        reload_excludes = [
            "cache/*",
            "cache/**",
            "sample_data/**",
            "public/**",
            "*.json",
        ]
        uvicorn.run(
            "server:app",
            reload=True,
            reload_excludes=reload_excludes,
            **uvicorn_kwargs,
        )
    else:
        uvicorn.run(app, **uvicorn_kwargs)
