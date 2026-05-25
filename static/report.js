(function () {
    'use strict';

    const FOLDER_LOAD_LOG_KEY = 's57viewer-folder-load-log';
    let currentReport = null;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatBounds(bounds) {
        if (!bounds || bounds.length !== 4) return '—';
        return `W ${bounds[0].toFixed(4)}° · S ${bounds[1].toFixed(4)}° · E ${bounds[2].toFixed(4)}° · N ${bounds[3].toFixed(4)}°`;
    }

    function formatBoundsCompact(bounds) {
        if (!bounds || bounds.length !== 4) return '—';
        return `${bounds[0].toFixed(2)},${bounds[1].toFixed(2)} – ${bounds[2].toFixed(2)},${bounds[3].toFixed(2)}`;
    }

    function formatDateTime(ts) {
        if (!ts) return '—';
        try {
            return new Date(ts * 1000).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' });
        } catch (e) {
            return String(ts);
        }
    }

    function formatNominalScale(n) {
        if (!n || !Number.isFinite(n)) return '—';
        return '1:' + Number(n).toLocaleString('ko-KR');
    }

    function readProcessLog() {
        try {
            const raw = sessionStorage.getItem(FOLDER_LOAD_LOG_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function showError(message) {
        const el = document.getElementById('report-error');
        const loading = document.getElementById('report-loading');
        const content = document.getElementById('report-content');
        if (loading) loading.classList.add('hidden');
        if (content) content.classList.add('hidden');
        if (el) {
            el.textContent = message;
            el.classList.remove('hidden');
        }
    }

    function showContent() {
        document.getElementById('report-loading')?.classList.add('hidden');
        document.getElementById('report-error')?.classList.add('hidden');
        document.getElementById('report-content')?.classList.remove('hidden');
    }

    function renderMeta(report, ds) {
        const grid = document.getElementById('meta-grid');
        if (!grid) return;
        const paths = report.paths?.length ? report.paths : (report.path ? [report.path] : []);
        const items = [
            { label: '경로', value: paths.join('\n') || report.path || '—' },
            { label: '로드 모드', value: report.mode || ds?.mode || '—' },
            { label: '보고서 생성', value: formatDateTime(report.generated_at) },
            { label: '현재 인덱스 차트 수', value: String(ds?.chart_count ?? '—') },
        ];
        if (ds?.default_sample_dir) {
            items.push({ label: '기본 샘플 경로', value: ds.default_sample_dir });
        }
        grid.innerHTML = items.map(function (item) {
            return '<div class="meta-card"><div class="label">' + escapeHtml(item.label) +
                '</div><div class="value">' + escapeHtml(item.value).replace(/\n/g, '<br>') + '</div></div>';
        }).join('');
    }

    function renderSummary(summary) {
        const grid = document.getElementById('summary-stats');
        if (!grid || !summary) return;
        const lpc = summary.layers_per_chart || {};
        const cacheNote = summary.from_cache
            ? '캐시에서 로드'
            : (summary.duration_sec != null ? summary.duration_sec + '초 소요' : '');
        const cards = [
            { label: '발견된 .000 파일', value: summary.files_found ?? 0, cls: 'large' },
            { label: '인덱스 성공', value: summary.indexed_ok ?? 0, cls: 'large ok' },
            { label: '인덱스 실패', value: summary.indexed_failed ?? 0, cls: summary.indexed_failed > 0 ? 'large fail' : 'large' },
            { label: '데모 범위 외 제외', value: summary.skipped_outside_bounds ?? 0, cls: 'large' },
            { label: '레이어/차트 (평균)', value: lpc.avg ?? 0 },
            { label: '레이어/차트 (최소)', value: lpc.min ?? 0 },
            { label: '레이어/차트 (최대)', value: lpc.max ?? 0 },
            { label: '고유 레이어 종류', value: summary.unique_layers ?? '—' },
            { label: '레이어 인스턴스 합계', value: summary.total_layer_instances ?? '—' },
            { label: '전체 경계', value: formatBounds(summary.bounds) },
        ];
        if (cacheNote) {
            cards.push({ label: '처리', value: cacheNote });
        }
        grid.innerHTML = cards.map(function (c) {
            return '<div class="stat-card"><div class="label">' + escapeHtml(c.label) +
                '</div><div class="value ' + (c.cls || '') + '">' + escapeHtml(c.value) + '</div></div>';
        }).join('');
    }

    function renderScaleTable(summary) {
        const wrap = document.getElementById('scale-table-wrap');
        if (!wrap) return;
        const bands = summary.scale_bands || {};
        const keys = Object.keys(bands).sort(function (a, b) { return Number(a) - Number(b); });
        const maxCount = Math.max(1, ...keys.map(function (k) { return bands[k].count || 0; }));
        if (!keys.length) {
            wrap.innerHTML = '<p class="log-empty">축척 밴드 데이터 없음</p>';
            return;
        }
        let rows = '';
        keys.forEach(function (band) {
            const b = bands[band];
            const pct = Math.round(100 * (b.count || 0) / maxCount);
            rows += '<tr><td>' + escapeHtml(b.label) + '</td><td>밴드 ' + escapeHtml(band) +
                '</td><td>' + b.count + '</td><td><div class="bar-cell"><div class="bar-fill" style="width:' +
                pct + '%;max-width:200px"></div><span class="bar-label">' + b.count + '</span></div></td></tr>';
        });
        wrap.innerHTML = '<table class="report-table"><thead><tr><th>축척</th><th>밴드</th><th>차트 수</th><th>분포</th></tr></thead><tbody>' +
            rows + '</tbody></table>';
    }

    function renderLayerStats(summary) {
        const row = document.getElementById('layer-stats-row');
        const wrap = document.getElementById('layer-table-wrap');
        if (!row || !wrap) return;
        const lpc = summary.layers_per_chart || {};
        row.innerHTML =
            '<span>차트당 레이어: <strong>최소 ' + (lpc.min ?? 0) + '</strong> · ' +
            '<strong>평균 ' + (lpc.avg ?? 0) + '</strong> · ' +
            '<strong>최대 ' + (lpc.max ?? 0) + '</strong></span>' +
            '<span>고유 레이어 <strong>' + (summary.unique_layers ?? '—') + '</strong>종</span>' +
            '<span>전체 레이어 참조 <strong>' + (summary.total_layer_instances ?? '—') + '</strong>건</span>';

        const layers = summary.all_layers || summary.top_layers || [];
        if (!layers.length) {
            wrap.innerHTML = '<p class="log-empty">레이어 통계 없음</p>';
            return;
        }
        const maxCharts = Math.max(1, ...layers.map(function (l) { return l.charts || 0; }));
        let rows = layers.map(function (l) {
            const pct = Math.round(100 * (l.charts || 0) / maxCharts);
            return '<tr><td class="mono">' + escapeHtml(l.layer) + '</td><td>' + l.charts +
                '</td><td><div class="bar-cell"><div class="bar-fill" style="width:' + pct +
                '%;max-width:160px"></div></div></td></tr>';
        }).join('');
        wrap.innerHTML = '<table class="report-table"><thead><tr><th>레이어</th><th>포함 차트 수</th><th>빈도</th></tr></thead><tbody>' +
            rows + '</tbody></table>';
    }

    function renderProcessLog() {
        const panel = document.getElementById('process-log-panel');
        const hint = document.getElementById('log-count-hint');
        const entries = readProcessLog();
        if (hint) hint.textContent = '(' + entries.length + '줄)';
        if (!panel) return;
        if (!entries.length) {
            panel.innerHTML = '<div class="log-empty">이 브라우저 세션의 처리 로그가 없습니다. 지도 뷰어에서 폴더를 로드하면 여기에 표시됩니다.</div>';
            return;
        }
        panel.innerHTML = entries.map(function (entry) {
            return '<div class="log-line level-' + escapeHtml(entry.level || 'info') + '">' +
                '<span class="log-time">' + escapeHtml(entry.time || '') + '</span>' +
                '<span>' + escapeHtml(entry.text || '') + '</span></div>';
        }).join('');
        panel.scrollTop = panel.scrollHeight;
    }

    function layerTagsHtml(layers) {
        if (!layers || !layers.length) return '<span class="text-muted">—</span>';
        return '<div class="layer-tags">' + layers.map(function (l) {
            return '<span class="layer-tag">' + escapeHtml(l) + '</span>';
        }).join('') + '</div>';
    }

    function filterIndexedCharts(indexed, query, scaleBand) {
        const q = (query || '').trim().toLowerCase();
        return indexed.filter(function (c) {
            if (scaleBand && String(c.scale) !== scaleBand) return false;
            if (!q) return true;
            const hay = [
                c.file, c.name, c.path, c.source, c.scale_label,
                (c.layers || []).join(' '),
            ].join(' ').toLowerCase();
            return hay.indexOf(q) >= 0;
        });
    }

    function sortIndexedCharts(list, sortKey) {
        const arr = list.slice();
        arr.sort(function (a, b) {
            if (sortKey === 'scale') {
                return (a.scale || 0) - (b.scale || 0) || String(a.file).localeCompare(b.file);
            }
            if (sortKey === 'layers-desc') {
                return (b.layer_count || 0) - (a.layer_count || 0) || String(a.file).localeCompare(b.file);
            }
            if (sortKey === 'layers-asc') {
                return (a.layer_count || 0) - (b.layer_count || 0) || String(a.file).localeCompare(b.file);
            }
            return String(a.file || a.name).localeCompare(b.file || b.name);
        });
        return arr;
    }

    function renderIndexedTable(report) {
        const wrap = document.getElementById('indexed-table-wrap');
        const hint = document.getElementById('indexed-count-hint');
        const searchEl = document.getElementById('indexed-search');
        const scaleFilter = document.getElementById('indexed-scale-filter');
        const sortEl = document.getElementById('indexed-sort');
        if (!wrap) return;

        const indexed = report.indexed || [];
        if (hint) hint.textContent = '(' + indexed.length + '개)';

        if (scaleFilter && scaleFilter.options.length <= 1) {
            const bands = new Set(indexed.map(function (c) { return String(c.scale); }));
            Array.from(bands).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (band) {
                const opt = document.createElement('option');
                opt.value = band;
                const sample = indexed.find(function (c) { return String(c.scale) === band; });
                opt.textContent = sample?.scale_label ? sample.scale_label + ' (밴드 ' + band + ')' : '밴드 ' + band;
                scaleFilter.appendChild(opt);
            });
        }

        const query = searchEl ? searchEl.value : '';
        const band = scaleFilter ? scaleFilter.value : '';
        const sortKey = sortEl ? sortEl.value : 'file';
        const filtered = sortIndexedCharts(filterIndexedCharts(indexed, query, band), sortKey);

        if (!filtered.length) {
            wrap.innerHTML = '<p class="log-empty">표시할 차트가 없습니다.</p>';
            return;
        }

        let rows = filtered.map(function (c, i) {
            return '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td class="mono">' + escapeHtml(c.file || c.name) + '</td>' +
                '<td>' + escapeHtml(c.scale_label || c.scale) + '</td>' +
                '<td>' + formatNominalScale(c.nominal_scale) + '</td>' +
                '<td>' + (c.layer_count ?? (c.layers ? c.layers.length : 0)) + '</td>' +
                '<td class="mono">' + escapeHtml(c.source || '—') + '</td>' +
                '<td class="mono">' + escapeHtml(formatBoundsCompact(c.bounds)) + '</td>' +
                '<td class="mono" title="' + escapeHtml(c.path || '') + '">' + escapeHtml(c.path ? (c.path.length > 48 ? '…' + c.path.slice(-45) : c.path) : '—') + '</td>' +
                '<td>' + layerTagsHtml(c.layers) + '</td>' +
                '</tr>';
        }).join('');

        wrap.innerHTML = '<table class="report-table"><thead><tr>' +
            '<th>#</th><th>파일</th><th>축척</th><th>명목 축척</th><th>레이어 수</th>' +
            '<th>소스</th><th>경계 (W,S–E,N)</th><th>경로</th><th>레이어 목록</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderFailedTable(failed) {
        const section = document.getElementById('section-failed');
        const wrap = document.getElementById('failed-table-wrap');
        const hint = document.getElementById('failed-count-hint');
        if (!section || !wrap) return;
        if (!failed || !failed.length) {
            section.classList.add('hidden');
            return;
        }
        section.classList.remove('hidden');
        if (hint) hint.textContent = '(' + failed.length + '개)';
        const rows = failed.map(function (c, i) {
            return '<tr class="status-fail">' +
                '<td>' + (i + 1) + '</td>' +
                '<td class="mono">' + escapeHtml(c.file || c.name) + '</td>' +
                '<td class="mono">' + escapeHtml(c.name || '') + '</td>' +
                '<td>' + escapeHtml(c.error || 'Unknown error') + '</td></tr>';
        }).join('');
        wrap.innerHTML = '<table class="report-table"><thead><tr>' +
            '<th>#</th><th>파일</th><th>키</th><th>오류</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function bindIndexedFilters(report) {
        const searchEl = document.getElementById('indexed-search');
        const scaleFilter = document.getElementById('indexed-scale-filter');
        const sortEl = document.getElementById('indexed-sort');
        function refresh() { renderIndexedTable(report); }
        searchEl?.addEventListener('input', refresh);
        scaleFilter?.addEventListener('change', refresh);
        sortEl?.addEventListener('change', refresh);
    }

    function renderReport(report, ds) {
        currentReport = report;
        const subtitle = document.getElementById('report-subtitle');
        if (subtitle && report.summary) {
            const s = report.summary;
            subtitle.textContent = (report.path || '차트 데이터') + ' — .000 파일 ' + (s.files_found ?? 0) +
                '개 중 ' + (s.indexed_ok ?? 0) + '개 인덱싱 완료' +
                (s.indexed_failed > 0 ? ', ' + s.indexed_failed + '개 실패' : '') + '.';
        }
        renderMeta(report, ds);
        renderSummary(report.summary || {});
        renderScaleTable(report.summary || {});
        renderLayerStats(report.summary || {});
        renderProcessLog();
        renderIndexedTable(report);
        renderFailedTable(report.failed || []);
        bindIndexedFilters(report);
        showContent();
    }

    async function loadReport() {
        const loading = document.getElementById('report-loading');
        const content = document.getElementById('report-content');
        if (loading) loading.classList.remove('hidden');
        if (content) content.classList.add('hidden');
        document.getElementById('report-error')?.classList.add('hidden');

        let ds = null;
        try {
            const dsResp = await fetch('/api/datasource');
            if (dsResp.ok) ds = await dsResp.json();
        } catch (e) { /* ignore */ }

        try {
            const resp = await fetch('/api/datasource/report');
            if (!resp.ok) {
                const err = await resp.json().catch(function () { return {}; });
                const detail = err.detail || resp.statusText;
                if (!ds?.loaded) {
                    showError('아직 차트 데이터가 로드되지 않았습니다. 지도 뷰어에서 .000 폴더를 선택한 뒤 다시 열어 주세요.');
                } else {
                    showError('분석 보고서를 불러올 수 없습니다: ' + detail);
                }
                return;
            }
            const report = await resp.json();
            renderReport(report, ds);
        } catch (e) {
            showError('네트워크 오류: ' + e.message);
        }
    }

    function copyJson() {
        if (!currentReport) return;
        navigator.clipboard.writeText(JSON.stringify(currentReport, null, 2))
            .then(function () { alert('JSON이 클립보드에 복사되었습니다.'); })
            .catch(function () { alert('복사에 실패했습니다.'); });
    }

    function exportCsv() {
        if (!currentReport?.indexed?.length) {
            alert('보낼 차트 데이터가 없습니다.');
            return;
        }
        const header = ['file', 'scale', 'scale_label', 'nominal_scale', 'layer_count', 'source', 'west', 'south', 'east', 'north', 'path', 'layers'];
        const lines = [header.join(',')];
        currentReport.indexed.forEach(function (c) {
            const b = c.bounds || [];
            const row = [
                c.file || c.name,
                c.scale,
                '"' + String(c.scale_label || '').replace(/"/g, '""') + '"',
                c.nominal_scale || '',
                c.layer_count ?? (c.layers ? c.layers.length : 0),
                '"' + String(c.source || '').replace(/"/g, '""') + '"',
                b[0] ?? '', b[1] ?? '', b[2] ?? '', b[3] ?? '',
                '"' + String(c.path || '').replace(/"/g, '""') + '"',
                '"' + (c.layers || []).join(';').replace(/"/g, '""') + '"',
            ];
            lines.push(row.join(','));
        });
        const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 's57-chart-report.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    document.getElementById('btn-refresh')?.addEventListener('click', loadReport);
    document.getElementById('btn-copy-json')?.addEventListener('click', copyJson);
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCsv);

    loadReport();
})();
