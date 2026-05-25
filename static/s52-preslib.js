/**
 * IHO S-52 Presentation Library renderer.
 *
 * Consumes the bundle produced by `scripts/build_preslib.py` (extracted from
 * OpenCPN `chartsymbols.xml`) and turns S-57 features into OpenLayers styles
 * by evaluating the standard PresLib instruction set:
 *
 *   AC(color)               – fill an area with a flat color
 *   AP(pattern[,rotation])  – tile an area with a vector or raster pattern
 *   LS(style,width,color)   – stroke a line (SOLD/DASH/DOTT)
 *   LC(line-symbol)         – stroke a line with a repeating vector symbol
 *   SY(symbol[,rotation])   – place a point symbol (raster atlas + HPGL)
 *   TE/TX(...)              – textual labels
 *   CS(procedure)           – conditional symbology procedure (CSP)
 *
 * Display category (DISPLAYBASE / STANDARD / OTHER / MARINERS), display
 * priority (Area/Hazards/Symbols), and the active color palette are all
 * honoured according to IHO S-52 §4–§9 and §13.
 */
(function (global) {
    'use strict';

    const GEOM_MAP = {
        Point: 'P', MultiPoint: 'P',
        LineString: 'L', MultiLineString: 'L',
        Polygon: 'A', MultiPolygon: 'A',
    };

    const DISPLAY_CATEGORY_RANK = {
        DISPLAYBASE: 0, STANDARD: 1, OTHER: 2, MARINERS: 3,
    };

    const DEFAULT_SETTINGS = {
        safetyContour: 10,
        shallowContour: 2,
        deepContour: 30,
        safetyDepth: 10,
        twoShades: false,
        showLowAccuracy: true,
        respectScamin: false,
        showSoundings: true,
        showText: true,
        showLightDescriptions: true,
        showBuoyLightLabels: true,
        showVisibleSectorLights: true,
        imperialLightText: true,
    };

    const LINE_DASH = { SOLD: null, DASH: [8, 4], DOTT: [2, 4] };
    const NM_METERS = 1852;
    /**
     * Nominal-range ring thickness in metres (geodesic annulus).
     * S-52 LIGHTS90–96 rasters are thin in *pixel* space; using a fraction of VALNMR
     * (e.g. 13% of 20 NM) draws multi-km bands that look nothing like OpenCPN.
     */
    const LIGHT_NOMINAL_RANGE_BAND_MIN_M = 85;
    const LIGHT_NOMINAL_RANGE_BAND_MAX_M = 380;
    const LIGHT_NOMINAL_RANGE_BAND_REL = 0.018;
    const MM_PER_INCH = 25.4;
    const DEFAULT_DPI = 96;
    const SYMBOL_SCALE_MM = 4.5;

    /** Layers whose geometry should never produce a point symbol on its own. */
    const HIDDEN_POINT_LAYERS = new Set(['M_COVR', 'M_QUAL', 'SBDARE', 'UNSARE']);

    /** Fallback when no LUPT rule matches (OpenCPN DISPLAYBASE colours). */
    const LAYER_DEFAULTS = {
        LNDARE: { fill: 'LANDA', stroke: 'CSTLN', strokeWidth: 0.6 },
        LAKARE: { fill: 'DEPVS', stroke: 'CHBLK', strokeWidth: 0.6 },
        SEAARE: { fill: 'DEPDW', stroke: null },
        UNSARE: { fill: 'DEPVS', stroke: 'CSTLN', strokeWidth: 0.5, lineDash: [4, 4] },
        SBDARE: { fill: 'DEPVS', stroke: 'CSTLN', strokeWidth: 0.5 },
        COALNE: { stroke: 'CSTLN', strokeWidth: 1, lineDash: [8, 4] },
        SLCONS: { stroke: 'CSTLN', strokeWidth: 2 },
        DEPCNT: { stroke: 'DEPCN', strokeWidth: 0.6 },
        TSELNE: { stroke: 'TRFCF', strokeWidth: 2 },
        TSSBND: { stroke: 'TRFCD', strokeWidth: 1.5, lineDash: [8, 4] },
        FAIRWY: { stroke: 'CHGRD', strokeWidth: 1, lineDash: [8, 4] },
        BUAARE: { fill: 'CHBRN', stroke: 'LANDF', strokeWidth: 1 },
        RIVERS: { fill: 'DEPVS', stroke: 'CHBLK', strokeWidth: 0.6 },
        CANALS: { fill: 'DEPVS', stroke: 'CHBLK', strokeWidth: 0.6 },
        ACHBRT: { fill: 'CHMGF', stroke: 'CHMGF', strokeWidth: 2, fillAlpha: 0.15, lineDash: [8, 4] },
        RESARE: { fill: 'TRFCF', stroke: 'TRFCD', strokeWidth: 1, fillAlpha: 0.18, lineDash: [8, 4] },
        DRGARE: { fill: 'DEPMD', stroke: 'CHGRF', strokeWidth: 1, lineDash: [8, 4] },
    };

    function lsWidthPx(mm) {
        return Math.min(3, Math.max(0.5, (Number(mm) || 1) * (DEFAULT_DPI / MM_PER_INCH) * 0.35));
    }

    const NO_LC_LAYERS = new Set(['COALNE', 'SLCONS', 'DEPCNT', 'TSELNE', 'TSSBND', 'LNDARE', 'M_COVR']);
    const LIGHT_AREA_PATTERN_LAYERS = new Set(['OBSTRN', 'UWTROC', 'WRECKS', 'DRGARE']);

    /**
     * OpenSPM / OpenCPN-style light flare: teardrop (S-52 LIGHTDEF–like), anchored at the
     * tip toward the chart point. `rotation` is radians passed to ol.style.Icon (clockwise).
     */
    function buildLightFlareIconImage(fill, stroke, radiusPx, rotationRad) {
        const r = Math.max(4, Math.min(12, radiusPx || 7));
        const w = Math.ceil(r * 3.4);
        const h = Math.ceil(r * 3.5);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const cx = w / 2;
        const tipY = h - 0.75;
        const rot = Number.isFinite(rotationRad) ? rotationRad : Math.PI * 0.78;
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.translate(cx, tipY);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-r * 0.95, -r * 0.55, -r * 0.92, -r * 1.12, 0, -r * 1.42);
        ctx.bezierCurveTo(r * 0.92, -r * 1.12, r * 0.95, -r * 0.55, 0, 0);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.05;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        return { canvas, anchor: [cx / w, tipY / h] };
    }

    function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

    /** Bucket map resolution for style caching (smooth wheel zoom reuses styles). */
    function styleResolutionBucket(resolution) {
        if (!Number.isFinite(resolution) || resolution <= 0) return 1;
        return Math.max(1, Math.round(resolution / 75) * 75);
    }

    const STYLE_CACHE_MAX = 12000;

    function num(v) {
        if (v == null || v === '') return NaN;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    }

    function parseColourList(props) {
        const raw = props.COLOUR;
        if (raw == null || raw === '') return [];
        return String(raw).split(/[,;]/).map(s => Number(s.trim())).filter(n => Number.isFinite(n));
    }

    function withAlpha(hex, alpha) {
        if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    /**
     * HPGL is the vector format used by OpenCPN PresLib glyphs.  This is a
     * minimal interpreter covering the subset emitted by `chartsymbols.xml`:
     *   SPx        – select pen / colour index (mapped through color-ref)
     *   SWx        – set line width (in 1/100 mm; we map to pixels)
     *   PUx,y      – pen up move to (x,y)
     *   PDx,y[,..] – pen down line(s) to (x,y) ...
     *   CIr        – draw a circle (radius r) centred on current pen
     *   PMx        – polygon mode (0 begin, 1 close, 2 close + fill)
     *   FP/EP      – fill / edge polygon
     */
    function parseHpgl(text) {
        const cmds = [];
        if (!text) return cmds;
        const tokens = text.split(';');
        for (let raw of tokens) {
            raw = raw.trim();
            if (!raw) continue;
            const m = raw.match(/^([A-Z]{2})(.*)$/);
            if (!m) continue;
            const op = m[1];
            const rest = m[2].trim();
            const nums = rest ? rest.split(',').map(s => Number(s.trim())).filter(v => !Number.isNaN(v)) : [];
            cmds.push({ op, raw: rest, nums });
        }
        return cmds;
    }

    /** Resolve `color-ref` strings such as "ACHMGD" or "ACHMGFCCHMGD". */
    function parseColorRef(ref) {
        const mapping = {};
        if (!ref) return mapping;
        for (let i = 0; i + 6 <= ref.length; i += 6) {
            const sp = ref[i];
            const token = ref.slice(i + 1, i + 6);
            mapping[sp] = token;
        }
        return mapping;
    }

    /**
     * Render HPGL onto a 2D canvas context.  Coordinates are in PresLib
     * "S-52 units" (1/100 mm).  The caller supplies a transform mapping
     * those units onto destination pixels.
     */
    function renderHpgl(cmds, ctx, opts) {
        const { scale, originX, originY, baseLineWidth, resolveColor, defaultColor } = opts;
        ctx.save();
        ctx.translate(-originX * scale, -originY * scale);
        ctx.scale(scale, scale);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = defaultColor;
        ctx.fillStyle = defaultColor;
        ctx.lineWidth = baseLineWidth;

        let polyOpen = false;
        let path = new Path2D();
        let cur = [0, 0];

        const flush = (closePath, fill) => {
            if (closePath) path.closePath();
            if (fill) ctx.fill(path);
            ctx.stroke(path);
            path = new Path2D();
        };

        for (const { op, nums } of cmds) {
            switch (op) {
                case 'SP': {
                    const idx = nums.length ? String.fromCharCode('A'.charCodeAt(0) + nums[0]) : 'A';
                    const c = resolveColor(idx);
                    if (c) { ctx.strokeStyle = c; ctx.fillStyle = c; }
                    break;
                }
                case 'SW': {
                    const w = nums.length ? Math.max(1, nums[0]) : 1;
                    ctx.lineWidth = baseLineWidth * w;
                    break;
                }
                case 'PU': {
                    for (let i = 0; i + 1 < nums.length; i += 2) {
                        cur = [nums[i], nums[i + 1]];
                        path.moveTo(cur[0], cur[1]);
                    }
                    break;
                }
                case 'PD': {
                    if (!nums.length) break;
                    for (let i = 0; i + 1 < nums.length; i += 2) {
                        cur = [nums[i], nums[i + 1]];
                        path.lineTo(cur[0], cur[1]);
                    }
                    break;
                }
                case 'CI': {
                    const r = nums.length ? nums[0] : 0;
                    if (r > 0) {
                        path.moveTo(cur[0] + r, cur[1]);
                        path.arc(cur[0], cur[1], r, 0, Math.PI * 2);
                    }
                    break;
                }
                case 'PM': {
                    polyOpen = nums.length ? nums[0] === 0 : false;
                    if (nums.length && nums[0] === 1) flush(true, false);
                    if (nums.length && nums[0] === 2) flush(true, true);
                    break;
                }
                case 'FP': flush(true, true); break;
                case 'EP': flush(false, false); break;
                default: break;
            }
        }
        if (polyOpen) flush(false, false);
        else flush(false, false);
        ctx.restore();
    }

    class S52PresLib {
        constructor() {
            this.bundle = null;
            this.palette = 'DAY_BRIGHT';
            this.colors = {};
            this.lookups = {};
            this.symbols = {};
            this.patterns = {};
            this.lineStyles = {};
            this.spriteUrl = '/s57data/rastersymbols-day.png';
            this.spriteSources = {};
            this.sprites = {};
            this.ready = false;
            this.displayCategory = 'STANDARD';
            this.viewScaleDenom = 90_000;
            this.settings = { ...DEFAULT_SETTINGS };

            this._styleCache = {};
            this._styleCacheKeys = [];
            this._symbolCache = new Map();
            this._patternCache = new Map();
        }

        clearStyleCache() {
            this._styleCache = {};
            this._styleCacheKeys = [];
        }

        _rememberStyle(cacheKey, result) {
            if (this._styleCache[cacheKey] !== undefined) {
                this._styleCache[cacheKey] = result;
                return;
            }
            this._styleCacheKeys.push(cacheKey);
            this._styleCache[cacheKey] = result;
            if (this._styleCacheKeys.length > STYLE_CACHE_MAX) {
                const evict = this._styleCacheKeys.shift();
                delete this._styleCache[evict];
            }
        }

        async load(url) {
            const resp = await fetch(url || '/s52-preslib.json');
            if (!resp.ok) throw new Error('S-52 presentation library load failed');
            const data = await resp.json();
            this.bundle = data;
            this.lookups = data.lookups || {};
            this.symbols = data.symbols || {};
            this.patterns = data.patterns || {};
            this.lineStyles = data.line_styles || {};
            this.spriteSources = data.palette_sprites || {};
            this.setPalette(data.default_palette || 'DAY_BRIGHT');
            this.ready = true;
            await this._loadSprite(this.palette);
            return data;
        }

        async _loadSprite(palette) {
            const src = this.spriteSources[palette];
            if (!src || this.sprites[palette]) return;
            await new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { this.sprites[palette] = img; resolve(); };
                img.onerror = () => resolve();
                img.src = src;
            });
        }

        setPalette(name) {
            if (!this.bundle) return;
            const palettes = this.bundle.palettes || {};
            const target = palettes[name] ? name : (palettes[this.palette] ? this.palette : 'DAY_BRIGHT');
            this.palette = target;
            this.colors = palettes[target] || {};
            this._applyReferenceEncDayColors(target);
            this.spriteUrl = this.spriteSources[target] || this.spriteUrl;
            this.clearStyleCache();
            this._symbolCache.clear();
            this._patternCache.clear();
            if (this._lightFlareIconCache) this._lightFlareIconCache.clear();
            this._loadSprite(target);
        }

        setSettings(partial) {
            Object.assign(this.settings, partial);
            if (partial.safetyContour != null && partial.safetyDepth == null) {
                this.settings.safetyDepth = partial.safetyContour;
            }
            this.clearStyleCache();
        }

        setDisplayCategory(cat) {
            this.displayCategory = cat || 'STANDARD';
            this.clearStyleCache();
        }

        setViewScaleDenom(denom) {
            const n = Number(denom);
            this.viewScaleDenom = Number.isFinite(n) && n > 0 ? n : 90_000;
            this.clearStyleCache();
        }

        passesScaleLimits(props) {
            if (!props || !this.settings.respectScamin) return true;
            const view = this.viewScaleDenom;
            const rawMin = props.SCAMIN;
            if (rawMin != null && rawMin !== '') {
                const scamin = Number(rawMin);
                if (Number.isFinite(scamin) && view > scamin) return false;
            }
            const rawMax = props.SCAMAX;
            if (rawMax != null && rawMax !== '') {
                const scamax = Number(rawMax);
                if (Number.isFinite(scamax) && view < scamax) return false;
            }
            if (!this.settings.showLowAccuracy) {
                const quapos = Number(props.QUAPOS);
                if (Number.isFinite(quapos) && quapos >= 2 && quapos <= 9) return false;
            }
            return true;
        }

        color(token, fallback) {
            if (!token) return fallback || '#000000';
            if (token[0] === '#') return token;
            const key = token.length === 5 ? token + '0' : token;
            return this.colors[key] || this.colors[token] || fallback || '#888888';
        }

        getSeaColor() { return this.color('DEPDW', '#dcebeb'); }

        /**
         * Match common ENC / OpenCPN-style DAY view: pale blue-grey sea, tan land, saturated lake blue (see UI reference).
         * Only adjusts DAY_BRIGHT so other palettes stay close to IHO PresLib defaults.
         */
        _applyReferenceEncDayColors(paletteName) {
            if (paletteName !== 'DAY_BRIGHT') return;
            Object.assign(this.colors, {
                LANDA0: '#bea064',
                LANDF0: '#8a6a2d',
                DEPDW0: '#dcebeb',
                DEPMD0: '#d4e8eb',
                DEPMS0: '#cce4ea',
                DEPVS0: '#c0dde8',
            });
        }

        /**
         * Inland water (LAKARE / river-canal areas): PresLib uses shallow-sea blues — use reference lake blue vs open sea.
         */
        _inlandFreshWaterFillColor() {
            const p = String(this.palette || '').toUpperCase();
            if (p.includes('NIGHT')) return '#3b6ec9';
            if (p.includes('DUSK')) return '#3d7dd4';
            if (p === 'DAY_BRIGHT' || p === 'DAY_WHITEBACK') return '#4a90e2';
            if (p.includes('BLACK')) return '#5a9eef';
            if (p.includes('WHITE')) return '#4285d6';
            return '#4a90e2';
        }

        // ---- Lookup matching ------------------------------------------------

        _matchAttc(conditions, props) {
            if (!conditions || !conditions.length) return 0;
            let score = 0;
            for (const cond of conditions) {
                if (cond.endsWith('?')) {
                    const attr = cond.slice(0, -1);
                    const v = props[attr];
                    if (v != null && v !== '') return -1;
                    score += 1;
                    continue;
                }
                const m = cond.match(/^([A-Z]+)(\d+(?:,\d+)*)$/);
                if (m) {
                    const attr = m[1];
                    const expected = m[2].split(',');
                    const raw = props[attr];
                    if (raw == null || raw === '') return -1;
                    const parts = String(raw).split(/[,;]/).map(s => s.trim());
                    const ok = expected.every(e => parts.includes(e));
                    if (!ok) return -1;
                    score += 10 * expected.length;
                    continue;
                }
                if (props[cond] == null || props[cond] === '') return -1;
                score += 1;
            }
            return score;
        }

        _categoryAllows(disp) {
            const featureRank = DISPLAY_CATEGORY_RANK[(disp || 'STANDARD').toUpperCase()];
            const userRank = DISPLAY_CATEGORY_RANK[this.displayCategory] || 1;
            return featureRank <= userRank;
        }

        _preferredTable(geom) {
            if (geom === 'L') {
                return ['Lines', 'Plain', 'Symbolized', 'Simplified', 'Paper'];
            }
            if (geom === 'P') {
                return ['Paper', 'Symbolized', 'Plain', 'Simplified', 'Lines'];
            }
            return ['Symbolized', 'Plain', 'Simplified', 'Lines', 'Paper'];
        }

        findRule(objectClass, geomType, props) {
            const rules = this.lookups[objectClass];
            if (!rules) return null;
            const g = GEOM_MAP[geomType] || 'P';
            const preferred = this._preferredTable(g);
            let best = null;
            let bestScore = -1;
            let bestTableIdx = preferred.length;
            for (const rule of rules) {
                if (rule.geom !== g) continue;
                if (!this._categoryAllows(rule.disp)) continue;
                const score = this._matchAttc(rule.attc, props);
                if (score < 0) continue;
                let tIdx = preferred.indexOf(rule.table);
                if (tIdx < 0) tIdx = preferred.length;
                if (
                    tIdx < bestTableIdx ||
                    (tIdx === bestTableIdx && score > bestScore)
                ) {
                    bestScore = score;
                    bestTableIdx = tIdx;
                    best = rule;
                }
            }
            return best;
        }

        // ---- Instruction parsing -------------------------------------------

        parseInstructions(inst) {
            const cmds = [];
            if (!inst) return cmds;
            for (const part of inst.split(';')) {
                const m = part.trim().match(/^([A-Z]{2})\((.*)\)$/);
                if (m) cmds.push({ cmd: m[1], args: m[2] });
            }
            return cmds;
        }

        _splitSyArgs(args) {
            const parts = args.split(',').map(s => s.trim());
            return { name: parts[0], rotation: parts.length > 1 ? Number(parts[1]) : null };
        }

        _splitApArgs(args) {
            const parts = args.split(',').map(s => s.trim());
            return { name: parts[0], rotation: parts.length > 1 ? Number(parts[1]) : null };
        }

        _splitLcArgs(args) {
            return { name: args.trim().split(',')[0] };
        }

        // ---- Symbol / pattern rendering ------------------------------------

        _baseScale() {
            return (DEFAULT_DPI / MM_PER_INCH) / 100; // PresLib uses 1/100 mm units
        }

        _renderGlyphToCanvas(entry, opts) {
            const v = entry.vector;
            if (!v) return null;
            const scaleMul = (opts && opts.scaleMul) || 1.0;
            const baseScale = this._baseScale() * scaleMul;
            const padding = 2;
            const widthPx = Math.max(2, Math.ceil(v.w * baseScale)) + padding * 2;
            const heightPx = Math.max(2, Math.ceil(v.h * baseScale)) + padding * 2;
            const canvas = document.createElement('canvas');
            canvas.width = widthPx;
            canvas.height = heightPx;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.translate(padding, padding);
            const mapping = parseColorRef(entry.color_ref);
            const fallbackToken = mapping.A ? this.color(mapping.A) : this.color('CHBLK');
            const resolve = (sp) => {
                const tok = mapping[sp];
                return tok ? this.color(tok) : fallbackToken;
            };
            renderHpgl(parseHpgl(entry.hpgl), ctx, {
                scale: baseScale,
                originX: (v.origin && v.origin[0]) || 0,
                originY: (v.origin && v.origin[1]) || 0,
                baseLineWidth: 1,
                resolveColor: resolve,
                defaultColor: fallbackToken,
            });
            const pivot = v.pivot || v.origin || [v.w / 2, v.h / 2];
            const ox = (v.origin && v.origin[0]) || 0;
            const oy = (v.origin && v.origin[1]) || 0;
            const anchorX = ((pivot[0] - ox) * baseScale + padding) / widthPx;
            const anchorY = ((pivot[1] - oy) * baseScale + padding) / heightPx;
            return { canvas, anchor: [clamp(anchorX, 0, 1), clamp(anchorY, 0, 1)] };
        }

        _targetSymbolPx() {
            return (SYMBOL_SCALE_MM / MM_PER_INCH) * DEFAULT_DPI;
        }

        _buildRasterIcon(symName, rotation, opts) {
            const sprite = this.sprites[this.palette];
            if (!sprite || !sprite.complete || sprite.naturalWidth < 1) return null;
            const base = symName.split(',')[0].trim();
            const entry = this.symbols[base];
            if (!entry || !entry.bitmap) return null;
            const bm = entry.bitmap;
            const dim = Math.max(bm.w, bm.h, 1);
            const targetPx = (opts && opts.targetPx != null) ? opts.targetPx : this._targetSymbolPx();
            const scaleMin = (opts && opts.scaleMin != null) ? opts.scaleMin : 0.35;
            const scaleMax = (opts && opts.scaleMax != null) ? opts.scaleMax : 1.2;
            const scale = clamp(targetPx / dim, scaleMin, scaleMax);
            const rot = Number.isFinite(rotation) ? (rotation * Math.PI) / 180 : 0;
            return new ol.style.Icon({
                img: sprite,
                imgSize: [sprite.naturalWidth, sprite.naturalHeight],
                offset: [bm.x, bm.y],
                size: [bm.w, bm.h],
                anchor: bm.anchor || [0.5, 0.5],
                scale,
                rotation: rot,
            });
        }

        buildRangeCircleSymbol(symName) {
            const base = symName.split(',')[0].trim();
            const entry = this.symbols[base];
            if (!entry || !entry.bitmap) return null;
            const bm = entry.bitmap;
            const dim = Math.max(bm.w, bm.h, 1);
            return this._buildRasterIcon(symName, 0, {
                targetPx: dim * 0.78,
                scaleMin: 0.45,
                scaleMax: 1.1,
            });
        }

        _buildVectorIcon(symName, rotation) {
            const base = symName.split(',')[0].trim();
            if (this.symbols[base] && this.symbols[base].bitmap) return null;
            const entry = this.symbols[base];
            if (!entry || !entry.hpgl) return null;
            const cacheKey = `${this.palette}|${base}`;
            let baked = this._symbolCache.get(cacheKey);
            if (!baked) {
                const targetPx = this._targetSymbolPx();
                const vw = (entry.vector && entry.vector.w) || 400;
                const scaleMul = targetPx / (vw * this._baseScale());
                baked = this._renderGlyphToCanvas(entry, { scaleMul: clamp(scaleMul, 0.002, 0.02) });
                if (!baked) return null;
                this._symbolCache.set(cacheKey, baked);
            }
            const targetPx = this._targetSymbolPx();
            const iconScale = clamp(targetPx / Math.max(baked.canvas.width, baked.canvas.height, 1), 0.35, 1.2);
            const rot = Number.isFinite(rotation) ? (rotation * Math.PI) / 180 : 0;
            return new ol.style.Icon({
                img: baked.canvas,
                imgSize: [baked.canvas.width, baked.canvas.height],
                anchor: baked.anchor,
                scale: iconScale,
                rotation: rot,
            });
        }

        buildSymbol(symName, rotation) {
            const raster = this._buildRasterIcon(symName, rotation);
            if (raster) return raster;
            return this._buildVectorIcon(symName, rotation);
        }

        buildPatternFill(patName) {
            const entry = this.patterns[patName];
            if (!entry) return null;
            const cacheKey = `${this.palette}|${patName}`;
            let pattern = this._patternCache.get(cacheKey);
            if (pattern === undefined) {
                pattern = null;
                if (entry.hpgl && entry.vector) {
                    const baked = this._renderGlyphToCanvas(entry, { scaleMul: 0.014 });
                    if (baked) {
                        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
                        pattern = ctx.createPattern(baked.canvas, 'repeat');
                    }
                }
                this._patternCache.set(cacheKey, pattern);
            }
            return pattern;
        }

        _getLineStyleCanvas(name) {
            const cacheKey = `${this.palette}|lc|${name}`;
            if (this._symbolCache.has(cacheKey)) return this._symbolCache.get(cacheKey);
            const entry = this.lineStyles[name];
            if (!entry || !entry.hpgl) return null;
            const baked = this._renderGlyphToCanvas(entry, { scaleMul: 0.01 });
            if (baked) this._symbolCache.set(cacheKey, baked);
            return baked;
        }

        _forEachLineSegment(geometry, fn) {
            const type = geometry.getType();
            const walk = (coords) => {
                for (let i = 0; i < coords.length - 1; i++) fn(coords[i], coords[i + 1]);
            };
            if (type === 'LineString') walk(geometry.getCoordinates());
            else if (type === 'MultiLineString') {
                geometry.getCoordinates().forEach(walk);
            }
        }

        _appendLcStyles(styles, geometry, lcName, zBase, resolution) {
            if (resolution > 350) return;
            const baked = this._getLineStyleCanvas(lcName);
            if (!baked) return;
            const entry = this.lineStyles[lcName];
            const vw = (entry && entry.vector && entry.vector.w) || 3000;
            const spacing = Math.max(resolution * 20, vw * this._baseScale() * 0.012);
            const targetPx = this._targetSymbolPx();
            const iconScale = clamp(targetPx / Math.max(baked.canvas.height, 8), 0.25, 0.9);
            this._forEachLineSegment(geometry, (a, b) => {
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const len = Math.hypot(dx, dy);
                if (len < spacing * 0.25) return;
                const rot = Math.atan2(dy, dx);
                let d = spacing * 0.5;
                while (d < len) {
                    const t = d / len;
                    styles.push(new ol.style.Style({
                        geometry: new ol.geom.Point([a[0] + dx * t, a[1] + dy * t]),
                        image: new ol.style.Icon({
                            img: baked.canvas,
                            imgSize: [baked.canvas.width, baked.canvas.height],
                            anchor: baked.anchor,
                            scale: iconScale,
                            rotation: rot,
                        }),
                        zIndex: zBase + 2,
                    }));
                    d += spacing;
                }
            });
        }

        _areaInteriorPoint(feature) {
            const geom = feature.getGeometry();
            try {
                return geom.getInteriorPoint();
            } catch (e) {
                const ext = geom.getExtent();
                return new ol.geom.Point(ol.extent.getCenter(ext));
            }
        }

        // ---- Conditional Symbology Procedures (CSP) ------------------------

        _csp(proc, props, resolution, geomType) {
            const base = (proc || '').replace(/\d+$/, '');
            if (base === 'OBSTRN') {
                return this._obstrnCsp(props, !!(geomType && geomType.includes('Point')));
            }
            if (base === 'WRECKS') {
                return this._wrecksCsp(props, !!(geomType && geomType.includes('Point')));
            }
            const handler = this._cspHandlers[proc] || this._cspHandlers[base];
            return handler ? handler.call(this, props, resolution) : null;
        }

        get _cspHandlers() {
            if (this._cspH) return this._cspH;
            const T = (token, fallback) => this.color(token, fallback);
            this._cspH = {
                DEPARE: (props) => {
                    const s = this.settings;
                    const dr1 = num(props.DRVAL1);
                    const dr2 = num(props.DRVAL2);
                    if (isNaN(dr1) && isNaN(dr2)) {
                        return { fill: T('NODTA'), stroke: T('CHGRD'), strokeWidth: 0.5 };
                    }
                    const d = !isNaN(dr1) ? dr1 : dr2;
                    let token = 'DEPVS';
                    if (d < 0) token = 'DEPIT';
                    else if (s.twoShades) {
                        token = d >= s.safetyContour ? 'DEPDW' : 'DEPVS';
                    } else if (d >= s.deepContour) token = 'DEPDW';
                    else if (d >= s.safetyContour) token = 'DEPMD';
                    else if (d >= s.shallowContour) token = 'DEPMS';
                    const isSafetyBoundary = !isNaN(dr1) && !isNaN(dr2) && (
                        (dr1 < s.safetyContour && dr2 >= s.safetyContour) ||
                        (dr2 < s.safetyContour && dr1 >= s.safetyContour)
                    );
                    return {
                        fill: T(token),
                        stroke: isSafetyBoundary ? T('DEPSC') : null,
                        strokeWidth: isSafetyBoundary ? 1.2 : 0,
                    };
                },
                DEPCNT: (props) => {
                    const s = this.settings;
                    const v = num(props.VALDCO);
                    const safety = !isNaN(v) && Math.abs(v - s.safetyContour) < 0.5;
                    return {
                        stroke: T(safety ? 'DEPSC' : 'DEPCN'),
                        strokeWidth: safety ? 1.5 : 0.6,
                        lineDash: null,
                    };
                },
                SOUNDG: (props) => {
                    const s = this.settings;
                    const depth = num(props.depth);
                    const isShallow = !isNaN(depth) && depth <= s.safetyDepth;
                    return {
                        textColor: T(isShallow ? 'SNDG2' : 'SNDG1'),
                        textStroke: 'rgba(255,255,255,0.85)',
                        fontWeight: isShallow ? 'bold' : 'normal',
                        fontSize: isShallow ? 11 : 10,
                    };
                },
                LIGHTS: (props, resolution) => this._lightsCsp(props, resolution),
                UDWHAZ: (props) => this._obstrnCsp(props, true),
                SLCONS: (props) => {
                    const cat = num(props.CATSLC);
                    const w = num(props.WATLEV);
                    if (w === 3 || w === 4) {
                        return {
                            fill: withAlpha(T('DEPIT'), 0.35),
                            stroke: T('CSTLN'),
                            strokeWidth: 0.8,
                        };
                    }
                    if (cat === 6 || cat === 15 || cat === 16) {
                        return { stroke: T('CSTLN'), strokeWidth: 1.5 };
                    }
                    return { stroke: T('CSTLN'), strokeWidth: 1 };
                },
                QUAPOS: (props) => {
                    const q = num(props.QUAPOS);
                    if (q >= 2 && q <= 9) {
                        return { stroke: T('CSTLN'), strokeWidth: 1, lineDash: [4, 4] };
                    }
                    return null;
                },
                TOPMAR: (props) => {
                    const top = num(props.TOPSHP);
                    const map = {
                        1: 'TOPMAR02', 2: 'TOPMAR04', 3: 'TOPMAR10', 4: 'TOPMAR12',
                        5: 'TOPMAR13', 6: 'TOPMAR14', 7: 'TOPMAR18', 8: 'TOPMAR22',
                        9: 'TOPMAR02', 10: 'TOPMAR02', 11: 'TOPMAR02',
                        12: 'TOPMAR02', 13: 'TOPMAR02', 14: 'TOPMAR02',
                    };
                    return { symbolName: map[top] || 'TOPMAR02' };
                },
                RESARE: (props) => {
                    const restrn = props.RESTRN;
                    const cat = props.CATREA;
                    let symbol = 'RESARE51';
                    if (cat) symbol = 'RESARE61';
                    if (restrn) symbol = 'RESARE71';
                    return {
                        symbolName: symbol,
                        fill: withAlpha(T('CHMGF'), 0.18),
                        stroke: T('CHMGD'),
                        strokeWidth: 1.2,
                        lineDash: [8, 4],
                    };
                },
                RESTRN: (props) => {
                    if (!props.RESTRN) return null;
                    return { symbolName: 'ENTRES51', stroke: T('CHMGD'), strokeWidth: 1.2, lineDash: [8, 4] };
                },
                DATCVR: () => ({ stroke: T('CHMGF'), strokeWidth: 1, lineDash: [12, 4] }),
                SYMINS: () => null,
            };
            this._cspH.DEPARE01 = this._cspH.DEPARE;
            this._cspH.DEPARE02 = this._cspH.DEPARE;
            this._cspH.DEPARE03 = this._cspH.DEPARE;
            this._cspH.DEPCNT02 = this._cspH.DEPCNT;
            this._cspH.DEPCNT03 = this._cspH.DEPCNT;
            this._cspH.SOUNDG02 = this._cspH.SOUNDG;
            this._cspH.SOUNDG03 = this._cspH.SOUNDG;
            this._cspH.LIGHTS05 = this._cspH.LIGHTS;
            this._cspH.LIGHTS06 = this._cspH.LIGHTS;
            this._cspH.SLCONS03 = this._cspH.SLCONS;
            this._cspH.SLCONS04 = this._cspH.SLCONS;
            this._cspH.QUAPOS01 = this._cspH.QUAPOS;
            this._cspH.TOPMAR01 = this._cspH.TOPMAR;
            this._cspH.RESARE02 = this._cspH.RESARE;
            this._cspH.RESARE01 = this._cspH.RESARE;
            this._cspH.RESTRN01 = this._cspH.RESTRN;
            this._cspH.DATCVR01 = this._cspH.DATCVR;
            this._cspH.UDWHAZ03 = this._cspH.UDWHAZ;
            this._cspH.UDWHAZ04 = this._cspH.UDWHAZ;
            return this._cspH;
        }

        _lightColourToken(code) {
            const map = {
                1: 'LITYW', 3: 'LITRD', 4: 'LITGN', 6: 'LITYW', 11: 'LITYW', 12: 'CHMGD',
            };
            return map[code] || 'LITYW';
        }

        _lightSymbolName(code) {
            const map = {
                3: 'LIGHTS11', 4: 'LIGHTS12', 1: 'LIGHTS13', 6: 'LIGHTS13', 11: 'LIGHTS13', 12: 'LIGHTS14',
            };
            return map[code] || 'LIGHTS13';
        }

        _lightSectorRadiusM(valnmr) {
            if (isNaN(valnmr) || valnmr <= 0) return 0;
            return valnmr * NM_METERS;
        }

        /** S-52 LIGHTS05: all-round lights use fixed-size range circles (LIGHTS90–96). */
        _isAllroundLight(props) {
            const catlit = num(props.CATLIT);
            if ([1, 8, 11, 12, 18, 19, 20].includes(catlit)) return false;
            const sectr1 = num(props.SECTR1);
            const sectr2 = num(props.SECTR2);
            if (!Number.isFinite(sectr1) || !Number.isFinite(sectr2)) return true;
            if (sectr1 === 0 && sectr2 === 0) return true;
            if (sectr1 === 0 && sectr2 >= 359.5) return true;
            let sweep = sectr2 - sectr1;
            if (sweep < 0) sweep += 360;
            return sweep >= 359.5;
        }

        _lightRangeCircleSymbol(colourCode, valnmr) {
            const big = Number.isFinite(valnmr) && valnmr >= 5;
            const map = {
                3: big ? 'LIGHTS96' : 'LIGHTS93',
                4: big ? 'LIGHTS95' : 'LIGHTS92',
                1: big ? 'LIGHTS94' : 'LIGHTS91',
                6: big ? 'LIGHTS94' : 'LIGHTS91',
                11: big ? 'LIGHTS94' : 'LIGHTS91',
            };
            return map[colourCode] || (big ? 'LIGHTS94' : 'LIGHTS90');
        }

        _lightRangeCircleFallback(colourCode, valnmr) {
            const big = Number.isFinite(valnmr) && valnmr >= 5;
            const tok = this._lightColourToken(colourCode);
            const strokeTok = (colourCode === 3 || colourCode === 4) ? tok : 'CHYLW';
            return {
                kind: 'range_circle',
                stroke: this.color(strokeTok),
                radius: big ? 17 : 12,
                /** Thin ring like OpenSPM / paper-style ENC (≈1 px). */
                strokeWidth: 1,
            };
        }

        _lightsCsp(props, resolution) {
            const colours = parseColourList(props);
            const code = colours.length ? colours[0] : NaN;
            const symbolName = this._lightSymbolName(code);
            const sectr1 = num(props.SECTR1);
            const sectr2 = num(props.SECTR2);
            const valnmr = num(props.VALNMR);
            const sectors = [];
            const allround = this._isAllroundLight(props);
            const geoSectorMaxRes = 2500;
            const radiusM = this._lightSectorRadiusM(valnmr);

            let rangeCircleSymbol = null;
            let rangeCircleFallback = null;

            /**
             * OpenCPN-style LIGHTS05: all-round lights always use fixed chart symbols LIGHTS90–96
             * (big vs small by VALNMR ≥ 5 NM), not a true-scale geodesic ring — otherwise radii
             * swing wildly vs ENC symbols.
             *
             * Sector (directional) lights: VALNMR → geodesic nominal-range annulus in Web Mercator,
             * with optional visible-sector gap when «Visible sector lights» is on and zoomed in.
             */
            if (radiusM > 0 && !allround) {
                sectors.push(this._lightNominalRangeAnnulusSpec({
                    sectr1, sectr2, radiusM, allround, resolution, geoSectorMaxRes,
                }));
            }
            if (allround) {
                rangeCircleSymbol = this._lightRangeCircleSymbol(code, valnmr);
                rangeCircleFallback = this._lightRangeCircleFallback(code, valnmr);
            }

            return { symbolName, sectors, rangeCircleSymbol, rangeCircleFallback };
        }

        _normDeg360(d) {
            if (!Number.isFinite(d)) return 0;
            let x = d % 360;
            if (x < 0) x += 360;
            return x;
        }

        /**
         * @returns {{ nominalRangeAnnulus: true, outerM: number, innerM: number, arcStartDeg: number,
         *            arcEndDeg: number, legBearingsDeg: number[]|null }}
         */
        _lightNominalRangeAnnulusSpec({ sectr1, sectr2, radiusM, allround, resolution, geoSectorMaxRes }) {
            const bandM = Math.min(
                LIGHT_NOMINAL_RANGE_BAND_MAX_M,
                Math.max(LIGHT_NOMINAL_RANGE_BAND_MIN_M, radiusM * LIGHT_NOMINAL_RANGE_BAND_REL)
            );
            const innerM = Math.max(0, radiusM - bandM);
            let arcStartDeg = 0;
            let arcEndDeg = 360;
            let legBearingsDeg = null;

            const hasSectr = Number.isFinite(sectr1) && Number.isFinite(sectr2)
                && !(sectr1 === 0 && sectr2 === 0);

            if (!allround && this.settings.showVisibleSectorLights && resolution < geoSectorMaxRes && hasSectr) {
                const s1 = this._normDeg360(sectr1);
                const s2 = this._normDeg360(sectr2);
                let visSweep = s2 - s1;
                if (visSweep < 0) visSweep += 360;
                if (visSweep > 0.5 && visSweep < 359.5) {
                    const compSweep = 360 - visSweep;
                    arcStartDeg = s2;
                    arcEndDeg = s2 + compSweep;
                    legBearingsDeg = [s1, s2];
                    if (compSweep >= 359.5) {
                        arcStartDeg = 0;
                        arcEndDeg = 360;
                        legBearingsDeg = null;
                    }
                }
            }

            return {
                nominalRangeAnnulus: true,
                outerM: radiusM,
                innerM,
                arcStartDeg,
                arcEndDeg,
                legBearingsDeg,
            };
        }

        _navAnnulusPolygon(lonLat, outerM, innerM, arcStartDeg, arcEndDeg) {
            let sweep = arcEndDeg - arcStartDeg;
            while (sweep <= 0) sweep += 360;
            while (sweep > 360.0001) sweep -= 360;

            if (sweep >= 359.5) {
                const sides = 128;
                const outer = [];
                const innerHole = [];
                for (let i = 0; i <= sides; i++) {
                    const br = ((i / sides) * 2 * Math.PI);
                    outer.push(ol.proj.fromLonLat(ol.sphere.offset(lonLat, outerM, br)));
                }
                for (let i = sides; i >= 0; i--) {
                    const br = ((i / sides) * 2 * Math.PI);
                    innerHole.push(ol.proj.fromLonLat(ol.sphere.offset(lonLat, innerM, br)));
                }
                return new ol.geom.Polygon([outer, innerHole]);
            }

            const steps = Math.max(48, Math.min(220, Math.ceil(sweep / 1.2)));
            const outer = [];
            const inner = [];
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const angDeg = arcStartDeg + sweep * t;
                const br = (angDeg * Math.PI) / 180;
                outer.push(ol.proj.fromLonLat(ol.sphere.offset(lonLat, outerM, br)));
            }
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const angDeg = arcStartDeg + sweep * t;
                const br = (angDeg * Math.PI) / 180;
                inner.push(ol.proj.fromLonLat(ol.sphere.offset(lonLat, innerM, br)));
            }
            const ring = outer.slice();
            for (let i = inner.length - 1; i >= 0; i--) ring.push(inner[i]);
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first.slice());
            return new ol.geom.Polygon([ring]);
        }

        _lightNominalRangeStyleParts(center, sec) {
            if (!sec.nominalRangeAnnulus) return [];
            const lonLat = ol.proj.toLonLat(center);
            const outline = this.color('CHBLK');
            const poly = this._navAnnulusPolygon(lonLat, sec.outerM, sec.innerM, sec.arcStartDeg, sec.arcEndDeg);
            /** Light nominal range: pale fill + thin yellow outline (OpenSPM-style). */
            const fillCol = withAlpha(this.color('CHYLW'), 0.14);
            const haloCol = withAlpha(this.color('CHWHT'), 0.35);
            const parts = [
                {
                    geometry: poly,
                    fill: fillCol,
                    stroke: { color: haloCol, width: 0.65 },
                },
                {
                    geometry: poly,
                    stroke: { color: this.color('CHYLW'), width: 0.9 },
                },
                {
                    geometry: poly,
                    stroke: { color: outline, width: 0.55 },
                },
            ];
            if (sec.legBearingsDeg && sec.legBearingsDeg.length === 2) {
                const dash = [5, 5];
                for (const bd of sec.legBearingsDeg) {
                    if (!Number.isFinite(bd)) continue;
                    const br = (bd * Math.PI) / 180;
                    const tip = ol.proj.fromLonLat(ol.sphere.offset(lonLat, sec.outerM, br));
                    parts.push({
                        geometry: new ol.geom.LineString([center, tip]),
                        stroke: { color: outline, width: 1, lineDash: dash },
                    });
                }
            }
            return parts;
        }

        /**
         * OpenSPM-style vector light flare (teardrop). COLOUR 3/4 → red/green flare;
         * otherwise magenta (CHMGD) like LIGHTDEF / overview ENC practice.
         */
        _lightFlareVectorSpec(props) {
            const cols = parseColourList(props);
            const c0 = cols.length ? cols[0] : NaN;
            let fillTok = 'CHMGD';
            if (c0 === 3) fillTok = 'LITRD';
            else if (c0 === 4) fillTok = 'LITGN';
            return {
                kind: 'light_flare',
                fill: this.color(fillTok),
                stroke: this.color('CHBLK'),
                radius: 6.5,
                rotation: Math.PI * 0.78,
            };
        }

        _obstrnCsp(props, isPoint) {
            const s = this.settings;
            const valsou = num(props.VALSOU);
            const watlev = num(props.WATLEV);
            if (!isNaN(valsou) && valsou <= s.safetyContour) {
                return { symbolName: 'DANGER51', fill: this.color('DNGHL'), stroke: this.color('CHBLK'), strokeWidth: 0.8 };
            }
            if (watlev === 1 || watlev === 2) {
                return {
                    symbolName: isPoint ? 'OBSTRN11' : null,
                    fill: this.color('CHBRN'),
                    stroke: this.color('CSTLN'),
                    strokeWidth: 0.6,
                };
            }
            if (isPoint) {
                return { symbolName: 'OBSTRN11' };
            }
            return {
                fill: withAlpha(this.color('CHGRD'), 0.08),
                stroke: this.color('CHGRD'),
                strokeWidth: 0.4,
                lineDash: [4, 4],
            };
        }

        _wrecksCsp(props, isPoint) {
            const s = this.settings;
            const valsou = num(props.VALSOU);
            const watlev = num(props.WATLEV);
            if (!isNaN(valsou) && valsou <= s.safetyContour) {
                return { symbolName: 'DANGER51', fill: this.color('DNGHL'), stroke: this.color('CHBLK'), strokeWidth: 0.8 };
            }
            if (watlev === 1 || watlev === 2) {
                return {
                    symbolName: isPoint ? 'WRECKS01' : null,
                    fill: this.color('CHBRN'),
                    stroke: this.color('CSTLN'),
                    strokeWidth: 0.6,
                };
            }
            if (isPoint) {
                return { symbolName: 'WRECKS01' };
            }
            return {
                fill: 'transparent',
                stroke: this.color('CHGRD'),
                strokeWidth: 0.4,
                lineDash: [4, 4],
            };
        }

        // ---- Text instructions ---------------------------------------------

        _parseTextCmd(args) {
            const te = args.match(/^TE\('([^']*)','([^']*)',(\d+),(\d+),(\d+),'[^']*',(-?\d+),(-?\d+),([A-Z]+),(\d+)\)$/);
            if (te) {
                return {
                    template: te[1], attr: te[2],
                    hjust: Number(te[3]), vjust: Number(te[4]), space: Number(te[5]),
                    xoff: Number(te[6]), yoff: Number(te[7]),
                    color: te[8], size: Number(te[9]),
                };
            }
            const tx = args.match(/^TX\(([^,]+),(\d+),(\d+),(\d+),'[^']*',(-?\d+),(-?\d+),([A-Z]+),(\d+)\)$/);
            if (tx) {
                return {
                    template: null, attr: tx[1],
                    hjust: Number(tx[2]), vjust: Number(tx[3]), space: Number(tx[4]),
                    xoff: Number(tx[5]), yoff: Number(tx[6]),
                    color: tx[7], size: Number(tx[8]),
                };
            }
            return null;
        }

        _formatText(te, props) {
            const val = props[te.attr];
            if (val == null || val === '') return null;
            if (te.template && te.template.includes('%')) {
                // Handle the limited printf flavour PresLib uses (e.g. %s, %4.1lf).
                return te.template.replace(/%[-+0-9.]*[sld]+/g, (m) => {
                    if (m.endsWith('s')) return String(val);
                    const numVal = Number(val);
                    if (!Number.isFinite(numVal)) return String(val);
                    const dec = m.match(/\.(\d+)/);
                    return dec ? numVal.toFixed(Number(dec[1])) : String(Math.round(numVal));
                });
            }
            return String(val);
        }

        // ---- Top-level style entry point -----------------------------------

        getStyle(feature, resolution) {
            if (!this.ready) return null;
            const layer = feature.get('layer');
            const geomType = feature.getGeometry().getType();
            const props = feature.getProperties();

            if (HIDDEN_POINT_LAYERS.has(layer) && geomType.includes('Point')) return null;
            if (!this.settings.showSoundings && layer === 'SOUNDG') return null;
            if (!this.passesScaleLimits(props)) return null;

            const resBucket = styleResolutionBucket(resolution);
            const cacheKey = [
                this.palette, this.displayCategory, layer, geomType, resBucket,
                this.viewScaleDenom | 0,
                props.DRVAL1, props.DRVAL2, props.VALDCO, props.depth,
                props.COLOUR, props.BOYSHP, props.BCNSHP, props.TOPSHP,
                props.SECTR1, props.SECTR2, props.VALNMR, props.ORIENT, props.CATLIT,
                props.OBJNAM, props.NOBJNM, props.LITCHR, props.SIGGRP, props.SIGPER,
                props.HEIGHT, props.CATSLC, props.WATLEV, props.CATREA, props.RESTRN,
                props.SCAMIN, props.SCAMAX,
                this.settings.shallowContour, this.settings.safetyContour, this.settings.deepContour,
                this.settings.showText, this.settings.showLightDescriptions,
                this.settings.showBuoyLightLabels, this.settings.showVisibleSectorLights,
                this.settings.imperialLightText,
                this.settings.respectScamin,
            ].join('|');
            if (this._styleCache[cacheKey] !== undefined) return this._styleCache[cacheKey];

            const rule = this.findRule(layer, geomType, props);
            const result = this._buildStyle(rule, layer, geomType, props, feature, resolution);
            this._rememberStyle(cacheKey, result);
            return result;
        }

        _buildStyle(rule, layer, geomType, props, feature, resolution) {
            const cmds = rule ? this.parseInstructions(rule.inst) : [];
            const isPoly = geomType.includes('Polygon');
            const isLine = geomType.includes('Line');
            const isPoint = geomType.includes('Point');
            const zBase = (rule ? rule.prio : 4) * 10;

            let fill = null;
            let stroke = null;
            let strokeWidth = 1;
            let lineDash = null;
            let patternFill = null;
            let symbol = null;
            let symbolName = null;
            let lcName = null;
            let symbolRotation = num(props.ORIENT);
            let sectors = [];
            let rangeCircleSymbol = null;
            let rangeCircleFallback = null;
            const labels = [];

            if (!rule) {
                const def = LAYER_DEFAULTS[layer];
                if (def) {
                    if (def.fill) fill = def.fillAlpha != null ? withAlpha(this.color(def.fill), def.fillAlpha) : this.color(def.fill);
                    if (def.stroke) {
                        stroke = this.color(def.stroke);
                        strokeWidth = def.strokeWidth || 1;
                        lineDash = def.lineDash || null;
                    }
                }
            }

            const applyCsp = (csp) => {
                if (!csp) return;
                if (csp.fill !== undefined) fill = csp.fill;
                if (csp.stroke) { stroke = csp.stroke; strokeWidth = csp.strokeWidth || 1; }
                if (csp.lineDash !== undefined) lineDash = csp.lineDash;
                if (csp.symbolName) { symbolName = csp.symbolName; symbol = null; }
                if (csp.symbol) { symbol = csp.symbol; symbolName = csp.symbolName || null; }
                if (csp.symbolFill) {
                    symbol = symbol || { kind: 'light_flare', fill: csp.symbolFill, stroke: csp.symbolStroke, radius: 5 };
                }
                if (csp.sectors) sectors = csp.sectors;
                if (csp.rangeCircleSymbol) rangeCircleSymbol = csp.rangeCircleSymbol;
                if (csp.rangeCircleFallback) rangeCircleFallback = csp.rangeCircleFallback;
            };

            for (const { cmd, args } of cmds) {
                if (cmd === 'AC') {
                    fill = this.color(args);
                } else if (cmd === 'AP') {
                    const ap = this._splitApArgs(args);
                    const allowPattern = resolution < 90
                        && !(LIGHT_AREA_PATTERN_LAYERS.has(layer) && resolution > 50);
                    if (allowPattern) {
                        const pat = this.buildPatternFill(ap.name);
                        if (pat) patternFill = pat;
                    }
                } else if (cmd === 'LS') {
                    const parts = args.split(',');
                    stroke = this.color(parts[2]);
                    strokeWidth = lsWidthPx(parts[1]);
                    lineDash = LINE_DASH[parts[0]] || null;
                } else if (cmd === 'LC' && !NO_LC_LAYERS.has(layer)) {
                    const lc = this._splitLcArgs(args);
                    lcName = lc.name;
                    if (!stroke) {
                        const entry = this.lineStyles[lc.name];
                        if (entry && entry.color_ref) {
                            const mapping = parseColorRef(entry.color_ref);
                            stroke = this.color(mapping.A || 'CHBLK');
                            strokeWidth = 1;
                        }
                    }
                } else if (cmd === 'SY') {
                    const sy = this._splitSyArgs(args);
                    symbolName = sy.name;
                    if (Number.isFinite(sy.rotation)) symbolRotation = sy.rotation;
                } else if (cmd === 'CS') {
                    applyCsp(this._csp(args, props, resolution, geomType));
                } else if (cmd === 'TE' || cmd === 'TX') {
                    if (!this.settings.showText) continue;
                    const te = this._parseTextCmd(args);
                    const text = te ? this._formatText(te, props) : null;
                    if (text) {
                        labels.push({
                            text,
                            color: this.color(te.color),
                            size: clamp(Math.round(te.size / 2.5), 8, 14),
                            offsetX: te.xoff * 2,
                            offsetY: -te.yoff * 2,
                        });
                    }
                }
            }

            const isInlandWaterArea = isPoly && (layer === 'LAKARE' || layer === 'RIVERS' || layer === 'CANALS');
            if (isInlandWaterArea) {
                fill = this._inlandFreshWaterFillColor();
                if (layer === 'LAKARE') {
                    stroke = this.color('CHBLK');
                    strokeWidth = Math.max(Number(strokeWidth) || 0, 1.05);
                }
            }

            const styles = [];

            // Polygon body
            if (isPoly) {
                if (patternFill) {
                    styles.push(new ol.style.Style({
                        fill: new ol.style.Fill({ color: patternFill }),
                        zIndex: zBase,
                    }));
                }
                if (fill) {
                    styles.push(new ol.style.Style({
                        fill: new ol.style.Fill({ color: fill }),
                        zIndex: zBase - 1,
                    }));
                }
                if (stroke) {
                    styles.push(new ol.style.Style({
                        stroke: new ol.style.Stroke({
                            color: stroke, width: strokeWidth,
                            lineDash: lineDash || undefined,
                        }),
                        zIndex: zBase,
                    }));
                }
            }

            // Line body
            if (isLine && stroke) {
                styles.push(new ol.style.Style({
                    stroke: new ol.style.Stroke({
                        color: stroke, width: strokeWidth,
                        lineDash: lineDash || undefined,
                    }),
                    zIndex: zBase,
                }));
            }
            if (isLine && lcName && !NO_LC_LAYERS.has(layer)) {
                this._appendLcStyles(styles, feature.getGeometry(), lcName, zBase, resolution);
            }

            if (isPoly && resolution > 70 && LIGHT_AREA_PATTERN_LAYERS.has(layer)) {
                stroke = null;
            }

            // Area / line point symbols (TSSLPT arrows, ACHARE, etc.)
            if ((isPoly || isLine) && symbolName && !isPoint && resolution < 400) {
                const img = this.buildSymbol(symbolName, symbolRotation);
                if (img) {
                    const ptGeom = isPoly ? this._areaInteriorPoint(feature) : null;
                    if (ptGeom) {
                        styles.push(new ol.style.Style({ geometry: ptGeom, image: img, zIndex: zBase + 4 }));
                    }
                }
            }

            // Soundings render their depth value directly
            if (layer === 'SOUNDG' && isPoint && props.depth != null) {
                const cs = this._csp('SOUNDG02', props, resolution);
                const depthVal = Number(props.depth);
                const depthAbs = Math.abs(depthVal);
                let depthText;
                if (depthAbs < 31) {
                    const whole = Math.floor(depthAbs);
                    const frac = Math.round((depthAbs - whole) * 10);
                    depthText = frac > 0 ? `${whole}.${frac}` : String(whole);
                } else {
                    depthText = String(Math.round(depthAbs));
                }
                if (depthVal < 0) depthText = depthText + '̅';
                styles.push(new ol.style.Style({
                    text: new ol.style.Text({
                        text: depthText,
                        font: `${cs.fontWeight} ${cs.fontSize}px Consolas, monospace`,
                        fill: new ol.style.Fill({ color: cs.textColor }),
                        stroke: new ol.style.Stroke({ color: cs.textStroke, width: 2.5 }),
                    }),
                    zIndex: zBase + 5,
                }));
            }

            // Point symbol & sectors
            if (isPoint) {
                const center = feature.getGeometry().getCoordinates();
                if (rangeCircleSymbol || rangeCircleFallback) {
                    let circleImg = rangeCircleSymbol
                        ? this.buildRangeCircleSymbol(rangeCircleSymbol)
                        : null;
                    if (!circleImg && rangeCircleFallback) {
                        circleImg = this._fallbackSymbolImage(rangeCircleFallback);
                    }
                    if (circleImg) {
                        styles.push(new ol.style.Style({ image: circleImg, zIndex: zBase }));
                    }
                }
                for (const sec of sectors) {
                    const nrParts = this._lightNominalRangeStyleParts(center, sec);
                    for (const part of nrParts) {
                        styles.push(new ol.style.Style({
                            geometry: part.geometry,
                            fill: part.fill ? new ol.style.Fill({ color: part.fill }) : undefined,
                            stroke: part.stroke
                                ? new ol.style.Stroke({
                                    color: part.stroke.color,
                                    width: part.stroke.width,
                                    lineDash: part.stroke.lineDash || undefined,
                                })
                                : undefined,
                            zIndex: zBase - 1,
                        }));
                    }
                }

                let image = null;
                const syBase = symbolName ? String(symbolName).split(',')[0].trim() : '';
                const useVectorLightFlare = layer === 'LIGHTS' && /^LIGHTS1[1-4]$/.test(syBase);
                if (useVectorLightFlare) {
                    image = this._fallbackSymbolImage(this._lightFlareVectorSpec(props));
                } else if (symbolName) {
                    image = this.buildSymbol(symbolName, symbolRotation);
                }
                if (!image && symbol) image = this._fallbackSymbolImage(symbol);
                if (!image && layer === 'LIGHTS') {
                    image = this._fallbackSymbolImage(this._lightFlareVectorSpec(props));
                }
                if (image) {
                    styles.push(new ol.style.Style({ image, zIndex: zBase + 3 }));
                }
            }

            for (const lb of labels.concat(this._autoLabels(layer, props, resolution))) {
                const paperLightText = layer === 'LIGHTS' && isPoint;
                const halo = (lb.subtleHalo || paperLightText)
                    ? new ol.style.Stroke({ color: 'rgba(255,255,255,0.42)', width: 1 })
                    : new ol.style.Stroke({ color: 'rgba(255,255,255,0.9)', width: 2.5 });
                styles.push(new ol.style.Style({
                    text: new ol.style.Text({
                        text: lb.text,
                        font: `${lb.fontWeight || 'normal'} ${lb.size || 10}px sans-serif`,
                        offsetX: lb.offsetX || 0,
                        offsetY: lb.offsetY || 0,
                        fill: new ol.style.Fill({ color: lb.color }),
                        stroke: halo,
                        overflow: !isPoint,
                    }),
                    zIndex: zBase + 5,
                }));
            }

            if (isLine && layer === 'DEPCNT' && resolution < 300) {
                const v = num(props.VALDCO);
                if (!isNaN(v)) {
                    styles.push(new ol.style.Style({
                        text: new ol.style.Text({
                            text: String(v),
                            font: '9px sans-serif',
                            placement: 'line',
                            overflow: true,
                            fill: new ol.style.Fill({ color: this.color('DEPCN') }),
                            stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.85)', width: 2 }),
                        }),
                        zIndex: zBase + 1,
                    }));
                }
            }

            return styles.length ? (styles.length === 1 ? styles[0] : styles) : null;
        }

        _fallbackSymbolImage(spec) {
            const stroke = new ol.style.Stroke({ color: spec.stroke || '#000', width: 1.2 });
            const fill = new ol.style.Fill({ color: spec.fill || '#000' });
            switch (spec.kind) {
                case 'buoy_cone':
                    return new ol.style.RegularShape({ points: 3, radius: spec.radius || 6, fill, stroke });
                case 'buoy_pillar':
                    return new ol.style.RegularShape({ points: 4, radius: (spec.radius || 6) * 0.75, fill, stroke, angle: Math.PI / 4 });
                case 'beacon':
                    return new ol.style.RegularShape({ points: 4, radius: spec.radius || 6, fill, stroke, angle: Math.PI / 4 });
                case 'star':
                    return new ol.style.RegularShape({ points: 5, radius: spec.radius || 6, radius2: (spec.radius || 6) / 2, fill, stroke });
                case 'light_flare': {
                    const r = spec.radius || 7;
                    const rot = Number.isFinite(spec.rotation) ? spec.rotation : Math.PI * 0.78;
                    const key = `lf|${spec.fill}|${spec.stroke}|${r}|${rot.toFixed(4)}`;
                    if (!this._lightFlareIconCache) this._lightFlareIconCache = new Map();
                    let icon = this._lightFlareIconCache.get(key);
                    if (!icon) {
                        const { canvas, anchor } = buildLightFlareIconImage(
                            spec.fill || '#c545c3',
                            spec.stroke || '#070707',
                            r,
                            rot
                        );
                        icon = new ol.style.Icon({
                            img: canvas,
                            imgSize: [canvas.width, canvas.height],
                            anchor,
                            scale: 1,
                        });
                        if (this._lightFlareIconCache.size > 48) this._lightFlareIconCache.clear();
                        this._lightFlareIconCache.set(key, icon);
                    }
                    return icon;
                }
                case 'range_circle':
                    return new ol.style.Circle({
                        radius: spec.radius || 18,
                        fill: new ol.style.Fill({ color: 'rgba(0,0,0,0)' }),
                        stroke: new ol.style.Stroke({
                            color: spec.stroke || '#f4da48',
                            width: spec.strokeWidth || 2,
                        }),
                    });
                default:
                    return new ol.style.Circle({ radius: spec.radius || 5, fill, stroke });
            }
        }

        _autoLabels(layer, props, resolution) {
            const labels = [];
            const name = props.NOBJNM || props.OBJNAM;
            const push = (text, opts = {}) => {
                if (!text) return;
                labels.push({
                    text: String(text),
                    color: this.color(opts.color || 'CHBLK'),
                    size: opts.size || 10,
                    offsetX: opts.offsetX || 0,
                    offsetY: opts.offsetY || 14,
                    fontWeight: opts.fontWeight || 'normal',
                    subtleHalo: !!opts.subtleHalo,
                });
            };
            if (layer === 'LIGHTS') {
                if (this.settings.showLightDescriptions && resolution < 6500) {
                    push(this._lightCharText(props), {
                        size: 9, offsetY: 14, color: 'CHBLK', subtleHalo: true,
                    });
                }
                if (this.settings.showBuoyLightLabels && name && resolution < 6500) {
                    push(name, { size: 8, offsetY: 22, subtleHalo: true });
                }
                return labels;
            }
            if (layer === 'WRECKS') {
                if (resolution < 9000) push('Wk', { size: 9, offsetY: 10, fontWeight: 'bold' });
                if (this.settings.showText && name && resolution < 400) push(name, { size: 8, offsetY: 24 });
                return labels;
            }
            if (/^BOY|^BCN/.test(layer)) {
                if (this.settings.showBuoyLightLabels && name && resolution < 800) {
                    push(name, { size: 9, offsetY: 14 });
                }
                return labels;
            }
            if (!this.settings.showText) return labels;
            if (layer === 'LNDMRK' && resolution < 1200 && name) push(name, { size: 9 });
            if (layer === 'LNDRGN' && resolution < 1500 && name) push(name, { size: 11, offsetY: 0 });
            if (layer === 'SEAARE' && resolution < 1500 && name) push(name, { size: 11, offsetY: 0, font: 'italic' });
            if (layer === 'BUAARE' && resolution < 1200 && name) push(name, { size: 10, offsetY: 0 });
            if (layer === 'ACHBRT' && resolution < 800 && name) push(name, { size: 9, offsetY: 0, color: 'CHMGD' });
            if (layer === 'RESARE' && resolution < 800 && name) push(name, { size: 9, offsetY: 0, color: 'CHMGD' });
            if (layer === 'FAIRWY' && resolution < 1000 && name) push(name, { size: 9, color: 'CHGRD' });
            if (layer === 'TSSLPT' && resolution < 1000 && name) push(name, { size: 9, color: 'CHMGD' });
            if (layer === 'DEPARE' && resolution < 2000 && name) push(name, { size: 10, color: 'CHBLK' });
            if (layer === 'LNDELV' && resolution < 500) {
                const e = num(props.ELEVAT);
                if (!isNaN(e)) push(String(Math.round(e)), { size: 9, offsetY: 0, color: 'LANDF' });
            }
            return labels;
        }

        _lightCharText(props) {
            const litchr = num(props.LITCHR);
            const siggrp = props.SIGGRP ? String(props.SIGGRP).replace(/[()]/g, '') : '';
            const colour = parseColourList(props)[0];
            const sigper = num(props.SIGPER);
            const valnmr = num(props.VALNMR);
            const height = num(props.HEIGHT);
            const imperial = this.settings.imperialLightText;
            const chrMap = {
                1: 'F', 2: 'Fl', 3: 'LFl', 4: 'Q', 5: 'VQ', 6: 'UQ',
                7: 'Iso', 8: 'Oc', 9: 'IQ', 10: 'IVQ', 11: 'IUQ',
                12: 'Mo', 13: 'FFl', 14: 'Fl+LFl', 15: 'OcFl',
                16: 'FLFl', 17: 'AlOc', 18: 'AlLFl', 19: 'AlFl',
                20: 'AlGp', 25: 'Q+LFl', 26: 'VQ+LFl', 27: 'UQ+LFl',
                28: 'Al', 29: 'AlFFl',
            };
            const colMap = { 1: 'W', 3: 'R', 4: 'G', 5: 'Bu', 6: 'Y', 9: 'Or', 11: 'Y', 12: 'Vi' };
            let text = chrMap[litchr] || '';
            if (siggrp && siggrp !== '1') text += `(${siggrp})`;
            const colStr = colMap[colour] || '';
            if (colStr) text += (text ? ' ' : '') + colStr;
            if (!isNaN(sigper) && sigper > 0) text += ` ${sigper}s`;
            if (!isNaN(height) && height > 0) {
                text += imperial
                    ? ` ${Math.round(height * 3.28084)}ft`
                    : ` ${Math.round(height)}m`;
            }
            if (!isNaN(valnmr) && valnmr > 0) {
                text += ` ${valnmr}nM`;
            }
            return text.trim();
        }
    }

    global.S52PresLib = S52PresLib;
    global.s52 = new S52PresLib();
})(typeof window !== 'undefined' ? window : global);
