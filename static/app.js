(function () {
    'use strict';

    const CATEGORIES = {
        depth: ['DEPARE', 'DEPCNT', 'DRGARE', 'SBDARE', 'SEAARE'],
        sounding: ['SOUNDG'],
        light: ['LIGHTS', 'FOGSIG'],
        beacon: ['BCNCAR', 'BCNISD', 'BCNLAT', 'BCNSAW', 'BCNSPP', 'RTPBCN', 'TOPMAR'],
        buoy: ['BOYCAR', 'BOYISD', 'BOYLAT', 'BOYSAW', 'BOYSPP'],
        obstruction: ['OBSTRN', 'UWTROC'],
        wreck: ['WRECKS'],
        land: ['LNDARE', 'LNDMRK', 'LNDELV', 'LNDRGN', 'LAKARE', 'BUAARE', 'RIVERS', 'CANALS'],
        coastline: ['COALNE', 'SLCONS'],
        /** TSS, restricted areas, anchorages — S-52 magenta/purple (CHMGD/TRFC*); dense on overview charts. */
        traffic: ['RESARE', 'TSSBND', 'TSELNE', 'ISTZNE', 'TSSLPT', 'TSSRON', 'ACHBRT', 'ACHARE'],
        navigation: ['DWRTPT', 'TWRTPT', 'FAIRWY', 'FERYRT', 'RDOCAL', 'RDOSTA', 'CTRPNT', 'PILPNT', 'PILBOP'],
        infrastructure: ['BRIDGE', 'CBLOHD', 'CBLSUB', 'PIPSOL', 'MORFAC', 'DAMCON', 'PONTON', 'HULKES', 'PYLONS'],
        coverage: ['M_COVR', 'M_QUAL'],
    };

    const CLEAN_DISPLAY_CATEGORIES = ['depth', 'coastline', 'navigation'];
    /** Default: all except `traffic` (TSS / restricted / anchorage outlines often clutter small-scale views). */
    const enabledCategories = new Set(
        Object.keys(CATEGORIES).filter(function (c) { return c !== 'traffic'; })
    );

    const NAV_POINT_LAYERS = new Set([
        'LIGHTS', 'FOGSIG',
        'BCNCAR', 'BCNISD', 'BCNLAT', 'BCNSAW', 'BCNSPP', 'RTPBCN', 'TOPMAR',
        'BOYCAR', 'BOYISD', 'BOYLAT', 'BOYSAW', 'BOYSPP',
        'PILPNT', 'PILBOP', 'RDOSTA', 'CTRPNT', 'RDOCAL',
    ]);
    let currentFeatures = null;
    let loadingAbort = null;
    let loadDebounce = null;
    const VIEWPORT_LOAD_DEBOUNCE_MS = 50;
    let mapViewInteracting = false;
    const VIEWPORT_FETCH_BUFFER = 0.22;
    let preslibReady = false;
    let datasourceReady = false;
    let datasourceLoadActive = false;
    let mapDisplayReady = false;
    let chartLoadToken = 0;
    let lastDatasourceBounds = null;
    let indexedChartCount = 0;
    let viewportRetryDone = false;
    let mapReadyForPanLoad = false;
    let isFittingView = false;
    let lastViewportCacheKey = null;
    let lastStyleResolutionBucket = null;
    let pointerMoveRaf = null;
    const viewportChartCache = new Map();
    const viewportOlCache = new Map();
    const VIEWPORT_CACHE_MAX = 48;

    /** Coarse resolution steps so S-52 style cache hits during smooth wheel zoom. */
    function resolutionStyleBucket(resolution) {
        if (!Number.isFinite(resolution) || resolution <= 0) return 1;
        return Math.max(1, Math.round(resolution / 75) * 75);
    }

    function assignFeatureRenderOrder(features) {
        for (let i = 0; i < features.length; i++) {
            const layer = features[i].get('layer');
            features[i].set('renderOrder', LAYER_ORDER[layer] ?? 50, true);
        }
    }

    function refreshMapStylesIfNeeded() {
        if (!preslibReady) return;
        syncViewScaleDenom();
        const bucket = resolutionStyleBucket(map.getView().getResolution());
        if (bucket !== lastStyleResolutionBucket) {
            lastStyleResolutionBucket = bucket;
            vectorLayer.changed();
        }
    }
    let userHasPannedMap = false;
    let shouldRestoreLastView = true;
    let usingDefaultSample = false;
    let bootPreviewActive = false;
    let bootPreviewPromise = null;
    let bootBundlePrefetch = null;
    let pendingDatasourceResult = null;
    const folderLoadLogEntries = [];
    const FOLDER_LOAD_LOG_MAX = 250;
    const FOLDER_LOAD_LOG_STORAGE_KEY = 's57viewer-folder-load-log';
    let lastFolderLoadLogKey = '';

    (function restoreFolderLoadLogFromStorage() {
        try {
            const raw = sessionStorage.getItem(FOLDER_LOAD_LOG_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return;
            for (let i = 0; i < parsed.length; i++) {
                if (parsed[i] && parsed[i].text) folderLoadLogEntries.push(parsed[i]);
            }
        } catch (e) { /* ignore */ }
    })();
    let lastFolderLoadSummaryAt = null;
    let datasourceDisplaySettled = false;
    const geoJsonFormat = new ol.format.GeoJSON();
    /** Tighter focus than full ENC extent — matches peninsula demo view. */
    const KOREA_FOCUS_BOUNDS = [118, 32, 132, 42];

    function isLayerVisible(layerName) {
        for (const [cat, layers] of Object.entries(CATEGORIES)) {
            if (layers.includes(layerName)) {
                return enabledCategories.has(cat);
            }
        }
        return true;
    }

    function isScaminEnabled() {
        const el = document.getElementById('toggle-scamin');
        return el ? el.checked : true;
    }

    function passesScaminAtView(props, viewScale) {
        if (!props) return true;
        const rawMin = props.SCAMIN;
        if (rawMin != null && rawMin !== '') {
            const scamin = Number(rawMin);
            if (Number.isFinite(scamin) && viewScale > scamin) return false;
        }
        const rawMax = props.SCAMAX;
        if (rawMax != null && rawMax !== '') {
            const scamax = Number(rawMax);
            if (Number.isFinite(scamax) && viewScale < scamax) return false;
        }
        return true;
    }

    function featurePassesZoomFilter(feature, resolution) {
        const layer = feature.get('layer');
        const geomType = feature.getGeometry().getType();
        const viewScale = zoomToNearestScaleDenom(getZoomLevel());
        const props = feature.getProperties();

        if (isScaminEnabled() && !passesScaminAtView(props, viewScale)) return false;
        if (preslibReady && s52.settings.respectScamin && !s52.passesScaleLimits(props)) return false;

        /* Relaxed vs early viewer: match IHO-style overview (e.g. 1:10M) with symbols + soundings. */
        if (layer === 'SOUNDG' && (resolution > 9000 || viewScale > 45_000_000)) return false;
        if (layer === 'M_COVR' || layer === 'M_QUAL') return false;
        if (layer === 'LNDRGN' && resolution > 9000) return false;
        if (layer === 'LNDELV' && resolution > 3500) return false;
        if ((layer === 'LNDMRK' || layer === 'PILPNT') && resolution > 9000) return false;
        if (layer === 'DEPCNT' && (resolution > 9000 || viewScale > 30_000_000)) return false;
        if ((layer === 'OBSTRN' || layer === 'UWTROC' || layer === 'WRECKS')
            && geomType === 'Point' && (resolution > 9000 || viewScale > 28_000_000)) return false;
        if (layer === 'TOPMAR' && resolution > 9000) return false;

        if (NAV_POINT_LAYERS.has(layer) && geomType === 'Point') {
            if (viewScale > 100_000_000) return false;
            if (viewScale > 35_000_000 && resolution > 12000) return false;
        }
        if (geomType === 'Point' && viewScale > 45_000_000
            && (layer === 'BRIDGE' || layer === 'MORFAC' || layer === 'HULKES')) return false;
        return true;
    }

    function initDisplayOptionCheckboxes() {
        document.querySelectorAll('#display-options input[data-category]:not([data-category="all"])')
            .forEach(function (cb) {
                cb.checked = enabledCategories.has(cb.dataset.category);
            });
        const allCb = document.querySelector('input[data-category="all"]');
        if (allCb) {
            const cats = document.querySelectorAll(
                '#display-options input[data-category]:not([data-category="all"])'
            );
            allCb.checked = Array.from(cats).every(function (c) { return c.checked; });
        }
    }

    function applyCleanDisplayPreset() {
        enabledCategories.clear();
        CLEAN_DISPLAY_CATEGORIES.forEach(function (c) { enabledCategories.add(c); });
        initDisplayOptionCheckboxes();

        if (preslibReady) {
            s52.setDisplayCategory('STANDARD');
            s52.setSettings({
                respectScamin: true,
                showSoundings: false,
                showText: false,
                showLightDescriptions: false,
                showBuoyLightLabels: false,
                showVisibleSectorLights: false,
            });
        }

        const dispSel = document.getElementById('display-category-select');
        if (dispSel) dispSel.value = 'STANDARD';
        const scaminToggle = document.getElementById('toggle-scamin');
        if (scaminToggle) scaminToggle.checked = true;
        const showSnd = document.getElementById('toggle-soundings');
        if (showSnd) showSnd.checked = false;
        const showText = document.getElementById('toggle-show-text');
        if (showText) showText.checked = false;
        const lightDesc = document.getElementById('toggle-light-desc');
        if (lightDesc) lightDesc.checked = false;
        const buoyLabels = document.getElementById('toggle-buoy-labels');
        if (buoyLabels) buoyLabels.checked = false;
        const visibleSectors = document.getElementById('toggle-visible-sectors');
        if (visibleSectors) visibleSectors.checked = false;

        if (preslibReady) {
            s52.clearStyleCache();
            lastStyleResolutionBucket = null;
            lastViewportCacheKey = null;
            vectorLayer.changed();
            scheduleViewportLoad();
        }
    }

    /** Dense ENC default (IHO S-100-style): all layers, text/soundings, SCAMIN off, display «Other». */
    function applyFullDisplayPreset() {
        enabledCategories.clear();
        Object.keys(CATEGORIES).forEach(function (c) { enabledCategories.add(c); });
        initDisplayOptionCheckboxes();

        if (preslibReady) {
            s52.setDisplayCategory('OTHER');
            s52.setSettings({
                respectScamin: false,
                showSoundings: true,
                showText: true,
                showLightDescriptions: true,
                showBuoyLightLabels: true,
                showVisibleSectorLights: true,
            });
        }

        const dispSel = document.getElementById('display-category-select');
        if (dispSel) dispSel.value = 'OTHER';
        const scaminToggle = document.getElementById('toggle-scamin');
        if (scaminToggle) scaminToggle.checked = false;
        const showSnd = document.getElementById('toggle-soundings');
        if (showSnd) showSnd.checked = true;
        const showText = document.getElementById('toggle-show-text');
        if (showText) showText.checked = true;
        const lightDesc = document.getElementById('toggle-light-desc');
        if (lightDesc) lightDesc.checked = true;
        const buoyLabels = document.getElementById('toggle-buoy-labels');
        if (buoyLabels) buoyLabels.checked = true;
        const visibleSectors = document.getElementById('toggle-visible-sectors');
        if (visibleSectors) visibleSectors.checked = true;

        if (preslibReady) {
            s52.clearStyleCache();
            lastStyleResolutionBucket = null;
            lastViewportCacheKey = null;
            vectorLayer.changed();
            scheduleViewportLoad();
        }
    }

    function filterFeaturesForDisplay(features) {
        return features.filter(function (f) {
            return isLayerVisible(f.get('layer'));
        });
    }

    function syncViewScaleDenom() {
        if (!preslibReady) return;
        s52.setViewScaleDenom(zoomToNearestScaleDenom(getZoomLevel()));
    }

    /** Popup only for layers enabled in Display Option and currently drawn. */
    function isFeatureInspectable(feature, resolution) {
        const layer = feature.get('layer');
        if (!isLayerVisible(layer)) return false;
        if (!featurePassesZoomFilter(feature, resolution)) return false;
        if (!preslibReady) return false;
        return s52.getStyle(feature, resolution) != null;
    }

    function styleFunction(feature, resolution) {
        const layer = feature.get('layer');
        if (!isLayerVisible(layer)) return null;
        if (!featurePassesZoomFilter(feature, resolution)) return null;
        if (!preslibReady) return null;
        return s52.getStyle(feature, resolution);
    }

    // --- Z-index ordering for layers (S-52 display priority) ---
    const LAYER_ORDER = {
        'UNSARE': 0, 'M_COVR': 1, 'M_QUAL': 1,
        'SEAARE': 2, 'DEPARE': 3, 'DRGARE': 3, 'SBDARE': 3,
        /* LNDARE before LAKARE: simplified land must not paint over inland water (e.g. Lake Biwa). */
        'LNDARE': 4,
        'LAKARE': 5, 'RIVERS': 5, 'CANALS': 5,
        'BUAARE': 6,
        'FAIRWY': 7, 'RESARE': 8,
        'TSSBND': 9, 'TSELNE': 9, 'ISTZNE': 9, 'TSSLPT': 9, 'TSSRON': 9,
        'DEPCNT': 10, 'COALNE': 11, 'SLCONS': 12,
        'ACHBRT': 13, 'ACHARE': 13, 'DWRTPT': 14, 'TWRTPT': 14,
        'FERYRT': 15, 'CBLOHD': 16, 'CBLSUB': 16, 'PIPSOL': 17,
        'BRIDGE': 18, 'DAMCON': 19, 'PONTON': 19, 'HULKES': 19, 'MORFAC': 19,
        'OBSTRN': 20, 'UWTROC': 21, 'WRECKS': 22,
        'SOUNDG': 25,
        'BOYCAR': 30, 'BOYISD': 30, 'BOYLAT': 30, 'BOYSAW': 30, 'BOYSPP': 30,
        'BCNCAR': 31, 'BCNISD': 31, 'BCNLAT': 31, 'BCNSAW': 31, 'BCNSPP': 31,
        'PILPNT': 33, 'PILBOP': 33,
        'LNDMRK': 34,
        'RTPBCN': 35, 'RDOSTA': 36, 'CTRPNT': 37,
        'TOPMAR': 38, 'RDOCAL': 38,
        'LIGHTS': 40, 'FOGSIG': 41,
    };

    // --- Map setup ---

    const vectorSource = new ol.source.Vector();

    const vectorLayer = new ol.layer.Vector({
        source: vectorSource,
        style: styleFunction,
        declutter: true,
        renderBuffer: 256,
        updateWhileAnimating: false,
        updateWhileInteracting: false,
        zIndex: 1,
        renderOrder: function (a, b) {
            return (a.get('renderOrder') ?? 50) - (b.get('renderOrder') ?? 50);
        },
    });

    /** Cached `/api/index` for “파일 영역 격자” overlay (invalidated on datasource change). */
    let chartExtentIndexCache = null;
    let chartExtentGridRebuildTimer = null;
    /** Monotonic id so only the latest `rebuildChartExtentGrid` run may mutate the layer (avoids async races). */
    let chartExtentGridBuildSeq = 0;

    const chartExtentGridSource = new ol.source.Vector();
    const chartExtentGridStyleFn = function (feature) {
        const kind = feature.get('gridKind');
        if (kind === 'frame') {
            return new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: 'rgba(255, 213, 79, 0.88)',
                    width: 1.5,
                }),
            });
        }
        return new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: 'rgba(255, 213, 79, 0.5)',
                width: 1,
                lineDash: [5, 6],
            }),
        });
    };
    const chartExtentGridLayer = new ol.layer.Vector({
        source: chartExtentGridSource,
        style: chartExtentGridStyleFn,
        visible: false,
        zIndex: 0,
        updateWhileAnimating: false,
        updateWhileInteracting: false,
    });

    const map = window._map = new ol.Map({
        target: 'map',
        layers: [chartExtentGridLayer, vectorLayer],
        view: new ol.View({
            center: ol.proj.fromLonLat([127.5, 36.0]),
            zoom: 7,
            minZoom: 3,
            maxZoom: 21,
            constrainResolution: false,
            smoothResolutionConstraint: false,
        }),
        controls: ol.control.defaults.defaults().extend([
            new ol.control.ScaleLine(),
        ]),
        interactions: ol.interaction.defaults.defaults({
            mouseWheelZoom: new ol.interaction.MouseWheelZoom({
                maxDelta: 8,
                duration: 90,
                timeout: 40,
                constrainResolution: false,
            }),
            pinchZoom: new ol.interaction.PinchZoom({
                duration: 90,
                constrainResolution: false,
            }),
            doubleClickZoom: new ol.interaction.DoubleClickZoom({
                delta: 2.5,
                duration: 200,
                constrainResolution: false,
            }),
        }),
    });

    // Mouse position + cursor (hit-test throttled to one per animation frame)
    map.on('pointermove', function (evt) {
        const coord = ol.proj.toLonLat(evt.coordinate);
        const ns = coord[1] >= 0 ? 'N' : 'S';
        const ew = coord[0] >= 0 ? 'E' : 'W';
        document.getElementById('mouse-position').textContent =
            Math.abs(coord[1]).toFixed(6) + '°' + ns + '  ' +
            Math.abs(coord[0]).toFixed(6) + '°' + ew;
        const pixel = evt.pixel.slice();
        if (pointerMoveRaf !== null) return;
        pointerMoveRaf = requestAnimationFrame(function () {
            pointerMoveRaf = null;
            const hit = map.hasFeatureAtPixel(pixel, {
                hitTolerance: 5,
                layerFilter: function (layer) { return layer === vectorLayer; },
            });
            map.getTargetElement().style.cursor = hit ? 'pointer' : '';
        });
    });

    // --- Data loading ---

    function getVisibleLayers() {
        const layers = [];
        for (const [cat, catLayers] of Object.entries(CATEGORIES)) {
            if (enabledCategories.has(cat)) {
                layers.push(...catLayers);
            }
        }
        return [...new Set(layers)];
    }

    function getBootViewportParams() {
        const [w, s, e, n] = KOREA_FOCUS_BOUNDS;
        const [west, south, east, north] = expandViewportBounds(w, s, e, n);
        return {
            west: west,
            south: south,
            east: east,
            north: north,
            zoom: 7,
            layers: getVisibleLayers().join(','),
        };
    }

    function prefetchBootViewport() {
        if (!globalThis.BootCache) return null;
        if (!bootBundlePrefetch) {
            bootBundlePrefetch = BootCache.loadDefaultViewport();
        }
        return bootBundlePrefetch;
    }

    function applyBootMapView(bundle) {
        if (userHasPannedMap || !bundle) return;
        const bounds = bundle.bounds
            || (bundle.viewport
                ? [bundle.viewport.west, bundle.viewport.south, bundle.viewport.east, bundle.viewport.north]
                : null);
        const displayBounds = pickDisplayBounds(bounds);
        if (!displayBounds || displayBounds.length !== 4) return;
        isFittingView = true;
        mapReadyForPanLoad = false;
        const extent = ol.proj.transformExtent(displayBounds, 'EPSG:4326', 'EPSG:3857');
        map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 9, duration: 0 });
        isFittingView = false;
    }

    function applyBootPreviewBundle(bundle) {
        const vp = bundle.viewport || getBootViewportParams();
        const layerList = vp.layers ? vp.layers.split(',') : getVisibleLayers();
        const cacheKey = getViewportCacheKey(vp.west, vp.south, vp.east, vp.north, vp.zoom, layerList);
        applyChartData(bundle.data, cacheKey);
        rememberViewportCache(cacheKey, bundle.data);
        lastViewportCacheKey = cacheKey;
        if (bundle.data.meta && bundle.data.meta.s52_settings) {
            applyS52Settings(bundle.data.meta.s52_settings);
        }
        applyBootMapView(bundle);
        bootPreviewActive = true;
        mapDisplayReady = true;
        mapReadyForPanLoad = false;
        showLoading(datasourceLoadActive, datasourceLoadActive ? 'subtle' : false);
        if (!datasourceLoadActive) showViewportUpdating(false);
        const pathEl = document.getElementById('datasource-path');
        if (pathEl && !datasourceReady) {
            const label = bundle.source === 'idb' ? 'cached demo' : 'demo preview';
            pathEl.textContent = `Showing ${label} — loading chart index…`;
            pathEl.classList.add('loaded');
        }
        updateInfo(
            bundle.data.meta && bundle.data.meta.charts_loaded,
            bundle.data.meta && bundle.data.meta.total_features
        );
        vectorLayer.changed();
        map.render();
    }

    async function tryBootPreview() {
        if (bootPreviewActive || userHasPannedMap || !preslibReady) {
            return false;
        }
        if (!globalThis.BootCache) return false;
        if (bootPreviewPromise) return bootPreviewPromise;

        bootPreviewPromise = (async function () {
            let bundle = null;
            let ds = null;
            try {
                const bundlePromise = bootBundlePrefetch
                    ? bootBundlePrefetch
                    : BootCache.loadDefaultViewport();
                const dsPromise = fetchDatasourceResilient()
                    .then(function (r) { return r.ok ? r.data : null; })
                    .catch(function () { return null; });
                [ds, bundle] = await Promise.all([dsPromise, bundlePromise]);
            } catch (e) {
                /* bundle or status fetch failed — try static/IDB bundle once more below */
            }
            bootBundlePrefetch = null;

            if (userHasPannedMap) return false;
            if (ds && ds.loaded && !isDefaultSampleLoaded(ds)) return false;

            if (!bundle || !bundle.data || !bundle.data.features || !bundle.data.features.length) {
                try {
                    bundle = await BootCache.loadDefaultViewport();
                } catch (e2) { /* ignore */ }
            }
            if (!bundle || !bundle.data || !bundle.data.features || !bundle.data.features.length) {
                return false;
            }
            if (userHasPannedMap) return false;

            applyBootPreviewBundle(bundle);
            return true;
        })().finally(function () {
            bootPreviewPromise = null;
        });

        return bootPreviewPromise;
    }

    function maybePersistBootCache(west, south, east, north, zoom, layers, data) {
        if (!usingDefaultSample || userHasPannedMap || !globalThis.BootCache) return;
        const params = getBootViewportParams();
        const sameView =
            Math.abs(west - params.west) < 0.05
            && Math.abs(south - params.south) < 0.05
            && Math.abs(east - params.east) < 0.05
            && Math.abs(north - params.north) < 0.05
            && zoom === params.zoom;
        if (!sameView) return;
        BootCache.saveDefaultViewport({
            bounds: pickDisplayBounds(lastDatasourceBounds),
            viewport: {
                west: west,
                south: south,
                east: east,
                north: north,
                zoom: zoom,
                layers: layers.join(','),
            },
            data: data,
        });
    }

    function getZoomLevel() {
        return Math.round(map.getView().getZoom());
    }

    function roundViewportCoord(value) {
        return Math.round(value * 40) / 40;
    }

    function expandViewportBounds(west, south, east, north) {
        const spanLon = east - west;
        const spanLat = north - south;
        const padLon = spanLon * VIEWPORT_FETCH_BUFFER;
        const padLat = spanLat * VIEWPORT_FETCH_BUFFER;
        return [
            west - padLon,
            south - padLat,
            east + padLon,
            north + padLat,
        ];
    }

    function invalidateChartExtentIndexCache() {
        chartExtentIndexCache = null;
        chartExtentGridBuildSeq++;
    }

    function boundsOverlap4326(a, b) {
        if (!a || !b || a.length !== 4 || b.length !== 4) return false;
        return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }

    function appendChartExtentGridFeatures(features, bounds, cellCount) {
        const [w, s, e, n] = bounds;
        if (!(e > w && n > s)) return;
        const lon = e - w;
        const lat = n - s;
        const ring = [
            ol.proj.fromLonLat([w, s]),
            ol.proj.fromLonLat([e, s]),
            ol.proj.fromLonLat([e, n]),
            ol.proj.fromLonLat([w, n]),
            ol.proj.fromLonLat([w, s]),
        ];
        features.push(new ol.Feature({
            geometry: new ol.geom.Polygon([ring]),
            gridKind: 'frame',
        }));
        if (!(cellCount > 0)) return;
        const cells = Math.max(2, Math.min(14, Math.floor(cellCount)));
        for (let i = 1; i < cells; i++) {
            const x = w + (lon * i) / cells;
            features.push(new ol.Feature({
                geometry: new ol.geom.LineString([
                    ol.proj.fromLonLat([x, s]),
                    ol.proj.fromLonLat([x, n]),
                ]),
                gridKind: 'cell',
            }));
        }
        for (let j = 1; j < cells; j++) {
            const y = s + (lat * j) / cells;
            features.push(new ol.Feature({
                geometry: new ol.geom.LineString([
                    ol.proj.fromLonLat([w, y]),
                    ol.proj.fromLonLat([e, y]),
                ]),
                gridKind: 'cell',
            }));
        }
    }

    function scheduleChartExtentGridRefresh() {
        const el = document.getElementById('toggle-chart-extent-grid');
        if (!el || !el.checked) return;
        if (chartExtentGridRebuildTimer) clearTimeout(chartExtentGridRebuildTimer);
        chartExtentGridRebuildTimer = setTimeout(function () {
            chartExtentGridRebuildTimer = null;
            void rebuildChartExtentGrid();
        }, 140);
    }

    async function rebuildChartExtentGrid() {
        const el = document.getElementById('toggle-chart-extent-grid');
        if (!el || !el.checked || !datasourceReady) {
            chartExtentGridBuildSeq++;
            chartExtentGridSource.clear();
            chartExtentGridLayer.setVisible(false);
            return;
        }
        const size = map.getSize();
        if (!size || size[0] < 8 || size[1] < 8) return;
        const buildId = ++chartExtentGridBuildSeq;
        try {
            if (!chartExtentIndexCache) {
                const resp = await fetch('/api/index');
                if (buildId !== chartExtentGridBuildSeq) return;
                if (!resp.ok) throw new Error('index ' + resp.status);
                chartExtentIndexCache = await resp.json();
            }
            if (buildId !== chartExtentGridBuildSeq) return;
            const list = chartExtentIndexCache;
            if (!Array.isArray(list) || !list.length) {
                if (buildId !== chartExtentGridBuildSeq) return;
                chartExtentGridSource.clear();
                chartExtentGridLayer.setVisible(false);
                return;
            }
            const extent = map.getView().calculateExtent(map.getSize());
            const [vw, vs] = ol.proj.toLonLat([extent[0], extent[1]]);
            const [ve, vn] = ol.proj.toLonLat([extent[2], extent[3]]);
            const [gw, gs, ge, gn] = expandViewportBounds(vw, vs, ve, vn);
            const viewBounds = [gw, gs, ge, gn];
            const visible = [];
            for (let i = 0; i < list.length; i++) {
                const row = list[i];
                const b = row && row.bounds;
                if (b && b.length === 4 && boundsOverlap4326(b, viewBounds)) {
                    visible.push(b);
                }
            }
            let cellCount = 8;
            if (visible.length > 80) cellCount = 5;
            if (visible.length > 200) cellCount = 0;

            const MAX_OVERLAY_CHARTS = 450;
            let toDraw = visible;
            if (visible.length > MAX_OVERLAY_CHARTS) {
                toDraw = visible.slice(0, MAX_OVERLAY_CHARTS);
                cellCount = 0;
            }

            const features = [];
            for (let j = 0; j < toDraw.length; j++) {
                appendChartExtentGridFeatures(features, toDraw[j], cellCount);
            }
            if (buildId !== chartExtentGridBuildSeq) return;
            chartExtentGridSource.clear();
            chartExtentGridSource.addFeatures(features);
            chartExtentGridLayer.setVisible(features.length > 0);
        } catch (err) {
            if (buildId !== chartExtentGridBuildSeq) return;
            console.error('Chart extent grid failed:', err);
            chartExtentGridSource.clear();
            chartExtentGridLayer.setVisible(false);
        }
    }

    function getViewportCacheKey(west, south, east, north, zoom, layers) {
        return [
            roundViewportCoord(west),
            roundViewportCoord(south),
            roundViewportCoord(east),
            roundViewportCoord(north),
            zoom,
            layers.join(','),
            isScaminEnabled() ? '1' : '0',
        ].join('|');
    }

    function rememberViewportCache(key, data) {
        if (viewportChartCache.has(key)) {
            viewportChartCache.delete(key);
            viewportOlCache.delete(key);
        }
        viewportChartCache.set(key, data);
        while (viewportChartCache.size > VIEWPORT_CACHE_MAX) {
            const oldest = viewportChartCache.keys().next().value;
            viewportChartCache.delete(oldest);
            viewportOlCache.delete(oldest);
        }
    }

    function parseChartFeatures(data, cacheKey) {
        if (cacheKey && viewportOlCache.has(cacheKey)) {
            return viewportOlCache.get(cacheKey);
        }
        let features = geoJsonFormat.readFeatures(data, {
            featureProjection: 'EPSG:3857',
            dataProjection: 'EPSG:4326',
        });
        features = filterFeaturesForDisplay(features);
        assignFeatureRenderOrder(features);
        if (cacheKey) {
            viewportOlCache.set(cacheKey, features);
        }
        return features;
    }

    function applyChartData(data, cacheKey, opts) {
        const keepIfEmpty = opts && opts.keepIfEmpty;
        const chartsMatched = data.meta && (data.meta.charts_matched || 0);
        const features = parseChartFeatures(data, cacheKey);
        // Keep prior draw only when charts overlap this view but nothing was returned (cap/filter).
        if (
            keepIfEmpty
            && features.length === 0
            && vectorSource.getFeatures().length > 0
            && chartsMatched > 0
        ) {
            if (data.meta) renderViewportReport(data.meta);
            return false;
        }
        if (features.length === 0) {
            vectorSource.clear();
            currentFeatures = data;
            updateInfo(0, 0);
            if (data.meta) renderViewportReport(data.meta);
            return false;
        }
        vectorSource.clear();
        vectorSource.addFeatures(features);
        currentFeatures = data;
        lastStyleResolutionBucket = null;
        updateInfo(data.meta.charts_loaded, data.meta.total_features);
        renderViewportReport(data.meta);
        return true;
    }

    function waitForNextMapRender(timeoutMs) {
        const limit = timeoutMs == null ? 10000 : timeoutMs;
        return new Promise(function (resolve) {
            let settled = false;
            const finish = function () {
                if (settled) return;
                settled = true;
                ol.Observable.unByKey(listenerKey);
                clearTimeout(timer);
                resolve();
            };
            const listenerKey = map.once('rendercomplete', finish);
            const timer = setTimeout(finish, limit);
            map.render();
        });
    }

    function tryLoadCharts() {
        if (!datasourceReady) return;
        loadCharts();
    }

    async function loadCharts() {
        if (!datasourceReady) return;

        const extent = map.getView().calculateExtent(map.getSize());
        const [viewWest, viewSouth] = ol.proj.toLonLat([extent[0], extent[1]]);
        const [viewEast, viewNorth] = ol.proj.toLonLat([extent[2], extent[3]]);
        const [west, south, east, north] = expandViewportBounds(viewWest, viewSouth, viewEast, viewNorth);
        const zoom = getZoomLevel();
        const visibleLayers = getVisibleLayers();
        const keepIfEmpty = mapDisplayReady;

        if (visibleLayers.length === 0) {
            vectorSource.clear();
            updateInfo(0, 0);
            renderViewportReport(null);
            mapDisplayReady = true;
            showLoading(false);
            showViewportUpdating(false);
            return;
        }

        const cacheKey = getViewportCacheKey(west, south, east, north, zoom, visibleLayers);
        if (cacheKey === lastViewportCacheKey && mapDisplayReady) {
            return;
        }

        const cached = viewportChartCache.get(cacheKey);
        if (cached) {
            lastViewportCacheKey = cacheKey;
            applyChartData(cached, cacheKey, { keepIfEmpty: keepIfEmpty });
            mapDisplayReady = true;
            mapReadyForPanLoad = true;
            return;
        }

        const isViewportUpdate = mapDisplayReady;
        if (mapReadyForPanLoad && loadingAbort) loadingAbort.abort();
        loadingAbort = new AbortController();
        const signal = loadingAbort.signal;
        const token = ++chartLoadToken;
        if (isViewportUpdate) {
            showLoading(false);
            showViewportUpdating(true);
        } else {
            showViewportUpdating(false);
            showLoading(true, bootPreviewActive ? 'subtle' : undefined);
            updateProgressUI({
                message: 'Loading chart features for map…',
                percent: null,
                detail: `Zoom ${zoom}`,
                indeterminate: true,
            });
        }

        const fetchTimeoutMs = 120000;
        let abortedByTimeout = false;
        const timeoutId = setTimeout(function () {
            abortedByTimeout = true;
            if (!signal.aborted) loadingAbort.abort();
        }, fetchTimeoutMs);

        try {
            const scaminFlag = isScaminEnabled() ? 1 : 0;
            const url = `/api/charts?west=${west}&south=${south}&east=${east}&north=${north}&zoom=${zoom}&layers=${visibleLayers.join(',')}&scamin=${scaminFlag}`;
            const resp = await fetch(url, { signal });
            if (signal.aborted || token !== chartLoadToken) return;
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || resp.statusText);
            }
            const data = await resp.json();
            if (signal.aborted || token !== chartLoadToken) return;

            rememberViewportCache(cacheKey, data);
            lastViewportCacheKey = cacheKey;
            applyChartData(data, cacheKey, { keepIfEmpty: keepIfEmpty });
            if (data.meta && data.meta.s52_settings) {
                applyS52Settings(data.meta.s52_settings);
            }
            maybePersistBootCache(west, south, east, north, zoom, visibleLayers, data);
            mapDisplayReady = true;
            bootPreviewActive = false;

            if ((data.meta.charts_loaded || 0) > 0 || (data.meta.charts_matched || 0) > 0) {
                viewportRetryDone = true;
            }

            if (!isViewportUpdate) {
                updateProgressUI({
                    message: 'Rendering chart on map…',
                    percent: null,
                    detail: data.meta.total_features
                        ? `${data.meta.total_features.toLocaleString()} features`
                        : `Zoom ${zoom}`,
                    indeterminate: true,
                });
                if (signal.aborted || token !== chartLoadToken) return;
                await waitForNextMapRender(3000);
                if (signal.aborted || token !== chartLoadToken) return;
            }

            mapReadyForPanLoad = true;

            if (
                !viewportRetryDone
                && !userHasPannedMap
                && indexedChartCount > 0
                && (data.meta.charts_matched || 0) === 0
                && lastDatasourceBounds
            ) {
                viewportRetryDone = true;
                fitMapToBounds(pickDisplayBounds(lastDatasourceBounds), tryLoadCharts);
            }
        } catch (e) {
            if (e.name === 'AbortError' && abortedByTimeout && token === chartLoadToken) {
                if (!isViewportUpdate) {
                    updateProgressUI({
                        message: 'Chart load timed out',
                        percent: null,
                        detail: 'Try zooming in or reducing display layers',
                        indeterminate: true,
                    });
                }
            } else if (e.name !== 'AbortError') {
                console.error('Failed to load charts:', e);
                const hasDisplayedFeatures = currentFeatures && currentFeatures.length > 0;
                if (isViewportUpdate && mapDisplayReady && !hasDisplayedFeatures) {
                    vectorSource.clear();
                    currentFeatures = null;
                    lastViewportCacheKey = null;
                    updateInfo(0, 0);
                    renderViewportReport(null);
                } else if (!isViewportUpdate) {
                    updateProgressUI({
                        message: 'Could not load chart display',
                        percent: null,
                        detail: e.message || '',
                        indeterminate: true,
                    });
                }
            }
        } finally {
            clearTimeout(timeoutId);
            if (token === chartLoadToken) {
                if (isViewportUpdate) {
                    showViewportUpdating(false);
                } else if (!signal.aborted) {
                    showLoading(false);
                }
            }
            if (!mapReadyForPanLoad && datasourceReady && !isFittingView) {
                mapReadyForPanLoad = true;
            }
        }
    }

    function canScheduleChartLoad() {
        return datasourceReady && mapReadyForPanLoad && !isFittingView;
    }

    function setMapViewInteracting(active) {
        mapViewInteracting = active;
        const container = document.getElementById('map-container');
        if (container) container.classList.toggle('map-interacting', active);
    }

    function updateInfoZoomScaleOnly() {
        const zoom = getZoomLevel();
        document.getElementById('info-zoom').textContent = zoom;
        const scales = {
            4: '1:50,000,000', 5: '1:25,000,000', 6: '1:10,000,000',
            7: '1:5,000,000', 8: '1:3,500,000', 9: '1:700,000',
            10: '1:350,000', 11: '1:180,000', 12: '1:90,000',
            13: '1:45,000', 14: '1:22,000', 15: '1:12,000',
            16: '1:6,000', 17: '1:3,000', 18: '1:1,500',
        };
        document.getElementById('info-scale').textContent =
            scales[zoom] || '~1:' + Math.round(559082264 / Math.pow(2, zoom)).toLocaleString();
        syncScaleSelect(zoomToNearestScaleDenom(zoom));
    }

    function finalizeMapViewAfterInteraction() {
        if (!preslibReady) return;
        syncScaleSelect(zoomToNearestScaleDenom(getZoomLevel()));
        refreshMapStylesIfNeeded();
        updateInfo(
            parseInt(document.getElementById('info-charts').textContent, 10) || 0,
            parseInt(document.getElementById('info-features').textContent.replace(/,/g, ''), 10) || 0
        );
    }

    function scheduleViewportLoad() {
        if (!canScheduleChartLoad()) return;
        if (mapDisplayReady) userHasPannedMap = true;
        if (loadDebounce) clearTimeout(loadDebounce);
        loadDebounce = setTimeout(loadCharts, VIEWPORT_LOAD_DEBOUNCE_MS);
    }

    function onMapMoveStart() {
        if (isFittingView) return;
        setMapViewInteracting(true);
        if (loadDebounce) {
            clearTimeout(loadDebounce);
            loadDebounce = null;
        }
        if (loadingAbort && mapDisplayReady) {
            loadingAbort.abort();
            loadingAbort = null;
        }
    }

    function onMapMoveEnd() {
        setMapViewInteracting(false);
        finalizeMapViewAfterInteraction();
        scheduleViewportLoad();
        scheduleChartExtentGridRefresh();
    }

    function pickDisplayBounds(bounds) {
        if (!bounds || bounds.length !== 4) return KOREA_FOCUS_BOUNDS;
        const [w, s, e, n] = bounds;
        const spanLon = e - w;
        const spanLat = n - s;
        if (spanLon > 35 || spanLat > 35 || spanLon < 0 || spanLat < 0) {
            return KOREA_FOCUS_BOUNDS;
        }
        return bounds;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatBounds(bounds) {
        if (!bounds || bounds.length !== 4) return '—';
        return `W ${bounds[0].toFixed(2)}° S ${bounds[1].toFixed(2)}° E ${bounds[2].toFixed(2)}° N ${bounds[3].toFixed(2)}°`;
    }

    function formatLogTime(date) {
        const d = date || new Date();
        return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function persistFolderLoadLog() {
        try {
            sessionStorage.setItem(FOLDER_LOAD_LOG_STORAGE_KEY, JSON.stringify(folderLoadLogEntries));
        } catch (e) { /* quota or private mode */ }
    }

    function notifyAdminConsoleProcessLog() {
        if (window.S57AdminConsole) {
            window.S57AdminConsole.setProcessEntries(folderLoadLogEntries);
        }
    }

    function clearFolderLoadLog() {
        folderLoadLogEntries.length = 0;
        lastFolderLoadLogKey = '';
        lastFolderLoadSummaryAt = null;
        try { sessionStorage.removeItem(FOLDER_LOAD_LOG_STORAGE_KEY); } catch (e) { /* ignore */ }
        notifyAdminConsoleProcessLog();
    }

    function appendFolderLoadLog(text, level) {
        if (!text) return;
        const lvl = level || 'info';
        folderLoadLogEntries.push({
            time: formatLogTime(),
            text: String(text),
            level: lvl,
        });
        if (folderLoadLogEntries.length > FOLDER_LOAD_LOG_MAX) {
            folderLoadLogEntries.splice(0, folderLoadLogEntries.length - FOLDER_LOAD_LOG_MAX);
        }
        persistFolderLoadLog();
        notifyAdminConsoleProcessLog();
    }

    function appendFolderLoadLogFromProgress(p) {
        if (!p) return;
        const parts = [];
        if (p.files_found > 0 && p.phase === 'scan' && p.current === 0) {
            parts.push('.000 파일 ' + p.files_found + '개 발견');
        }
        if (p.phase === 'upload' && p.current_file) {
            parts.push('업로드 (' + p.current + '/' + p.total + '): ' + p.current_file);
        } else if (p.phase === 'index' && p.current_file) {
            parts.push('인덱싱 (' + p.current + '/' + p.total + '): ' + p.current_file);
            if (p.indexed_ok > 0 || p.indexed_failed > 0) {
                parts.push('성공 ' + p.indexed_ok + ' · 실패 ' + p.indexed_failed);
            }
        } else if (p.message) {
            parts.push(p.message);
        }
        const line = parts.join(' — ');
        if (!line) return;
        const key = [p.phase, p.current, p.total, p.message, p.current_file].join('|');
        if (key === lastFolderLoadLogKey) return;
        lastFolderLoadLogKey = key;
        appendFolderLoadLog(line, p.status === 'error' ? 'error' : 'info');
    }

    function logFolderLoadSummary(report) {
        if (!report?.summary) return;
        const stamp = report.generated_at;
        if (stamp && stamp === lastFolderLoadSummaryAt) return;
        lastFolderLoadSummaryAt = stamp;
        const s = report.summary;
        let line = '완료: .000 파일 ' + (s.files_found ?? 0) + '개 · 인덱스 성공 ' + (s.indexed_ok ?? 0);
        if (s.indexed_failed > 0) line += ' · 실패 ' + s.indexed_failed;
        if (s.from_cache) line += ' (캐시에서 로드)';
        else if (s.duration_sec != null) line += ' · ' + s.duration_sec + '초';
        appendFolderLoadLog(line, s.indexed_failed > 0 ? 'warn' : 'ok');
        const failed = report.failed || [];
        for (let i = 0; i < Math.min(failed.length, 8); i++) {
            appendFolderLoadLog('실패: ' + (failed[i].file || failed[i].name) + ' — ' + failed[i].error, 'warn');
        }
        if (failed.length > 8) {
            appendFolderLoadLog('… 외 ' + (failed.length - 8) + '개 파일 실패', 'warn');
        }
    }

    function updateDatasourceReportLink(report) {
        const link = document.getElementById('datasource-report-link');
        if (!link) return;
        if (report?.summary) {
            const s = report.summary;
            link.classList.remove('hidden');
            link.textContent = '.000 분석 결과 (' + (s.indexed_ok ?? 0) + '개 성공' +
                (s.indexed_failed > 0 ? ', ' + s.indexed_failed + '개 실패' : '') + ') →';
        } else {
            link.classList.add('hidden');
        }
    }

    function hideDatasourceReportLink() {
        document.getElementById('datasource-report-link')?.classList.add('hidden');
    }

    function fetchAndRenderFolderReport(existingReport) {
        if (existingReport?.summary) {
            logFolderLoadSummary(existingReport);
            updateDatasourceReportLink(existingReport);
        }
    }

    function renderViewportReport(meta) {
        const details = document.getElementById('viewport-report-details');
        const body = document.getElementById('viewport-report-body');
        const matchedEl = document.getElementById('info-charts-matched');
        if (!details || !body || !meta) return;

        if (matchedEl) {
            const loaded = meta.charts_loaded ?? 0;
            const matched = meta.charts_matched != null ? meta.charts_matched : loaded;
            const shown = matched > 0 ? matched : (loaded > 0 ? loaded : 0);
            matchedEl.textContent = meta.features_capped && loaded < shown
                ? `${shown} (${loaded} drawn, feature limit)`
                : String(shown);
        }

        const chartsLoaded = meta.charts_loaded ?? 0;
        const chartsMatched = meta.charts_matched != null ? meta.charts_matched : chartsLoaded;
        if (!chartsMatched && !chartsLoaded) {
            details.classList.remove('hidden');
            body.innerHTML = `<p class="report-note">No charts match this view at zoom ${meta.zoom}. ` +
                `Try zooming out for overview charts (Ocean/Coastal) or zooming in for Harbour charts.</p>`;
            return;
        }

        if (!meta.charts_loaded) {
            details.classList.remove('hidden');
            body.innerHTML = `<p class="report-note">${meta.charts_matched} chart(s) match this area but none were drawn ` +
                `(limit: ${meta.max_charts} per request). Pan or zoom slightly and wait for reload.</p>`;
            return;
        }

        const scaleLabels = (meta.target_scale_labels || []).join(', ');
        let capNote = '';
        if (meta.features_capped) {
            capNote = ` · feature cap ${(meta.max_features || 0).toLocaleString()}`;
        }
        if (meta.skipped_layers && meta.skipped_layers.length) {
            capNote += ` · hidden at zoom: ${meta.skipped_layers.join(', ')}`;
        }
        let html = `<p class="report-note">Zoom ${meta.zoom} · scales: ${escapeHtml(scaleLabels || '—')}${escapeHtml(capNote)}</p>`;

        if (meta.charts && meta.charts.length) {
            html += `<table><thead><tr><th>Chart</th><th>Scale</th><th>Features</th></tr></thead><tbody>`;
            html += meta.charts.map(c => `<tr>
                <td>${escapeHtml(c.file)}</td>
                <td>${escapeHtml(c.scale_label || c.scale)}</td>
                <td>${(c.features || 0).toLocaleString()}</td>
            </tr>`).join('');
            html += '</tbody></table>';
        }

        if (meta.features_by_layer && meta.features_by_layer.length) {
            html += `<p style="margin-top:8px"><strong>Features by layer</strong></p>
                <table><thead><tr><th>Layer</th><th>Count</th></tr></thead><tbody>`;
            html += meta.features_by_layer.map(l => `<tr>
                <td>${escapeHtml(l.layer)}</td>
                <td>${l.features.toLocaleString()}</td>
            </tr>`).join('');
            html += '</tbody></table>';
        }

        body.innerHTML = html;
        details.classList.remove('hidden');
    }

    function updateDatasourceUI(data) {
        const pathEl = document.getElementById('datasource-path');
        const countEl = document.getElementById('datasource-count');
        if (!pathEl) return;

        if (data && data.loaded) {
            pathEl.textContent = data.path || '—';
            pathEl.title = (data.paths || []).join('\n') || data.path || '';
            const s = data.report?.summary;
            const failed = s?.indexed_failed ?? 0;
            countEl.textContent = failed > 0
                ? `${data.chart_count} indexed · ${failed} failed`
                : `${data.chart_count} chart(s)`;
            pathEl.classList.add('loaded');
        } else {
            pathEl.textContent = 'No chart data loaded';
            pathEl.title = '';
            countEl.textContent = '';
            pathEl.classList.remove('loaded');
            hideDatasourceReportLink();
        }
    }

    function fitMapToBounds(bounds, onComplete) {
        const displayBounds = pickDisplayBounds(bounds);
        if (!displayBounds || displayBounds.length !== 4) {
            if (onComplete) onComplete();
            return;
        }
        isFittingView = true;
        mapReadyForPanLoad = false;
        const extent = ol.proj.transformExtent(displayBounds, 'EPSG:4326', 'EPSG:3857');
        const view = map.getView();
        const finish = () => {
            isFittingView = false;
            if (onComplete) onComplete();
        };
        const listenerKey = map.once('moveend', () => {
            ol.Observable.unByKey(listenerKey);
            setTimeout(finish, 50);
        });
        view.fit(extent, { padding: [40, 40, 40, 40], maxZoom: 9, duration: 500 });
        if (!view.getAnimating()) {
            ol.Observable.unByKey(listenerKey);
            setTimeout(finish, 50);
        }
    }

    async function finishDatasourceDisplay(data) {
        if (datasourceDisplaySettled) {
            /* Folder replace can leave settled true from a prior session; always refresh viewport
             * data (stale cache would keep wrong/empty charts for the new datasource). */
            if (data && data.loaded) {
                viewportChartCache.clear();
                viewportOlCache.clear();
                lastViewportCacheKey = null;
                setTimeout(tryLoadCharts, 50);
            }
            return;
        }
        datasourceDisplaySettled = true;
        usingDefaultSample = isDefaultSampleLoaded(data);
        indexedChartCount = data.chart_count || 0;
        lastDatasourceBounds = data.bounds || null;
        viewportRetryDone = false;
        updateDatasourceUI(data);
        fetchAndRenderFolderReport(data.report);
        if (data.s52_settings) applyS52Settings(data.s52_settings);
        else fetchS52Settings();
        map.updateSize();

        const hadBootOnMap = bootPreviewActive
            && mapDisplayReady
            && vectorSource.getFeatures().length > 0;

        if (hadBootOnMap && usingDefaultSample) {
            showLoading(false);
            showViewportUpdating(false);
            const savedView = shouldRestoreLastView ? getSavedLastView() : null;
            shouldRestoreLastView = false;
            if (savedView) {
                animateMapTo(savedView.lon, savedView.lat, savedView.scale);
                userHasPannedMap = true;
                setTimeout(tryLoadCharts, 550);
            } else {
                setTimeout(tryLoadCharts, 50);
            }
            return;
        }

        const bootShown = await tryBootPreview();
        if (bootShown && usingDefaultSample) {
            showLoading(false);
            const savedView = shouldRestoreLastView ? getSavedLastView() : null;
            shouldRestoreLastView = false;
            if (savedView) {
                animateMapTo(savedView.lon, savedView.lat, savedView.scale);
                userHasPannedMap = true;
                setTimeout(tryLoadCharts, 550);
            } else {
                setTimeout(tryLoadCharts, 80);
            }
            return;
        }

        mapDisplayReady = false;
        bootPreviewActive = false;
        mapReadyForPanLoad = false;
        lastViewportCacheKey = null;
        viewportChartCache.clear();
        viewportOlCache.clear();
        userHasPannedMap = false;
        showLoading(true, 'subtle');
        updateProgressUI({
            message: 'Preparing chart display…',
            percent: null,
            detail: data.chart_count ? `${data.chart_count} chart(s) ready` : '',
            indeterminate: true,
        });
        const afterFit = () => {
            setTimeout(tryLoadCharts, 150);
        };
        const savedView = shouldRestoreLastView ? getSavedLastView() : null;
        shouldRestoreLastView = false;
        if (savedView) {
            animateMapTo(savedView.lon, savedView.lat, savedView.scale);
            userHasPannedMap = true;
            setTimeout(afterFit, 550);
        } else if (indexedChartCount > 0) {
            fitMapToBounds(data.bounds || KOREA_FOCUS_BOUNDS, afterFit);
        } else {
            afterFit();
        }
    }

    function onDatasourceLoaded(data) {
        invalidateChartExtentIndexCache();
        datasourceReady = true;
        pendingDatasourceResult = data;
        if (!preslibReady) {
            usingDefaultSample = isDefaultSampleLoaded(data);
            indexedChartCount = data.chart_count || 0;
            lastDatasourceBounds = data.bounds || null;
            updateDatasourceUI(data);
            fetchAndRenderFolderReport(data.report);
            if (data.s52_settings) applyS52Settings(data.s52_settings);
            if (!mapDisplayReady) {
                updateProgressUI({
                    message: 'Loading chart symbology (S-52)…',
                    percent: null,
                    detail: data.chart_count ? `${data.chart_count} chart(s) indexed` : '',
                    indeterminate: true,
                });
            }
            scheduleChartExtentGridRefresh();
            return;
        }
        pendingDatasourceResult = null;
        void finishDatasourceDisplay(data).finally(function () {
            scheduleChartExtentGridRefresh();
        });
    }

    function setDatasourceButtonsDisabled(disabled) {
        const browse = document.getElementById('btn-browse-folder');
        const folderInput = document.getElementById('folder-file-input');
        if (browse) browse.disabled = disabled;
        if (folderInput) folderInput.disabled = disabled;
    }

    function setDatasourceStatusMessage(message, options) {
        const pathEl = document.getElementById('datasource-path');
        const countEl = document.getElementById('datasource-count');
        if (!pathEl) return;
        pathEl.textContent = message;
        pathEl.title = (options && options.title) || '';
        if (countEl) countEl.textContent = (options && options.count) || '';
        pathEl.classList.toggle('loaded', !!(options && options.loaded));
    }

    function beginFolderLoadUI(message) {
        hideDatasourceReportLink();
        clearFolderLoadLog();
        invalidateChartExtentIndexCache();
        chartExtentGridSource.clear();
        chartExtentGridLayer.setVisible(false);
        viewportChartCache.clear();
        viewportOlCache.clear();
        lastViewportCacheKey = null;
        appendFolderLoadLog(message || '폴더 불러오기 시작…', 'info');
        if (isAdminMode() && window.S57AdminConsole) {
            window.S57AdminConsole.open('process');
        }
        datasourceDisplaySettled = false;
        bootPreviewActive = false;
        showLoading(true);
        setDatasourceButtonsDisabled(true);
        datasourceLoadActive = true;
        setDatasourceStatusMessage(message || 'Preparing folder load…', { loaded: false });
        updateProgressUI({
            message: message || 'Preparing folder load…',
            percent: null,
            detail: '',
            indeterminate: true,
        });
    }

    function finishFolderLoadUI() {
        datasourceLoadActive = false;
        setDatasourceButtonsDisabled(false);
    }

    async function completeDatasourceLoadFromResponse(data) {
        if (data.status === 'started') {
            const result = await waitForDatasourceLoad();
            onDatasourceLoaded(result);
            return;
        }
        if (data.loaded) {
            onDatasourceLoaded(data);
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isTransientFetchError(err) {
        if (!err) return false;
        const msg = String(err.message || err).toLowerCase();
        return (
            err.name === 'TypeError' ||
            msg.includes('failed to fetch') ||
            msg.includes('networkerror') ||
            msg.includes('load failed')
        );
    }

    async function fetchJsonWithRetry(url, options, retryOpts) {
        const maxAttempts = (retryOpts && retryOpts.maxAttempts) || 40;
        const delayMs = (retryOpts && retryOpts.delayMs) || 500;
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const resp = await fetch(url, options);
                return resp;
            } catch (err) {
                lastError = err;
                if (!isTransientFetchError(err) || attempt >= maxAttempts) {
                    throw err;
                }
                if (retryOpts && retryOpts.onRetry) {
                    retryOpts.onRetry(attempt, maxAttempts);
                }
                await sleep(delayMs);
            }
        }
        throw lastError || new Error('Failed to fetch');
    }

    /** Cold gateways (Render) often return 502/503 or truncated HTML bodies — retry a few times. */
    function isRetriableHttpStatus(status) {
        return (
            status === 408 ||
            status === 429 ||
            status === 502 ||
            status === 503 ||
            status === 504 ||
            status === 524
        );
    }

    /**
     * fetch + JSON with retries for empty/truncated bodies and transient HTTP errors.
     * @returns {{ ok: boolean, status: number, data: any }}
     */
    async function fetchJsonResilient(url, options, retryOpts) {
        const maxAttempts = (retryOpts && retryOpts.maxAttempts) || 12;
        const delayMs = (retryOpts && retryOpts.delayMs) || 380;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const resp = await fetch(url, options);
                const text = await resp.text();
                let data = null;
                if (text && text.trim()) {
                    try {
                        data = JSON.parse(text);
                    } catch (parseErr) {
                        lastErr = parseErr;
                        if (attempt < maxAttempts && (isRetriableHttpStatus(resp.status) || resp.ok)) {
                            await sleep(delayMs * Math.min(attempt, 5));
                            continue;
                        }
                        throw parseErr;
                    }
                } else if (attempt < maxAttempts) {
                    await sleep(delayMs * Math.min(attempt, 5));
                    continue;
                }
                if (!resp.ok && isRetriableHttpStatus(resp.status) && attempt < maxAttempts) {
                    await sleep(delayMs * Math.min(attempt, 5));
                    continue;
                }
                return { ok: resp.ok, status: resp.status, data };
            } catch (err) {
                lastErr = err;
                if (!isTransientFetchError(err) || attempt >= maxAttempts) {
                    throw err;
                }
                await sleep(delayMs * Math.min(attempt, 5));
            }
        }
        throw lastErr || new Error('fetchJsonResilient failed');
    }

    /** Coalesce parallel boot-time GET /api/datasource (preslib + default sample paths). */
    let datasourceResilientInflight = null;
    async function fetchDatasourceResilient() {
        if (!datasourceResilientInflight) {
            datasourceResilientInflight = fetchJsonResilient('/api/datasource', undefined, {
                maxAttempts: 14,
                delayMs: 400,
            }).finally(function () {
                datasourceResilientInflight = null;
            });
        }
        return datasourceResilientInflight;
    }

    function updateProgressUI(opts) {
        const messageEl = document.getElementById('loading-message');
        const progressEl = document.getElementById('loading-progress');
        const detailEl = document.getElementById('loading-detail');
        const indicator = document.getElementById('loading-indicator');

        if (messageEl && opts.message != null) messageEl.textContent = opts.message;
        if (detailEl) {
            detailEl.textContent = opts.detail != null ? opts.detail : '';
        }
        if (progressEl) {
            const indeterminate = !!opts.indeterminate;
            if (indicator) indicator.classList.toggle('indeterminate', indeterminate);
            if (indeterminate || opts.percent == null) {
                progressEl.removeAttribute('value');
            } else {
                progressEl.value = Math.max(0, Math.min(100, opts.percent));
            }
        }
    }

    async function waitForDatasourceLoad() {
        let reconnecting = false;
        while (true) {
            let resp;
            try {
                resp = await fetchJsonWithRetry('/api/datasource/progress', undefined, {
                    maxAttempts: 60,
                    delayMs: 500,
                    onRetry(attempt) {
                        if (!reconnecting) {
                            reconnecting = true;
                            updateProgressUI({
                                message: 'Server reconnecting — resuming chart load…',
                                percent: null,
                                detail: '',
                                indeterminate: true,
                            });
                        }
                    },
                });
            } catch (err) {
                if (isTransientFetchError(err)) {
                    const fr = await fetchJsonResilient('/api/datasource', undefined, {
                        maxAttempts: 12,
                        delayMs: 450,
                    });
                    const ds = fr.data;
                    if (fr.ok && ds && ds.loaded) return ds;
                }
                throw err;
            }

            reconnecting = false;
            let p;
            try {
                const progressText = await resp.text();
                if (!progressText || !progressText.trim()) {
                    await sleep(400);
                    continue;
                }
                p = JSON.parse(progressText);
            } catch (parseErr) {
                await sleep(400);
                continue;
            }

            let detail = '';
            if (p.total > 0 && p.phase !== 'scan') {
                detail = `${p.current} / ${p.total}`;
                if (p.percent > 0) detail += ` (${p.percent}%)`;
            }

            updateProgressUI({
                message: p.message || 'Loading chart data…',
                percent: p.total > 0 ? p.percent : null,
                detail,
                indeterminate: p.total <= 0 && p.status === 'running',
            });
            appendFolderLoadLogFromProgress(p);

            if (p.status === 'done') {
                if (!p.result) {
                    const fr = await fetchJsonResilient('/api/datasource', undefined, {
                        maxAttempts: 12,
                        delayMs: 400,
                    });
                    const ds = fr.data;
                    if (!fr.ok || !ds || !ds.loaded) {
                        throw new Error('Load finished but chart data is unavailable.');
                    }
                    return ds;
                }
                return p.result;
            }
            if (p.status === 'error') {
                appendFolderLoadLog(p.error || p.message || '차트 데이터 로드 실패', 'error');
                throw new Error(p.error || p.message || 'Failed to load chart data');
            }
            if (p.status === 'idle') {
                const fr = await fetchJsonResilient('/api/datasource', undefined, {
                    maxAttempts: 10,
                    delayMs: 400,
                });
                const ds = fr.data;
                if (fr.ok && ds && ds.loaded) return ds;
                throw new Error(
                    'Load was interrupted (the dev server may have restarted). Try Select folder again.'
                );
            }

            await sleep(300);
        }
    }

    async function uploadFolderCharts(files) {
        const chartFiles = files.filter(f => f.name && f.name.toLowerCase().endsWith('.000'));
        if (!chartFiles.length) {
            appendFolderLoadLog('선택한 폴더에 .000 파일이 없습니다.', 'warn');
            setDatasourceStatusMessage('No .000 chart files in the selected folder.');
            showLoading(false);
            finishFolderLoadUI();
            return;
        }

        beginFolderLoadUI('브라우저에서 ' + chartFiles.length + '개 .000 파일 업로드 중…');
        const form = new FormData();
        for (const file of chartFiles) {
            const rel = file.webkitRelativePath || file.name;
            form.append('files', file, rel);
        }

        try {
            const resp = await fetch('/api/datasource/upload?mode=replace', {
                method: 'POST',
                body: form,
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || 'Failed to upload chart folder');
            await completeDatasourceLoadFromResponse(data);
        } catch (e) {
            console.error(e);
            appendFolderLoadLog('폴더 업로드 실패: ' + e.message, 'error');
            alert('Could not load folder:\n' + e.message);
            setDatasourceStatusMessage('Folder upload failed');
            showLoading(false);
        } finally {
            finishFolderLoadUI();
        }
    }

    function browseFolderViaBrowser() {
        if (datasourceLoadActive) {
            setDatasourceStatusMessage('Chart data is still loading — please wait…');
            return;
        }
        const input = document.getElementById('folder-file-input');
        if (!input) {
            browseServerFolder();
            return;
        }
        setDatasourceStatusMessage('Choose a folder in the file dialog…');
        input.value = '';
        input.click();
    }

    async function onFolderInputChange(evt) {
        const input = evt.target;
        const files = input && input.files ? Array.from(input.files) : [];
        input.value = '';
        if (!files.length) {
            setDatasourceStatusMessage('Folder selection cancelled');
            return;
        }
        await uploadFolderCharts(files);
    }

    async function browseServerFolder() {
        if (datasourceLoadActive) {
            setDatasourceStatusMessage('Chart data is still loading — please wait…');
            return;
        }

        beginFolderLoadUI('Select folder in the server dialog (check the taskbar if hidden)…');

        try {
            const resp = await fetch('/api/datasource/browse?mode=replace', {
                method: 'POST',
            });
            const data = await resp.json();
            if (data.cancelled) {
                setDatasourceStatusMessage(
                    data.reason === 'no_dialog'
                        ? 'Server folder dialog unavailable — use Select folder without Shift'
                        : 'Folder selection cancelled'
                );
                showLoading(false);
                return;
            }
            if (!resp.ok) throw new Error(data.detail || 'Failed to load folder');
            await completeDatasourceLoadFromResponse(data);
        } catch (e) {
            console.error(e);
            appendFolderLoadLog('폴더 불러오기 실패: ' + e.message, 'error');
            alert('Could not load folder:\n' + e.message);
            setDatasourceStatusMessage('Could not load folder');
            showLoading(false);
        } finally {
            finishFolderLoadUI();
        }
    }

    function onBrowseFolderClick(evt) {
        if (evt.shiftKey) browseServerFolder();
        else browseFolderViaBrowser();
    }

    function normalizePath(p) {
        return String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    }

    function isDefaultSampleLoaded(data) {
        if (!data || !data.loaded || data.mode !== 'default' || !data.includes_default_sample) {
            return false;
        }
        const expected = normalizePath(data.default_sample_dir);
        const current = normalizePath(data.path);
        if (!expected || !current) return true;
        return current === expected;
    }

    async function waitForDefaultSampleReady() {
        const { ok, data } = await fetchJsonResilient('/api/datasource/default', { method: 'POST' }, {
            maxAttempts: 14,
            delayMs: 450,
        });
        if (!ok) throw new Error((data && data.detail) || 'Failed to load default sample');
        if (data.loaded) return data;
        if (data.status === 'started') return waitForDatasourceLoad();
        throw new Error('Unexpected response while loading default sample');
    }

    async function ensureDefaultSampleOnConnect() {
        datasourceLoadActive = true;
        setDatasourceButtonsDisabled(true);
        showLoading(true, 'subtle');
        try {
            const { ok, data: ds } = await fetchDatasourceResilient();
            if (!ok || !ds) {
                throw new Error('Could not read data source status from server');
            }
            const sampleLabel = ds.default_sample_dir
                ? ds.default_sample_dir.split(/[/\\]/).pop()
                : 'sample';
            updateProgressUI({
                message: 'Loading default sample charts…',
                percent: null,
                detail: sampleLabel,
                indeterminate: true,
            });

            if (isDefaultSampleLoaded(ds)) {
                onDatasourceLoaded(ds);
                return;
            }

            const progFr = await fetchJsonResilient('/api/datasource/progress', undefined, {
                maxAttempts: 10,
                delayMs: 350,
            });
            const prog = progFr.ok ? progFr.data : { status: 'idle' };

            let result;
            if (prog.status === 'running') {
                result = await waitForDatasourceLoad();
            } else {
                result = await waitForDefaultSampleReady();
            }

            if (!isDefaultSampleLoaded(result)) {
                result = await waitForDefaultSampleReady();
            }
            onDatasourceLoaded(result);
        } catch (e) {
            console.error('Default sample load failed:', e);
            showLoading(false);
            updateDatasourceUI(null);
            map.updateSize();
        } finally {
            datasourceLoadActive = false;
            setDatasourceButtonsDisabled(false);
        }
    }

    map.on('movestart', onMapMoveStart);
    map.on('moveend', onMapMoveEnd);
    map.getView().on('change:resolution', function () {
        updateInfoZoomScaleOnly();
        if (!mapViewInteracting) {
            refreshMapStylesIfNeeded();
        }
    });

    // --- UI ---

    function showLoading(show, mode) {
        const el = document.getElementById('loading-indicator');
        const container = document.getElementById('map-container');
        if (!el) return;
        const subtle = show && mode === 'subtle';
        el.classList.toggle('hidden', !show);
        el.classList.toggle('viewport-subtle', subtle);
        el.setAttribute('aria-busy', show ? 'true' : 'false');
        if (container) {
            container.classList.toggle('map-loading', show && !subtle);
            if (show) container.classList.remove('map-updating');
        }
    }

    function showViewportUpdating(show) {
        const container = document.getElementById('map-container');
        if (!container) return;
        container.classList.toggle('map-updating', show);
    }

    function setLoadingMessage(text) {
        updateProgressUI({ message: text });
    }

    function updateInfo(charts, features) {
        document.getElementById('info-charts').textContent = charts;
        document.getElementById('info-features').textContent = features.toLocaleString();
        const zoom = getZoomLevel();
        document.getElementById('info-zoom').textContent = zoom;
        const scales = {
            4: '1:50,000,000', 5: '1:25,000,000', 6: '1:10,000,000',
            7: '1:5,000,000', 8: '1:3,500,000', 9: '1:700,000',
            10: '1:350,000', 11: '1:180,000', 12: '1:90,000',
            13: '1:45,000', 14: '1:22,000', 15: '1:12,000',
            16: '1:6,000', 17: '1:3,000', 18: '1:1,500',
        };
        document.getElementById('info-scale').textContent = scales[zoom] || '~1:' + Math.round(559082264 / Math.pow(2, zoom)).toLocaleString();
    }

    // Display options
    document.querySelectorAll('#display-options input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', function () {
            const cat = this.dataset.category;
            if (cat === 'all') {
                const checked = this.checked;
                document.querySelectorAll('#display-options input[type="checkbox"]').forEach(c => {
                    c.checked = checked;
                    const cc = c.dataset.category;
                    if (cc !== 'all') {
                        if (checked) enabledCategories.add(cc);
                        else enabledCategories.delete(cc);
                    }
                });
            } else {
                if (this.checked) enabledCategories.add(cat);
                else enabledCategories.delete(cat);

                const allCb = document.querySelector('input[data-category="all"]');
                const allChecked = document.querySelectorAll('#display-options input[data-category]:not([data-category="all"])');
                const allAreChecked = Array.from(allChecked).every(c => c.checked);
                allCb.checked = allAreChecked;
            }
            if (preslibReady) s52.clearStyleCache();
            lastStyleResolutionBucket = null;
            vectorLayer.changed();
            lastViewportCacheKey = null;
            scheduleViewportLoad();
            hideFeaturePopup();
        });
    });

    // S-57 toggle
    document.getElementById('toggle-s57').addEventListener('change', function () {
        vectorLayer.setVisible(this.checked);
    });

    document.getElementById('toggle-chart-extent-grid')?.addEventListener('change', function () {
        if (this.checked) {
            void rebuildChartExtentGrid();
        } else {
            chartExtentGridBuildSeq++;
            chartExtentGridSource.clear();
            chartExtentGridLayer.setVisible(false);
        }
    });

    // Feature popup on double-click (Display Option enabled layers only; topmost drawn feature wins)
    map.on('dblclick', function (evt) {
        const resolution = map.getView().getResolution();
        const hits = map.getFeaturesAtPixel(evt.pixel, { hitTolerance: 5 }) || [];
        const inspectable = hits
            .filter(f => isFeatureInspectable(f, resolution))
            .sort((a, b) => (LAYER_ORDER[b.get('layer')] || 50) - (LAYER_ORDER[a.get('layer')] || 50));
        if (inspectable.length > 0) {
            evt.preventDefault();
            showFeaturePopup(inspectable[0]);
        } else {
            hideFeaturePopup();
        }
    });

    function showFeaturePopup(feature) {
        const popup = document.getElementById('feature-popup');
        const title = document.getElementById('popup-title');
        const content = document.getElementById('popup-content');

        const layer = feature.get('layer');
        const props = feature.getProperties();
        delete props.geometry;

        const displayName = props.NOBJNM || props.OBJNAM;
        title.textContent = layer + (displayName ? ' - ' + displayName : '');

        let html = '<table>';
        for (const [key, val] of Object.entries(props)) {
            if (val != null && val !== '' && key !== 'geometry') {
                let displayVal = val;
                if (key === 'layer') displayVal = getLayerDescription(val);
                html += `<tr><td>${key}</td><td>${displayVal}</td></tr>`;
            }
        }
        html += '</table>';
        content.innerHTML = html;
        popup.classList.remove('hidden');
    }

    function hideFeaturePopup() {
        document.getElementById('feature-popup').classList.add('hidden');
    }

    document.getElementById('popup-close').addEventListener('click', hideFeaturePopup);

    function getLayerDescription(code) {
        const descriptions = {
            'DEPARE': 'Depth Area', 'DEPCNT': 'Depth Contour', 'SOUNDG': 'Sounding',
            'LNDARE': 'Land Area', 'COALNE': 'Coastline', 'SLCONS': 'Shoreline Construction',
            'LIGHTS': 'Light', 'FOGSIG': 'Fog Signal',
            'BOYISD': 'Buoy (Isolated)', 'BOYLAT': 'Buoy (Lateral)', 'BOYSAW': 'Buoy (Safe Water)', 'BOYSPP': 'Buoy (Special)',
            'BCNCAR': 'Beacon (Cardinal)', 'BCNISD': 'Beacon (Isolated)', 'BCNLAT': 'Beacon (Lateral)',
            'OBSTRN': 'Obstruction', 'UWTROC': 'Underwater Rock', 'WRECKS': 'Wreck',
            'LNDMRK': 'Landmark', 'LNDELV': 'Land Elevation', 'LNDRGN': 'Land Region',
            'BRIDGE': 'Bridge', 'FERYRT': 'Ferry Route', 'RDOSTA': 'Radio Station',
            'PILPNT': 'Pile', 'TOPMAR': 'Top Mark', 'RTPBCN': 'Radar Transponder',
            'CBLOHD': 'Overhead Cable', 'CBLSUB': 'Submarine Cable', 'PIPSOL': 'Pipeline',
            'ACHBRT': 'Anchorage Berth', 'ACHARE': 'Anchorage Area',
            'RESARE': 'Restricted Area', 'TSSBND': 'TSS Boundary', 'TSELNE': 'TSS Lane',
            'TSSLPT': 'TSS Lane Part', 'TSSRON': 'TSS Roundabout', 'ISTZNE': 'Inshore Traffic Zone',
            'FAIRWY': 'Fairway', 'DWRTPT': 'Deep Water Route', 'TWRTPT': 'Two-Way Route',
            'SEAARE': 'Sea Area', 'LAKARE': 'Lake', 'MORFAC': 'Mooring Facility', 'DRGARE': 'Dredged Area',
            'M_COVR': 'Coverage', 'M_QUAL': 'Quality',
        };
        return code + ' (' + (descriptions[code] || 'Unknown') + ')';
    }

    // --- Scale / zoom helpers (shared by scale bar and view bookmarks) ---

    const SCALE_TO_ZOOM = {
        50000000: 4, 10000000: 6, 3500000: 8,
        700000: 9, 180000: 11, 111000: 12, 90000: 12,
        22000: 14, 12000: 15,
    };
    const ZOOM_TO_SCALE_DENOM = {
        4: 50000000, 5: 25000000, 6: 10000000,
        7: 5000000, 8: 3500000, 9: 700000,
        10: 350000, 11: 180000, 12: 90000,
        13: 45000, 14: 22000, 15: 12000,
        16: 6000, 17: 3000, 18: 1500,
    };
    const SCALE_SELECT_VALUES = Object.keys(SCALE_TO_ZOOM).map(Number);

    function scaleDenomToZoom(scaleDenom) {
        const exact = SCALE_TO_ZOOM[scaleDenom];
        if (exact != null) return exact;
        let bestZoom = 6;
        let bestDiff = Infinity;
        for (const [z, denom] of Object.entries(ZOOM_TO_SCALE_DENOM)) {
            const diff = Math.abs(denom - scaleDenom);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestZoom = Number(z);
            }
        }
        return bestZoom;
    }

    function scaleToZoom(scaleDenom) {
        return scaleDenomToZoom(scaleDenom);
    }

    function zoomToNearestScaleDenom(zoom) {
        const exact = ZOOM_TO_SCALE_DENOM[zoom];
        if (exact) return exact;
        let best = SCALE_SELECT_VALUES[0];
        let bestDiff = Infinity;
        for (const denom of SCALE_SELECT_VALUES) {
            const z = scaleToZoom(denom);
            const diff = Math.abs(z - zoom);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = denom;
            }
        }
        return best;
    }

    function syncScaleSelect(scaleDenom) {
        const sel = document.getElementById('scale-select');
        if (!sel) return;
        const val = String(scaleDenom);
        if (sel.querySelector(`option[value="${val}"]`)) {
            sel.value = val;
        }
    }

    function animateMapTo(lon, lat, scaleDenom) {
        const zoom = scaleToZoom(scaleDenom);
        map.getView().animate({
            center: ol.proj.fromLonLat([lon, lat]),
            zoom,
            duration: 500,
        });
        syncScaleSelect(scaleDenom);
        if (mapDisplayReady) userHasPannedMap = true;
        saveLastViewToStorage();
    }

    // Scale select
    document.getElementById('scale-select').addEventListener('change', function () {
        const scale = parseInt(this.value, 10);
        map.getView().animate({ zoom: scaleToZoom(scale), duration: 500 });
    });

    // --- View bookmarks (keys 1–9, Ctrl+1–9 to save) ---

    const VIEW_BOOKMARKS_STORAGE_KEY = 's57viewer-view-bookmarks';
    const VIEW_BOOKMARKS_SECTION_OPEN_KEY = 's57viewer-bookmarks-section-open';
    const LAST_VIEW_STORAGE_KEY = 's57viewer-last-view';
    let lastViewSaveTimer = null;

    const DEFAULT_VIEW_BOOKMARKS = [
        { label: 'Korea overview', lon: 127.5, lat: 36.0, scale: 10000000 },
        { label: 'Seoul', lon: 126.98, lat: 37.55, scale: 3500000 },
        { label: 'Busan', lon: 129.04, lat: 35.10, scale: 700000 },
        { label: 'Incheon', lon: 126.62, lat: 37.45, scale: 700000 },
        { label: 'Jeju', lon: 126.53, lat: 33.38, scale: 700000 },
        { label: 'East coast', lon: 129.5, lat: 37.5, scale: 3500000 },
        { label: 'West coast', lon: 125.5, lat: 36.0, scale: 3500000 },
        { label: 'Jindo (1:111k)', lon: 126.12, lat: 34.51, scale: 111000 },
        { label: 'Harbour detail', lon: 126.60, lat: 37.45, scale: 22000 },
    ];

    let viewBookmarks = [];
    let bookmarkToastTimer = null;

    function cloneDefaultBookmarks() {
        return DEFAULT_VIEW_BOOKMARKS.map(function (b) {
            return { label: b.label, lon: b.lon, lat: b.lat, scale: b.scale };
        });
    }

    function normalizeBookmark(raw, fallback) {
        const lon = Number(raw && raw.lon);
        const lat = Number(raw && raw.lat);
        let scale = parseInt(raw && raw.scale, 10);
        if (!Number.isFinite(scale) || scale <= 0) {
            scale = fallback ? fallback.scale : 10000000;
        }
        return {
            label: (raw && raw.label) || (fallback && fallback.label) || '',
            lon: Number.isFinite(lon) ? lon : fallback.lon,
            lat: Number.isFinite(lat) ? lat : fallback.lat,
            scale,
        };
    }

    function loadViewBookmarks() {
        const defaults = cloneDefaultBookmarks();
        try {
            const raw = localStorage.getItem(VIEW_BOOKMARKS_STORAGE_KEY);
            if (!raw) return defaults;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed) || parsed.length === 0) return defaults;
            const result = defaults.slice();
            for (let i = 0; i < 9 && i < parsed.length; i++) {
                result[i] = normalizeBookmark(parsed[i], defaults[i]);
            }
            return result;
        } catch (e) {
            return defaults;
        }
    }

    function saveViewBookmarksToStorage() {
        try {
            localStorage.setItem(VIEW_BOOKMARKS_STORAGE_KEY, JSON.stringify(viewBookmarks));
        } catch (e) {
            console.warn('Could not save view bookmarks:', e);
        }
    }

    function getSavedLastView() {
        try {
            const raw = localStorage.getItem(LAST_VIEW_STORAGE_KEY);
            if (!raw) return null;
            const v = JSON.parse(raw);
            const lon = Number(v.lon);
            const lat = Number(v.lat);
            const scale = parseInt(v.scale, 10);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
            if (!Number.isFinite(scale) || scale <= 0) return null;
            return { lon, lat, scale };
        } catch (e) {
            return null;
        }
    }

    function saveLastViewToStorage() {
        try {
            const coord = ol.proj.toLonLat(map.getView().getCenter());
            const scale = zoomToNearestScaleDenom(getZoomLevel());
            localStorage.setItem(LAST_VIEW_STORAGE_KEY, JSON.stringify({
                lon: coord[0],
                lat: coord[1],
                scale,
            }));
        } catch (e) {
            console.warn('Could not save last view:', e);
        }
    }

    function scheduleSaveLastView() {
        if (isFittingView) return;
        if (!userHasPannedMap && !mapDisplayReady) return;
        if (lastViewSaveTimer) clearTimeout(lastViewSaveTimer);
        lastViewSaveTimer = setTimeout(saveLastViewToStorage, 400);
    }

    function formatScaleLabel(scaleDenom) {
        const labels = {
            50000000: '1:50M', 10000000: '1:10M', 3500000: '1:3.5M',
            700000: '1:700k', 180000: '1:180k', 111000: '1:111k', 90000: '1:90k',
            22000: '1:22k', 12000: '1:12k',
        };
        return labels[scaleDenom] || ('1:' + scaleDenom.toLocaleString());
    }

    function showBookmarkToast(message) {
        const el = document.getElementById('bookmark-toast');
        if (!el) return;
        el.textContent = message;
        el.classList.add('is-visible');
        if (bookmarkToastTimer) clearTimeout(bookmarkToastTimer);
        bookmarkToastTimer = setTimeout(function () {
            el.classList.remove('is-visible');
        }, 2200);
    }

    function bookmarkSlotTitle(slot) {
        const bm = viewBookmarks[slot - 1];
        if (!bm) return `Slot ${slot}: click to save current view`;
        const ns = bm.lat >= 0 ? 'N' : 'S';
        const ew = bm.lon >= 0 ? 'E' : 'W';
        const pos = Math.abs(bm.lat).toFixed(2) + '°' + ns + ', ' +
            Math.abs(bm.lon).toFixed(2) + '°' + ew;
        return `Slot ${slot}: ${formatScaleLabel(bm.scale)} @ ${pos}\nClick: save · Key ${slot}: go`;
    }

    function captureBookmarkFromMap(slot) {
        const coord = ol.proj.toLonLat(map.getView().getCenter());
        const scale = zoomToNearestScaleDenom(getZoomLevel());
        const bm = viewBookmarks[slot - 1] || {};
        viewBookmarks[slot - 1] = {
            label: bm.label || `Bookmark ${slot}`,
            lon: coord[0],
            lat: coord[1],
            scale,
        };
        saveViewBookmarksToStorage();
        renderViewBookmarksUI();
        showBookmarkToast(`${slot} saved · ${formatScaleLabel(scale)}`);
        return viewBookmarks[slot - 1];
    }

    function goToViewBookmark(slot) {
        const bm = viewBookmarks[slot - 1];
        if (!bm || !Number.isFinite(bm.lon) || !Number.isFinite(bm.lat)) return;
        animateMapTo(bm.lon, bm.lat, bm.scale);
    }

    function renderViewBookmarksUI() {
        const list = document.getElementById('view-bookmarks-list');
        if (!list) return;
        let html = '';
        for (let slot = 1; slot <= 9; slot++) {
            html += `<button type="button" class="bookmark-slot is-saved" data-slot="${slot}" title="${escapeHtml(bookmarkSlotTitle(slot))}">${slot}</button>`;
        }
        list.innerHTML = html;

        list.querySelectorAll('.bookmark-slot').forEach(function (btn) {
            btn.addEventListener('click', function () {
                captureBookmarkFromMap(Number(btn.dataset.slot));
            });
            btn.addEventListener('dblclick', function (evt) {
                evt.preventDefault();
                goToViewBookmark(Number(btn.dataset.slot));
            });
        });
    }

    function isTypingTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    const KEYBOARD_PAN_PIXELS = 96;
    const KEYBOARD_ZOOM_STEP = 1;

    function panMapByKeyboardPixels(pixelX, pixelY) {
        const view = map.getView();
        const resolution = view.getResolution();
        const center = view.getCenter();
        if (!resolution || !center) return;
        view.animate({
            center: [
                center[0] + pixelX * resolution,
                center[1] + pixelY * resolution,
            ],
            duration: 100,
        });
    }

    function zoomMapByKeyboard(delta) {
        const view = map.getView();
        const current = view.getZoom();
        if (current === undefined) return;
        const min = view.getMinZoom() ?? 0;
        const max = view.getMaxZoom() ?? 28;
        const next = Math.min(max, Math.max(min, current + delta));
        if (next === current) return;
        view.animate({ zoom: next, duration: 150 });
    }

    function attachMapKeyboardControls() {
        document.addEventListener('keydown', function (evt) {
            if (isTypingTarget(evt.target)) return;
            if (evt.ctrlKey || evt.metaKey || evt.altKey) return;

            const key = evt.key;
            let pixelX = 0;
            let pixelY = 0;
            if (key === 'ArrowLeft') pixelX = KEYBOARD_PAN_PIXELS;
            else if (key === 'ArrowRight') pixelX = -KEYBOARD_PAN_PIXELS;
            else if (key === 'ArrowUp') pixelY = KEYBOARD_PAN_PIXELS;
            else if (key === 'ArrowDown') pixelY = -KEYBOARD_PAN_PIXELS;

            if (pixelX !== 0 || pixelY !== 0) {
                evt.preventDefault();
                panMapByKeyboardPixels(pixelX, pixelY);
                return;
            }

            let zoomDelta = 0;
            if (key === '+' || key === '=' || key === 'Add') zoomDelta = KEYBOARD_ZOOM_STEP;
            else if (key === '-' || key === '_' || key === 'Subtract') zoomDelta = -KEYBOARD_ZOOM_STEP;

            if (zoomDelta !== 0) {
                evt.preventDefault();
                zoomMapByKeyboard(zoomDelta);
            }
        });
    }

    function isAdminMode() {
        return document.documentElement.classList.contains('admin-mode');
    }

    function attachViewBookmarkKeyboard() {
        document.addEventListener('keydown', function (evt) {
            if (!isAdminMode()) return;
            if (isTypingTarget(evt.target)) return;
            const key = evt.key;
            if (key.length !== 1 || key < '1' || key > '9') return;
            const slot = Number(key);
            if (evt.ctrlKey || evt.metaKey) {
                evt.preventDefault();
                captureBookmarkFromMap(slot);
                return;
            }
            if (evt.altKey || evt.shiftKey) return;
            evt.preventDefault();
            goToViewBookmark(slot);
        });
    }

    viewBookmarks = loadViewBookmarks();
    renderViewBookmarksUI();
    attachMapKeyboardControls();
    attachViewBookmarkKeyboard();

    (function initBookmarksSectionCollapsible() {
        const details = document.getElementById('view-bookmarks-details');
        if (!details) return;
        try {
            const stored = localStorage.getItem(VIEW_BOOKMARKS_SECTION_OPEN_KEY);
            if (stored === '0') details.open = false;
            else if (stored === '1') details.open = true;
        } catch (e) { /* ignore */ }
        details.addEventListener('toggle', function () {
            try {
                localStorage.setItem(VIEW_BOOKMARKS_SECTION_OPEN_KEY, details.open ? '1' : '0');
            } catch (e) { /* ignore */ }
        });
    })();

    map.getView().on('change:center', scheduleSaveLastView);
    map.getView().on('change:resolution', scheduleSaveLastView);
    window.addEventListener('beforeunload', saveLastViewToStorage);

    document.getElementById('btn-reset-bookmarks')?.addEventListener('click', function () {
        if (!confirm('Reset all 9 view bookmarks to defaults?')) return;
        viewBookmarks = cloneDefaultBookmarks();
        saveViewBookmarksToStorage();
        renderViewBookmarksUI();
    });

    function applyS52Settings(settings) {
        if (!settings || !preslibReady) return;
        const patch = {};
        if (settings.shallowContour != null) patch.shallowContour = settings.shallowContour;
        if (settings.safetyContour != null) patch.safetyContour = settings.safetyContour;
        if (settings.deepContour != null) patch.deepContour = settings.deepContour;
        if (settings.safetyDepth != null) patch.safetyDepth = settings.safetyDepth;
        if (Object.keys(patch).length) {
            s52.setSettings(patch);
            vectorLayer.changed();
        }
    }

    async function fetchS52Settings() {
        const sources = ['/s52-settings.json', '/api/datasource'];
        for (const url of sources) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const data = await resp.json();
                const settings = data.s52_settings || data;
                if (settings.shallowContour != null || settings.safetyContour != null) {
                    applyS52Settings(settings);
                    return;
                }
            } catch (e) {
                /* try next source */
            }
        }
    }

    async function initPreslib() {
        prefetchBootViewport();
        if (!mapDisplayReady && !datasourceReady) {
            updateProgressUI({
                message: 'Loading chart symbology (S-52)…',
                percent: null,
                detail: '',
                indeterminate: true,
            });
        }
        try {
            await s52.load('/s52-preslib.json?v=10');
            preslibReady = true;
            applyFullDisplayPreset();
            attachPresLibControls();
            syncViewScaleDenom();
            const sea = s52.getSeaColor();
            document.getElementById('map').style.backgroundColor = sea;
            vectorLayer.changed();

            const bootShown = await tryBootPreview();
            if (bootShown) showLoading(false);

            if (pendingDatasourceResult) {
                const pending = pendingDatasourceResult;
                pendingDatasourceResult = null;
                await finishDatasourceDisplay(pending);
            } else if (datasourceReady && !datasourceDisplaySettled) {
                const fr = await fetchDatasourceResilient().catch(function () { return null; });
                const ds = fr && fr.ok ? fr.data : null;
                if (ds) await finishDatasourceDisplay(ds);
            } else if (datasourceReady && datasourceDisplaySettled && bootPreviewActive && mapDisplayReady) {
                setTimeout(tryLoadCharts, 50);
            } else if (!bootShown) {
                showLoading(true, mapDisplayReady ? 'subtle' : undefined);
                updateProgressUI({
                    message: 'Loading demo charts…',
                    percent: null,
                    detail: '',
                    indeterminate: true,
                });
            }
        } catch (e) {
            console.error('S-52 PresLib load failed:', e);
            document.getElementById('map').style.backgroundColor = '#9fc5e8';
            preslibReady = true;
            vectorLayer.changed();
            const bootShown = await tryBootPreview();
            if (bootShown) showLoading(false);
            if (pendingDatasourceResult) {
                const pending = pendingDatasourceResult;
                pendingDatasourceResult = null;
                await finishDatasourceDisplay(pending);
            } else if (datasourceReady && !datasourceDisplaySettled) {
                const fr = await fetchDatasourceResilient().catch(function () { return null; });
                const ds = fr && fr.ok ? fr.data : null;
                if (ds) await finishDatasourceDisplay(ds);
            } else if (datasourceReady) {
                tryLoadCharts();
            }
        }
    }

    function refreshAfterPresLibChange() {
        if (!preslibReady) return;
        syncViewScaleDenom();
        document.getElementById('map').style.backgroundColor = s52.getSeaColor();
        lastViewportCacheKey = null;
        lastStyleResolutionBucket = null;
        viewportOlCache.clear();
        vectorLayer.changed();
    }

    function attachPresLibControls() {
        const paletteSel = document.getElementById('palette-select');
        if (paletteSel) {
            paletteSel.addEventListener('change', () => {
                s52.setPalette(paletteSel.value);
                refreshAfterPresLibChange();
            });
        }
        const dispSel = document.getElementById('display-category-select');
        if (dispSel) {
            dispSel.addEventListener('change', () => {
                s52.setDisplayCategory(dispSel.value);
                refreshAfterPresLibChange();
            });
        }
        const scaminToggle = document.getElementById('toggle-scamin');
        if (scaminToggle) {
            scaminToggle.addEventListener('change', () => {
                s52.setSettings({ respectScamin: scaminToggle.checked });
                lastViewportCacheKey = null;
                refreshAfterPresLibChange();
                scheduleViewportLoad();
            });
            s52.setSettings({ respectScamin: scaminToggle.checked });
        }
        const twoShades = document.getElementById('toggle-two-shades');
        if (twoShades) {
            twoShades.addEventListener('change', () => {
                s52.setSettings({ twoShades: twoShades.checked });
                refreshAfterPresLibChange();
            });
        }
        const showSnd = document.getElementById('toggle-soundings');
        if (showSnd) {
            showSnd.addEventListener('change', () => {
                s52.setSettings({ showSoundings: showSnd.checked });
                refreshAfterPresLibChange();
            });
        }
        const showText = document.getElementById('toggle-show-text');
        if (showText) {
            showText.addEventListener('change', () => {
                s52.setSettings({ showText: showText.checked });
                refreshAfterPresLibChange();
            });
        }
        const lightDesc = document.getElementById('toggle-light-desc');
        if (lightDesc) {
            lightDesc.addEventListener('change', () => {
                s52.setSettings({ showLightDescriptions: lightDesc.checked });
                refreshAfterPresLibChange();
            });
        }
        const visibleSectors = document.getElementById('toggle-visible-sectors');
        if (visibleSectors) {
            visibleSectors.addEventListener('change', () => {
                s52.setSettings({ showVisibleSectorLights: visibleSectors.checked });
                refreshAfterPresLibChange();
            });
            s52.setSettings({ showVisibleSectorLights: visibleSectors.checked });
        }
        const buoyLabels = document.getElementById('toggle-buoy-labels');
        if (buoyLabels) {
            buoyLabels.addEventListener('change', () => {
                s52.setSettings({ showBuoyLightLabels: buoyLabels.checked });
                refreshAfterPresLibChange();
            });
        }
        if (showSnd) s52.setSettings({ showSoundings: showSnd.checked });
        if (showText) s52.setSettings({ showText: showText.checked });
        if (lightDesc) s52.setSettings({ showLightDescriptions: lightDesc.checked });
        if (buoyLabels) s52.setSettings({ showBuoyLightLabels: buoyLabels.checked });
        if (dispSel) s52.setDisplayCategory(dispSel.value);
    }

    document.getElementById('btn-browse-folder')?.addEventListener('click', onBrowseFolderClick);
    document.getElementById('folder-file-input')?.addEventListener('change', onFolderInputChange);

    const SIDEBAR_VISIBLE_KEY = 's57viewer-sidebar-visible';
    const SIDEBAR_WIDTH_KEY = 's57viewer-sidebar-width';
    const SIDEBAR_WIDTH_DEFAULT = 420;
    const SIDEBAR_WIDTH_MIN = 260;

    function getSidebarWidthMax() {
        return Math.min(900, Math.floor(window.innerWidth * 0.65));
    }

    function clampSidebarWidth(px) {
        return Math.max(SIDEBAR_WIDTH_MIN, Math.min(getSidebarWidthMax(), Math.round(px)));
    }

    function setSidebarVisible(visible) {
        const main = document.getElementById('main-container');
        const toggle = document.getElementById('sidebar-toggle');
        if (!main) return;
        main.classList.toggle('sidebar-hidden', !visible);
        if (toggle) toggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
        try {
            localStorage.setItem(SIDEBAR_VISIBLE_KEY, visible ? '1' : '0');
        } catch (e) { /* ignore */ }
        requestAnimationFrame(function () {
            map.updateSize();
        });
    }

    (function initSidebar() {
        const main = document.getElementById('main-container');
        const toggle = document.getElementById('sidebar-toggle');
        const showBtn = document.getElementById('sidebar-show-btn');
        const resizeHandle = document.getElementById('sidebar-resize-handle');
        if (!main) return;

        let currentSidebarWidth = SIDEBAR_WIDTH_DEFAULT;
        try {
            const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
            if (Number.isFinite(stored) && stored > 0) currentSidebarWidth = stored;
        } catch (e) { /* ignore */ }

        function applySidebarWidth(px, persist) {
            currentSidebarWidth = clampSidebarWidth(px);
            main.style.setProperty('--sidebar-width', currentSidebarWidth + 'px');
            if (persist) {
                try {
                    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentSidebarWidth));
                } catch (e) { /* ignore */ }
            }
            return currentSidebarWidth;
        }

        applySidebarWidth(currentSidebarWidth, false);

        let resizeRaf = 0;
        function scheduleMapResize() {
            if (resizeRaf) return;
            resizeRaf = requestAnimationFrame(function () {
                resizeRaf = 0;
                map.updateSize();
            });
        }

        let dragging = false;
        let dragStartX = 0;
        let dragStartWidth = 0;

        function endSidebarResize(persist) {
            if (!dragging) return;
            dragging = false;
            main.classList.remove('sidebar-resizing');
            document.body.classList.remove('sidebar-resize-active');
            if (persist) applySidebarWidth(currentSidebarWidth, true);
            scheduleMapResize();
        }

        resizeHandle?.addEventListener('pointerdown', function (e) {
            if (main.classList.contains('sidebar-hidden')) return;
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            dragStartX = e.clientX;
            dragStartWidth = currentSidebarWidth;
            main.classList.add('sidebar-resizing');
            document.body.classList.add('sidebar-resize-active');
            resizeHandle.setPointerCapture(e.pointerId);
        });

        resizeHandle?.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            applySidebarWidth(dragStartWidth + (e.clientX - dragStartX), false);
            scheduleMapResize();
        });

        resizeHandle?.addEventListener('pointerup', function () {
            endSidebarResize(true);
        });

        resizeHandle?.addEventListener('pointercancel', function () {
            endSidebarResize(false);
        });

        resizeHandle?.addEventListener('keydown', function (e) {
            if (main.classList.contains('sidebar-hidden')) return;
            let delta = 0;
            if (e.key === 'ArrowLeft') delta = -16;
            else if (e.key === 'ArrowRight') delta = 16;
            else return;
            e.preventDefault();
            applySidebarWidth(currentSidebarWidth + delta, true);
            scheduleMapResize();
        });

        window.addEventListener('resize', function () {
            applySidebarWidth(currentSidebarWidth, true);
        });

        let visible = true;
        try {
            const stored = localStorage.getItem(SIDEBAR_VISIBLE_KEY);
            if (stored === '0') visible = false;
        } catch (e) { /* ignore */ }
        setSidebarVisible(visible);
        toggle?.addEventListener('click', function () {
            const isHidden = main.classList.contains('sidebar-hidden');
            setSidebarVisible(isHidden);
        });
        showBtn?.addEventListener('click', function () {
            setSidebarVisible(true);
        });
    })();

    function loadVisitorStats() {
        fetch('/api/visitors')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data) return;
                const todayEl = document.getElementById('visitor-today');
                const totalEl = document.getElementById('visitor-total');
                if (todayEl) todayEl.textContent = String(data.today ?? '—');
                if (totalEl) totalEl.textContent = String(data.total ?? '—');
            })
            .catch(function () {});
    }

    map.updateSize();
    window.addEventListener('resize', () => map.updateSize());
    document.addEventListener('admin-console-resize', () => map.updateSize());

    document.addEventListener('admin-console-clear-process', clearFolderLoadLog);
    document.addEventListener('admin-console-ready', notifyAdminConsoleProcessLog);

    document.getElementById('about-open-console')?.addEventListener('click', function (evt) {
        evt.preventDefault();
        if (window.S57AdminConsole) window.S57AdminConsole.open('server');
    });

    isFittingView = true;
    map.getView().fit(
        ol.proj.transformExtent(KOREA_FOCUS_BOUNDS, 'EPSG:4326', 'EPSG:3857'),
        { padding: [40, 40, 40, 40], maxZoom: 9, duration: 0 }
    );
    isFittingView = false;

    prefetchBootViewport();
    showLoading(true, 'subtle');
    updateProgressUI({
        message: 'Loading charts…',
        percent: null,
        detail: '',
        indeterminate: true,
    });

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('/sw.js?v=10').catch(function (err) {
            console.warn('Service worker registration failed:', err);
        });
    }

    initDisplayOptionCheckboxes();
    document.getElementById('btn-clean-display')?.addEventListener('click', applyCleanDisplayPreset);
    initPreslib();
    ensureDefaultSampleOnConnect();
    loadVisitorStats();
    registerServiceWorker();

})();
