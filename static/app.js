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
    let datasourceReady = false;
    let datasourceLoadActive = false;

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
        if ((layer === 'LNDRGN' || layer === 'LNDELV')) return null;
        if ((layer === 'LNDMRK' || layer === 'TOPMAR' || layer === 'PILPNT') && resolution > 800) return null;
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
        if (!datasourceReady) return;

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
            renderViewportReport(null);
            showLoading(false);
            return;
        }

        showLoading(true);
        updateProgressUI({
            message: 'Loading chart features for map…',
            percent: null,
            detail: `Zoom ${zoom}`,
            indeterminate: true,
        });

        try {
            const url = `/api/charts?west=${west}&south=${south}&east=${east}&north=${north}&zoom=${zoom}&layers=${visibleLayers.join(',')}`;
            const resp = await fetch(url, { signal });
            if (signal.aborted) return;
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || resp.statusText);
            }
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
            renderViewportReport(data.meta);
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('Failed to load charts:', e);
            }
        } finally {
            showLoading(false);
        }
    }

    function debouncedLoad() {
        if (!datasourceReady) return;
        if (loadDebounce) clearTimeout(loadDebounce);
        loadDebounce = setTimeout(loadCharts, 400);
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

    function renderFolderLoadReport(report) {
        const panel = document.getElementById('load-report-panel');
        const summaryEl = document.getElementById('load-report-summary');
        const detailEl = document.getElementById('load-report-detail-body');
        if (!panel || !summaryEl || !detailEl || !report) return;

        const s = report.summary || {};
        const bands = s.scale_bands || {};
        const bandRows = Object.keys(bands).sort((a, b) => Number(a) - Number(b))
            .map(b => `<tr><td>${escapeHtml(bands[b].label)}</td><td>${bands[b].count}</td></tr>`)
            .join('');

        const topLayers = (s.top_layers || [])
            .map(l => `<tr><td>${escapeHtml(l.layer)}</td><td>${l.charts}</td></tr>`)
            .join('');

        const cacheNote = s.from_cache
            ? 'Index loaded from cache (faster).'
            : (s.duration_sec != null ? `Indexed in ${s.duration_sec}s.` : '');

        summaryEl.innerHTML = `
            <div class="report-stat-grid">
                <div class="report-stat"><strong>${s.files_found ?? 0}</strong><span>.000 files found</span></div>
                <div class="report-stat"><strong>${s.indexed_ok ?? 0}</strong><span>indexed OK</span></div>
                <div class="report-stat"><strong>${s.indexed_failed ?? 0}</strong><span>failed</span></div>
                <div class="report-stat"><strong>${(s.layers_per_chart?.avg ?? 0)}</strong><span>avg layers/chart</span></div>
            </div>
            <table class="report-scale-table">
                <thead><tr><th>Scale band</th><th>Charts</th></tr></thead>
                <tbody>${bandRows || '<tr><td colspan="2">—</td></tr>'}</tbody>
            </table>
            ${topLayers ? `<table class="report-scale-table"><thead><tr><th>Top layers</th><th>Charts</th></tr></thead><tbody>${topLayers}</tbody></table>` : ''}
            <p class="report-note">${escapeHtml(formatBounds(s.bounds))}${cacheNote ? '<br>' + escapeHtml(cacheNote) : ''}</p>
        `;

        const indexed = report.indexed || [];
        const failed = report.failed || [];
        let detailHtml = '';

        if (indexed.length) {
            detailHtml += `<p><strong>Indexed charts (${indexed.length})</strong></p>
                <table><thead><tr><th>File</th><th>Scale</th><th>Layers</th><th>Bounds</th></tr></thead><tbody>`;
            detailHtml += indexed.map(c => {
                const b = c.bounds;
                const bStr = b ? `${b[0].toFixed(1)},${b[1].toFixed(1)}–${b[2].toFixed(1)},${b[3].toFixed(1)}` : '—';
                return `<tr>
                    <td>${escapeHtml(c.file)}</td>
                    <td>${escapeHtml(c.scale_label || c.scale)}</td>
                    <td>${c.layer_count}</td>
                    <td>${bStr}</td>
                </tr>`;
            }).join('');
            detailHtml += '</tbody></table>';
        }

        if (failed.length) {
            detailHtml += `<p class="report-failed"><strong>Failed (${failed.length})</strong></p>
                <table><thead><tr><th>File</th><th>Error</th></tr></thead><tbody>`;
            detailHtml += failed.map(c => `<tr class="status-fail">
                <td>${escapeHtml(c.file)}</td>
                <td>${escapeHtml(c.error)}</td>
            </tr>`).join('');
            detailHtml += '</tbody></table>';
        }

        if (!detailHtml) {
            detailHtml = '<p class="report-note">No per-file details.</p>';
        }

        detailEl.innerHTML = detailHtml;
        panel.classList.remove('hidden');
    }

    function hideFolderLoadReport() {
        document.getElementById('load-report-panel')?.classList.add('hidden');
    }

    async function fetchAndRenderFolderReport(existingReport) {
        if (existingReport && existingReport.indexed) {
            renderFolderLoadReport(existingReport);
            return;
        }
        try {
            const resp = await fetch('/api/datasource/report');
            if (resp.ok) {
                renderFolderLoadReport(await resp.json());
            } else if (existingReport?.summary) {
                renderFolderLoadReport({ summary: existingReport.summary, indexed: [], failed: [] });
            }
        } catch (e) {
            console.warn('Could not load folder report:', e);
        }
    }

    function renderViewportReport(meta) {
        const details = document.getElementById('viewport-report-details');
        const body = document.getElementById('viewport-report-body');
        const matchedEl = document.getElementById('info-charts-matched');
        if (!details || !body || !meta) return;

        if (matchedEl) {
            const matched = meta.charts_matched ?? meta.charts_loaded ?? 0;
            matchedEl.textContent = meta.charts_capped
                ? `${matched} (${meta.charts_loaded} drawn, max ${meta.max_charts})`
                : String(matched);
        }

        if (!meta.charts_matched && !meta.charts_loaded) {
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
        let html = `<p class="report-note">Zoom ${meta.zoom} · scales: ${escapeHtml(scaleLabels || '—')}</p>`;

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
            hideFolderLoadReport();
        }
    }

    function fitMapToBounds(bounds, onComplete) {
        if (!bounds || bounds.length !== 4) {
            if (onComplete) onComplete();
            return;
        }
        const extent = ol.proj.transformExtent(bounds, 'EPSG:4326', 'EPSG:3857');
        const view = map.getView();
        if (onComplete) {
            const listenerKey = map.once('moveend', onComplete);
            view.fit(extent, { padding: [40, 40, 40, 40], maxZoom: 12, duration: 600 });
            if (!view.getAnimating()) {
                ol.Observable.unByKey(listenerKey);
                onComplete();
            }
        } else {
            view.fit(extent, { padding: [40, 40, 40, 40], maxZoom: 12, duration: 600 });
        }
    }

    function onDatasourceLoaded(data) {
        datasourceReady = true;
        updateDatasourceUI(data);
        fetchAndRenderFolderReport(data.report);
        showLoading(false);
        map.updateSize();
        const loadWhenReady = () => {
            if (preslibReady) loadCharts();
        };
        if (data.bounds) {
            fitMapToBounds(data.bounds, loadWhenReady);
        } else {
            loadWhenReady();
        }
    }

    function setDatasourceButtonsDisabled(disabled) {
        const browse = document.getElementById('btn-browse-folder');
        if (browse) browse.disabled = disabled;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        while (true) {
            const resp = await fetch('/api/datasource/progress');
            const p = await resp.json();

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

            if (p.status === 'done') {
                if (!p.result) {
                    const ds = await fetch('/api/datasource').then(r => r.json());
                    if (!ds.loaded) throw new Error('Load finished but chart data is unavailable.');
                    return ds;
                }
                return p.result;
            }
            if (p.status === 'error') {
                throw new Error(p.error || p.message || 'Failed to load chart data');
            }
            if (p.status === 'idle') {
                throw new Error('Load was interrupted');
            }

            await sleep(300);
        }
    }

    async function browseServerFolder() {
        if (datasourceLoadActive) return;

        hideFolderLoadReport();
        showLoading(true);
        setDatasourceButtonsDisabled(true);
        datasourceLoadActive = true;
        updateProgressUI({
            message: 'Select folder in the dialog…',
            percent: null,
            detail: '',
            indeterminate: true,
        });

        try {
            const resp = await fetch('/api/datasource/browse?mode=replace', {
                method: 'POST',
            });
            const data = await resp.json();
            if (data.cancelled) {
                showLoading(false);
                return;
            }
            if (!resp.ok) throw new Error(data.detail || 'Failed to load folder');
            if (data.status === 'started') {
                const result = await waitForDatasourceLoad();
                onDatasourceLoaded(result);
                if (!preslibReady) showLoading(false);
            } else if (data.loaded) {
                onDatasourceLoaded(data);
                if (!preslibReady) showLoading(false);
            }
        } catch (e) {
            console.error(e);
            alert('Could not load folder:\n' + e.message);
            showLoading(false);
        } finally {
            datasourceLoadActive = false;
            setDatasourceButtonsDisabled(false);
        }
    }

    function isDefaultSampleLoaded(data) {
        return data
            && data.loaded
            && data.mode === 'default'
            && data.includes_default_sample;
    }

    async function waitForDefaultSampleReady() {
        const resp = await fetch('/api/datasource/default', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || 'Failed to load default sample');
        if (data.loaded) return data;
        if (data.status === 'started') return waitForDatasourceLoad();
        throw new Error('Unexpected response while loading default sample');
    }

    async function ensureDefaultSampleOnConnect() {
        datasourceLoadActive = true;
        setDatasourceButtonsDisabled(true);
        showLoading(true);
        updateProgressUI({
            message: 'Loading default sample charts…',
            percent: null,
            detail: 'public/sample',
            indeterminate: true,
        });

        try {
            const dsResp = await fetch('/api/datasource');
            const ds = await dsResp.json();

            if (isDefaultSampleLoaded(ds)) {
                onDatasourceLoaded(ds);
                return;
            }

            const progResp = await fetch('/api/datasource/progress');
            const prog = await progResp.json();

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

    map.getView().on('change:resolution', debouncedLoad);
    map.getView().on('change:center', debouncedLoad);

    // --- UI ---

    function showLoading(show) {
        const el = document.getElementById('loading-indicator');
        if (!el) return;
        el.classList.toggle('hidden', !show);
        el.setAttribute('aria-busy', show ? 'true' : 'false');
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

    // Disclaimer
    document.getElementById('btn-disclaimer').addEventListener('click', function () {
        alert('DISCLAIMER\n\nThis S-57 chart viewer is for demonstration and educational purposes only.\nIt cannot be used for navigation.\nThe chart data may not be current or accurate.\nAlways use official nautical charts for navigation.');
    });

    async function initPreslib() {
        try {
            await s52.load('/s52-preslib.json');
            preslibReady = true;
            const sea = s52.getSeaColor();
            document.getElementById('map').style.backgroundColor = sea;
            updateLegendColors();
            vectorLayer.changed();
            if (datasourceReady) loadCharts();
        } catch (e) {
            console.error('S-52 PresLib load failed:', e);
            document.getElementById('map').style.backgroundColor = '#9fc5e8';
            if (datasourceReady) loadCharts();
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

    document.getElementById('btn-browse-folder')?.addEventListener('click', browseServerFolder);

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

    initPreslib();
    ensureDefaultSampleOnConnect();
    loadVisitorStats();

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
