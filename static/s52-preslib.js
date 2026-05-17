/**
 * IHO S-52 Presentation Library renderer (PresLib e4.0.0 DAY palette).
 */
(function (global) {
    'use strict';

    const GEOM_MAP = {
        Point: 'P', MultiPoint: 'P',
        LineString: 'L', MultiLineString: 'L',
        Polygon: 'A', MultiPolygon: 'A',
    };

    const DEFAULT_SETTINGS = {
        safetyContour: 30,
        shallowContour: 10,
        deepContour: 30,
        safetyDepth: 30,
    };

    const LINE_DASH = { SOLD: null, DASH: [8, 4], DOTT: [2, 3] };

    /** Point layers that are label/meta only — never draw default dots. */
    const HIDDEN_POINT_LAYERS = new Set([
        'LNDRGN', 'LNDELV', 'M_COVR', 'M_QUAL', 'SEAARE', 'SBDARE', 'UNSARE',
    ]);

    function withAlpha(hex, alpha) {
        if (!hex || !hex.startsWith('#') || hex.length < 7) return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    class S52PresLib {
        constructor() {
            this.colors = {};
            this.lookups = {};
            this.ready = false;
            this.settings = { ...DEFAULT_SETTINGS };
            this._styleCache = {};
        }

        async load(url) {
            const resp = await fetch(url || '/s52-preslib.json');
            if (!resp.ok) throw new Error('S-52 presentation library load failed');
            const data = await resp.json();
            this.colors = data.colors || {};
            this.lookups = data.lookups || {};
            this.version = data.version;
            this.ready = true;
            this._styleCache = {};
            return data;
        }

        color(token) {
            if (!token) return '#000000';
            if (token.startsWith('#')) return token;
            return this.colors[token] || this.colors[token + '0'] || '#888888';
        }

        setSettings(partial) {
            Object.assign(this.settings, partial);
            this._styleCache = {};
        }

        matchAttc(conditions, props) {
            if (!conditions || !conditions.length) return true;
            for (const cond of conditions) {
                if (cond.endsWith('?')) {
                    const attr = cond.slice(0, -1);
                    const v = props[attr];
                    if (v != null && v !== '') return false;
                    continue;
                }
                const multi = cond.match(/^([A-Z]+)(\d+(?:,\d+)+)$/);
                if (multi) {
                    const attr = multi[1];
                    const expected = multi[2].split(',');
                    const raw = props[attr];
                    const parts = raw == null ? [] : String(raw).split(/[,;]/).map(s => s.trim());
                    const ok = expected.every((e, i) => parts[i] === e || String(raw) === e);
                    if (!ok) return false;
                    continue;
                }
                const single = cond.match(/^([A-Z]+)(\d+)$/);
                if (single) {
                    if (String(props[single[1]]) !== single[2]) return false;
                    continue;
                }
                if (!props[cond]) return false;
            }
            return true;
        }

        findRule(objectClass, geomType, props) {
            const rules = this.lookups[objectClass];
            if (!rules) return null;
            const g = GEOM_MAP[geomType] || 'P';
            let best = null;
            let bestScore = -1;
            for (const rule of rules) {
                if (rule.geom !== g) continue;
                if (!this.matchAttc(rule.attc, props)) continue;
                const score = (rule.attc ? rule.attc.length : 0) * 10;
                if (score > bestScore) { bestScore = score; best = rule; }
            }
            return best || rules.find(r => r.geom === g && (!r.attc || !r.attc.length)) || null;
        }

        parseInstructions(inst) {
            const cmds = [];
            if (!inst) return cmds;
            for (const part of inst.split(';')) {
                const m = part.match(/^([A-Z]{2})\((.*)\)$/);
                if (m) cmds.push({ cmd: m[1], args: m[2] });
            }
            return cmds;
        }

        _hasDrawableSymbol(cmds) {
            return cmds.some(c => c.cmd === 'SY' || c.cmd === 'AC' || c.cmd === 'CS' || c.cmd === 'LS');
        }

        applyConditional(proc, props) {
            const s = this.settings;
            switch (proc) {
                case 'DEPARE03': {
                    if (props.DRVAL1 == null && props.DRVAL2 == null) {
                        return { fill: this.color('NODTA0'), stroke: this.color('CHGRD0'), strokeWidth: 0.5 };
                    }
                    const d = props.DRVAL1 != null ? Number(props.DRVAL1) : 0;
                    let token = 'DEPVS0';
                    if (d >= s.deepContour) token = 'DEPDW0';
                    else if (d >= s.safetyContour) token = 'DEPMD0';
                    else if (d >= s.shallowContour) token = 'DEPMS0';
                    else if (d < 0) token = 'DEPIT0';
                    return { fill: this.color(token), stroke: this.color('CHGRD0'), strokeWidth: 0.5 };
                }
                case 'DEPCNT03': {
                    const val = Number(props.VALDCO);
                    const isSafety = !isNaN(val) && Math.abs(val - s.safetyContour) < 0.5;
                    return {
                        stroke: this.color(isSafety ? 'CHBLK0' : 'DEPCN0'),
                        strokeWidth: isSafety ? 2 : 0.6,
                        lineDash: !isSafety && val > 20 ? [6, 4] : null,
                    };
                }
                case 'SOUNDG03': {
                    const depth = Number(props.depth);
                    const shallow = !isNaN(depth) && depth <= s.safetyDepth;
                    return {
                        textColor: this.color(shallow ? 'CHBLK0' : 'DEPCN0'),
                        textStroke: shallow ? this.color('CHWHT0') : 'rgba(255,255,255,0.85)',
                        fontWeight: shallow ? 'bold' : 'normal',
                        fontSize: shallow ? 11 : 10,
                    };
                }
                case 'LIGHTS06':
                    return this._lightsColors(props);
                case 'OBSTRN07':
                    return { fill: 'transparent', stroke: this.color('CHGRD0'), strokeWidth: 1, lineDash: [4, 4] };
                case 'WRECKS05':
                    return { fill: 'transparent', stroke: this.color('CHBLK0'), strokeWidth: 1, lineDash: [4, 4] };
                case 'SLCONS04':
                    return { stroke: this.color('CHBLK0'), strokeWidth: 2 };
                case 'QUAPOS01':
                    return { stroke: this.color('CSTLN0'), strokeWidth: 1, lineDash: [4, 4] };
                default:
                    return null;
            }
        }

        _lightsColors(props) {
            const colour = Number(props.COLOUR);
            let fill = 'LITYW0';
            if (colour === 3) fill = 'LITRD0';
            else if (colour === 4) fill = 'LITGN0';
            else if (colour === 1 || colour === 6) fill = 'CHWHT0';
            return { symbolFill: this.color(fill), symbolStroke: this.color('CHBLK0') };
        }

        _symbolSpec(symName, props) {
            const c = this.color.bind(this);
            const colour = Number(props.COLOUR);

            if (/^BOY/.test(symName)) {
                let fill = c('CHGRN0');
                if (colour === 3 || /14|24/.test(symName)) fill = c('CHRED0');
                else if (colour === 4 || /13|23/.test(symName)) fill = c('CHGRN0');
                else if (colour === 6) fill = c('CHYLW0');
                return { kind: 'triangle', fill, stroke: c('CHBLK0'), radius: 6 };
            }
            if (/^BCN/.test(symName)) {
                let fill = c('CHRED0');
                if (colour === 4) fill = c('CHGRN0');
                return { kind: 'square', fill, stroke: c('CHBLK0'), radius: 6 };
            }
            if (/^LIGHTS|^LIT/.test(symName)) {
                const ls = this._lightsColors(props);
                return { kind: 'light', fill: ls.symbolFill, stroke: ls.symbolStroke, radius: 5 };
            }
            if (/^FOG/.test(symName)) {
                return { kind: 'circle', fill: c('CHMGD0'), stroke: c('CHBLK0'), radius: 5 };
            }
            if (/FOULGND|OBSTRN/.test(symName)) {
                return { kind: 'star', fill: c('CHBLK0'), stroke: c('CHBLK0'), radius: 5 };
            }
            if (/WRECK/.test(symName)) {
                return { kind: 'cross', fill: c('CHBLK0'), stroke: c('CHBLK0'), radius: 6 };
            }
            if (/ACHBRT|ACHARE/.test(symName)) {
                return { kind: 'circle', fill: c('CHMGD0'), stroke: c('CHMGF0'), radius: 5 };
            }
            if (/LNDMRK/.test(symName)) {
                return { kind: 'triangle', fill: c('CHBRN0'), stroke: c('CHBLK0'), radius: 5 };
            }
            return null;
        }

        _buildSymbol(spec) {
            const stroke = new ol.style.Stroke({ color: spec.stroke, width: 1.2 });
            const fill = new ol.style.Fill({ color: spec.fill });
            switch (spec.kind) {
                case 'triangle':
                    return new ol.style.RegularShape({ points: 3, radius: spec.radius, fill, stroke, angle: 0 });
                case 'square':
                    return new ol.style.RegularShape({ points: 4, radius: spec.radius, fill, stroke, angle: Math.PI / 4 });
                case 'star':
                    return new ol.style.RegularShape({ points: 5, radius: spec.radius, radius2: spec.radius / 2, fill, stroke });
                case 'cross':
                    return new ol.style.Text({
                        text: '\u2715',
                        font: `bold ${spec.radius * 2}px sans-serif`,
                        fill: new ol.style.Fill({ color: spec.fill }),
                        stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.85)', width: 1.5 }),
                    });
                case 'light':
                    return new ol.style.RegularShape({
                        points: 4,
                        radius: spec.radius,
                        radius2: 2,
                        fill,
                        stroke,
                        angle: Math.PI / 4,
                    });
                default:
                    return new ol.style.Circle({ radius: spec.radius, fill, stroke });
            }
        }

        getStyle(feature, resolution) {
            if (!this.ready) return null;

            const layer = feature.get('layer');
            const geomType = feature.getGeometry().getType();
            const props = {};
            feature.getKeys().forEach(k => { if (k !== 'geometry') props[k] = feature.get(k); });

            if (HIDDEN_POINT_LAYERS.has(layer) && geomType.includes('Point')) {
                return null;
            }

            const cacheKey = `${layer}|${geomType}|${resolution | 0}|${props.DRVAL1}|${props.DRVAL2}|${props.VALDCO}|${props.depth}|${props.COLOUR}|${props.BOYSHP}|${props.BCNSHP}`;
            if (this._styleCache[cacheKey] !== undefined) return this._styleCache[cacheKey];

            const rule = this.findRule(layer, geomType, props);
            const cmds = rule ? this.parseInstructions(rule.inst) : [];

            let fill = null;
            let stroke = null;
            let strokeWidth = 1;
            let lineDash = null;
            let symbol = null;

            for (const { cmd, args } of cmds) {
                if (cmd === 'CS') {
                    const cs = this.applyConditional(args, props);
                    if (cs) {
                        if (cs.fill != null) fill = cs.fill;
                        if (cs.stroke) { stroke = cs.stroke; strokeWidth = cs.strokeWidth || 1; lineDash = cs.lineDash; }
                        if (cs.symbolFill) symbol = { kind: 'light', fill: cs.symbolFill, stroke: cs.symbolStroke, radius: 5 };
                    }
                } else if (cmd === 'AC') {
                    fill = this.color(args);
                } else if (cmd === 'LS') {
                    const p = args.split(',');
                    stroke = this.color(p[2]);
                    strokeWidth = Number(p[1]) || 1;
                    lineDash = LINE_DASH[p[0]] || null;
                } else if (cmd === 'SY') {
                    symbol = this._symbolSpec(args, props);
                }
            }

            const isPoly = geomType.includes('Polygon');
            const isLine = geomType.includes('Line');
            const isPoint = geomType.includes('Point');
            const styles = [];

            if (isPoly && fill) {
                styles.push(new ol.style.Style({
                    fill: new ol.style.Fill({ color: withAlpha(fill, 0.9) }),
                    stroke: stroke ? new ol.style.Stroke({ color: stroke, width: strokeWidth, lineDash: lineDash || undefined }) : undefined,
                }));
            } else if (isLine && stroke) {
                styles.push(new ol.style.Style({
                    stroke: new ol.style.Stroke({ color: stroke, width: strokeWidth, lineDash: lineDash || undefined }),
                }));
            }

            if (layer === 'SOUNDG' && props.depth != null) {
                const cs = this.applyConditional('SOUNDG03', props);
                styles.push(new ol.style.Style({
                    text: new ol.style.Text({
                        text: Number(props.depth).toFixed(1),
                        font: `${cs.fontWeight} ${cs.fontSize}px Consolas, monospace`,
                        fill: new ol.style.Fill({ color: cs.textColor }),
                        stroke: new ol.style.Stroke({ color: cs.textStroke, width: 2 }),
                    }),
                }));
            } else if (isPoint && symbol) {
                styles.push(new ol.style.Style({ image: this._buildSymbol(symbol) }));
            } else if (isPoint && layer === 'LIGHTS') {
                const ls = this._lightsColors(props);
                const r = resolution < 80 ? 6 : resolution < 300 ? 5 : 4;
                styles.push(new ol.style.Style({
                    image: new ol.style.RegularShape({
                        points: 4,
                        radius: r,
                        radius2: 2,
                        fill: new ol.style.Fill({ color: ls.symbolFill }),
                        stroke: new ol.style.Stroke({ color: ls.symbolStroke, width: 1.2 }),
                        angle: Math.PI / 4,
                    }),
                }));
            } else if (isPoint && !this._hasDrawableSymbol(cmds)) {
                return null;
            }

            const result = styles.length ? (styles.length === 1 ? styles[0] : styles) : null;
            this._styleCache[cacheKey] = result;
            return result;
        }

        getSeaColor() {
            return this.color('DEPDW0');
        }
    }

    global.S52PresLib = S52PresLib;
    global.s52 = new S52PresLib();
})(typeof window !== 'undefined' ? window : global);
