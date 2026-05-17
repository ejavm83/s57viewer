(function () {
    'use strict';

    const CATEGORIES = {
        depth: ['DEPARE', 'DEPCNT', 'SBDARE'],
        sounding: ['SOUNDG'],
        light: ['LIGHTS', 'FOGSIG'],
        beacon: ['BCNCAR', 'BCNISD', 'BCNLAT', 'RTPBCN'],
        buoy: ['BOYISD', 'BOYLAT', 'BOYSAW', 'BOYSPP'],
        obstruction: ['OBSTRN', 'UWTROC'],
        wreck: ['WRECKS'],
        land: ['LNDARE', 'LNDMRK', 'LNDELV', 'LNDRGN', 'LAKARE'],
        coastline: ['COALNE', 'SLCONS'],
        navigation: ['DWRTPT', 'TWRTPT', 'FERYRT', 'RDOCAL', 'RDOSTA', 'ACHBRT', 'CTRPNT'],
        infrastructure: ['BRIDGE', 'CBLOHD', 'CBLSUB', 'PIPSOL', 'MORFAC', 'DAMCON', 'PONTON', 'PYLONS'],
        coverage: ['M_COVR', 'M_QUAL'],
    };

    const enabledCategories = new Set(Object.keys(CATEGORIES));
    let currentFeatures = null;
    let loadingAbort = null;
    let loadDebounce = null;
    let preslibReady = false;

    function isLayerVisible(layerName) {
        for (const [cat, layers] of Object.entries(CATEGORIES)) {
            if (layers.includes(layerName)) {
                return enabledCategories.has(cat);
            }
        }
        return true;
    }

    function styleFunction(feature, resolution) {
        const layer = feature.get('layer');
        if (!isLayerVisible(layer)) return null;

        if (layer === 'SOUNDG' && resolution > 200) return null;
        if (layer === 'M_COVR') return null;
        if (layer === 'M_QUAL') return null;
        if ((layer === 'LNDMRK' || layer === 'TOPMAR' || layer === 'PILPNT') && resolution > 1000) return null;
        if (layer === 'DEPCNT' && resolution > 600) return null;
        if ((layer === 'OBSTRN' || layer === 'UWTROC' || layer === 'WRECKS')
            && feature.getGeometry().getType() === 'Point' && resolution > 800) return null;

        if (!preslibReady) return null;
        return s52.getStyle(feature, resolution);
    }

    // --- Z-index ordering for layers ---
    const LAYER_ORDER = {
        'UNSARE': 0, 'M_COVR': 1, 'M_QUAL': 1,
        'SEAARE': 2, 'DEPARE': 3, 'SBDARE': 3,
        'LAKARE': 4, 'LNDARE': 5,
        'DEPCNT': 10, 'COALNE': 11, 'SLCONS': 12,
        'ACHBRT': 13, 'DWRTPT': 14, 'TWRTPT': 14,
        'FERYRT': 15, 'CBLOHD': 16, 'CBLSUB': 16, 'PIPSOL': 17,
        'BRIDGE': 18, 'DAMCON': 19, 'PONTON': 19, 'MORFAC': 19,
        'OBSTRN': 20, 'UWTROC': 21, 'WRECKS': 22,
        'SOUNDG': 25,
        'BOYISD': 30, 'BOYLAT': 30, 'BOYSAW': 30, 'BOYSPP': 30,
        'BCNCAR': 31, 'BCNISD': 31, 'BCNLAT': 31,
        'TOPMAR': 32, 'PILPNT': 33,
        'LNDMRK': 34,
        'LIGHTS': 40, 'FOGSIG': 41,
        'RTPBCN': 35, 'RDOSTA': 36, 'CTRPNT': 37,
        'RDOCAL': 38,
    };

    // --- Map setup ---

    const vectorSource = new ol.source.Vector();

    const vectorLayer = new ol.layer.Vector({
        source: vectorSource,
        style: styleFunction,
        declutter: false,
        renderOrder: function (a, b) {
            const orderA = LAYER_ORDER[a.get('layer')] || 50;
            const orderB = LAYER_ORDER[b.get('layer')] || 50;
            return orderA - orderB;
        },
    });

    const map = new ol.Map({
        target: 'map',
        layers: [vectorLayer],
        view: new ol.View({
            center: ol.proj.fromLonLat([127.5, 36.0]),
            zoom: 6,
            minZoom: 4,
            maxZoom: 18,
        }),
        controls: ol.control.defaults.defaults().extend([
            new ol.control.ScaleLine(),
        ]),
    });

    // Mouse position display
    map.on('pointermove', function (evt) {
        const coord = ol.proj.toLonLat(evt.coordinate);
        const lon = coord[0].toFixed(6);
        const lat = coord[1].toFixed(6);
        const ns = coord[1] >= 0 ? 'N' : 'S';
        const ew = coord[0] >= 0 ? 'E' : 'W';
        document.getElementById('mouse-position').textContent =
            Math.abs(coord[1]).toFixed(6) + '°' + ns + '  ' +
            Math.abs(coord[0]).toFixed(6) + '°' + ew;
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

    function getZoomLevel() {
        return Math.round(map.getView().getZoom());
    }

    async function loadCharts() {
        if (loadingAbort) loadingAbort.abort();
        loadingAbort = new AbortController();
        const signal = loadingAbort.signal;

        const extent = map.getView().calculateExtent(map.getSize());
        const [west, south] = ol.proj.toLonLat([extent[0], extent[1]]);
        const [east, north] = ol.proj.toLonLat([extent[2], extent[3]]);
        const zoom = getZoomLevel();

        const visibleLayers = getVisibleLayers();
        if (visibleLayers.length === 0) {
            vectorSource.clear();
            updateInfo(0, 0);
            return;
        }

        showLoading(true);

        try {
            const url = `/api/charts?west=${west}&south=${south}&east=${east}&north=${north}&zoom=${zoom}&layers=${visibleLayers.join(',')}`;
            const resp = await fetch(url, { signal });
            if (signal.aborted) return;
            const data = await resp.json();

            vectorSource.clear();

            const format = new ol.format.GeoJSON();
            const features = format.readFeatures(data, {
                featureProjection: 'EPSG:3857',
                dataProjection: 'EPSG:4326',
            });

            vectorSource.addFeatures(features);
            currentFeatures = data;
            updateInfo(data.meta.charts_loaded, data.meta.total_features);
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('Failed to load charts:', e);
            }
        } finally {
            showLoading(false);
        }
    }

    function debouncedLoad() {
        if (loadDebounce) clearTimeout(loadDebounce);
        loadDebounce = setTimeout(loadCharts, 400);
    }

    map.getView().on('change:resolution', debouncedLoad);
    map.getView().on('change:center', debouncedLoad);

    // --- UI ---

    function showLoading(show) {
        document.getElementById('loading-indicator').classList.toggle('hidden', !show);
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
            if (preslibReady) s52._styleCache = {};
            vectorLayer.changed();
        });
    });

    // S-57 toggle
    document.getElementById('toggle-s57').addEventListener('change', function () {
        vectorLayer.setVisible(this.checked);
    });

    // Feature popup
    map.on('click', function (evt) {
        const features = map.getFeaturesAtPixel(evt.pixel, { hitTolerance: 5 });
        if (features && features.length > 0) {
            const feature = features[0];
            showFeaturePopup(feature);
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

        title.textContent = layer + (props.OBJNAM ? ' - ' + props.OBJNAM : '');

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
            'ACHBRT': 'Anchorage', 'DWRTPT': 'Deep Water Route', 'TWRTPT': 'Two-Way Route',
            'SEAARE': 'Sea Area', 'LAKARE': 'Lake', 'MORFAC': 'Mooring Facility',
            'M_COVR': 'Coverage', 'M_QUAL': 'Quality',
        };
        return code + ' (' + (descriptions[code] || 'Unknown') + ')';
    }

    // Scale select
    document.getElementById('scale-select').addEventListener('change', function () {
        const scale = parseInt(this.value);
        const zoomLevels = {
            50000000: 4, 10000000: 6, 3500000: 8,
            700000: 9, 180000: 11, 90000: 12,
            22000: 14, 12000: 15,
        };
        const zoom = zoomLevels[scale] || 6;
        map.getView().animate({ zoom, duration: 500 });
    });

    // Manual / Disclaimer
    document.getElementById('btn-disclaimer').addEventListener('click', function () {
        alert('DISCLAIMER\n\nThis S-57 chart viewer is for demonstration and educational purposes only.\nIt cannot be used for navigation.\nThe chart data may not be current or accurate.\nAlways use official nautical charts for navigation.');
    });

    document.getElementById('btn-manual').addEventListener('click', function () {
        alert('S-57 Web Viewer Manual\n\n' +
            '1. Pan: Click and drag the map\n' +
            '2. Zoom: Mouse wheel or +/- buttons\n' +
            '3. Display Options: Toggle chart features on/off\n' +
            '4. Click on features to see details\n' +
            '5. Charts load automatically based on view extent and zoom level\n' +
            '6. Higher zoom levels show more detailed charts');
    });

    async function initPreslib() {
        try {
            await s52.load('/s52-preslib.json');
            preslibReady = true;
            const sea = s52.getSeaColor();
            document.getElementById('map').style.backgroundColor = sea;
            updateLegendColors();
            vectorLayer.changed();
            loadCharts();
        } catch (e) {
            console.error('S-52 PresLib load failed:', e);
            document.getElementById('loading-indicator').querySelector('span').textContent =
                'S-52 Presentation Library 로드 실패';
        }
    }

    function updateLegendColors() {
        const c = (t) => s52.color(t);
        const legend = document.getElementById('legend');
        if (!legend) return;
        const items = legend.querySelectorAll('.legend-item');
        const swatches = [
            c('LANDA0'), c('DEPVS0'), c('DEPMS0'), c('DEPMD0'),
            c('CHYLW0'), c('CHRED0'), c('CHGRN0'), '#000', c('CHGRD0'),
        ];
        items.forEach((item, i) => {
            const sw = item.querySelector('.legend-swatch:not(.swatch-circle):not(.swatch-x):not(.swatch-star)');
            if (sw && swatches[i]) sw.style.background = swatches[i];
        });
        const circles = legend.querySelectorAll('.swatch-circle');
        if (circles[0]) circles[0].style.background = c('CHYLW0');
        if (circles[1]) circles[1].style.background = c('CHRED0');
        if (circles[2]) circles[2].style.background = c('CHGRN0');
    }

    initPreslib();

    // Cursor style
    map.on('pointermove', function (evt) {
        const hit = map.hasFeatureAtPixel(evt.pixel, { hitTolerance: 5 });
        map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    // Zoom change -> update scale select
    map.getView().on('change:resolution', function () {
        const zoom = getZoomLevel();
        updateInfo(
            parseInt(document.getElementById('info-charts').textContent) || 0,
            parseInt(document.getElementById('info-features').textContent.replace(/,/g, '')) || 0
        );
    });

})();
