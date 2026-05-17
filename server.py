import os
import json
import struct
import hashlib
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import pyogrio
from pyogrio.raw import read as ogr_read

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_DEFAULT_S57_DIR = Path(r"C:\Users\kimkilyong\Documents\S57_KR전자해도(20240621)")
S57_DIR = Path(os.environ.get("S57_DIR", _DEFAULT_S57_DIR))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", Path(__file__).parent / "cache"))
CACHE_DIR.mkdir(exist_ok=True)

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


def build_chart_index():
    global chart_index
    if not S57_DIR.is_dir():
        print(f"S57_DIR not found, skipping index build: {S57_DIR}")
        return

    cache_path = CACHE_DIR / "chart_index.json"

    if cache_path.exists():
        with open(cache_path, "r") as f:
            chart_index = json.load(f)
        print(f"Loaded chart index from cache: {len(chart_index)} charts")
        return

    print("Building chart index from S-57 files...")
    files = sorted(S57_DIR.glob("*.000"))
    total = len(files)

    def process_file(fpath):
        try:
            info = pyogrio.read_info(str(fpath), layer="M_COVR")
            bounds = info["total_bounds"]
            layers = [l[0] for l in pyogrio.list_layers(str(fpath))]
            feature_layers = [l for l in layers if l in FEATURE_LAYERS]
            return fpath.name, {
                "path": str(fpath),
                "bounds": list(bounds),
                "scale": get_scale_from_filename(fpath.stem),
                "layers": feature_layers,
            }
        except Exception as e:
            return fpath.name, None

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(process_file, f): f for f in files}
        done = 0
        for future in as_completed(futures):
            done += 1
            name, data = future.result()
            if data:
                chart_index[name] = data
            if done % 50 == 0:
                print(f"  Indexed {done}/{total} files...")

    print(f"Indexed {len(chart_index)} charts")
    with open(cache_path, "w") as f:
        json.dump(chart_index, f)


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
    build_chart_index()


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

    requested_layers = [l.strip() for l in layers.split(",") if l.strip()] if layers else None

    matching_charts = []
    for name, info in chart_index.items():
        b = info["bounds"]
        if info["scale"] not in target_scales:
            continue
        if b[2] < west or b[0] > east or b[3] < south or b[1] > north:
            continue
        matching_charts.append(info)

    matching_charts.sort(key=lambda c: c["scale"])

    max_charts = 30
    matching_charts = matching_charts[:max_charts]

    all_features = []
    for chart in matching_charts:
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

            all_features.extend(features)

    return JSONResponse({
        "type": "FeatureCollection",
        "features": all_features,
        "meta": {
            "charts_loaded": len(matching_charts),
            "total_features": len(all_features),
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


_static = Path(__file__).parent / "static"
_public = Path(__file__).parent / "public"
app.mount("/public", StaticFiles(directory=str(_public)), name="public")
app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
