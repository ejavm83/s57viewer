(function () {
    'use strict';

    const LEVEL_RANK = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
    const REFRESH_MS = 2000;

    let allEntries = [];
    let refreshTimer = null;

    function isAdminMode() {
        return document.documentElement.classList.contains('admin-mode');
    }

    function formatBytes(n) {
        if (!n) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function passesLevelFilter(entry, minLevel) {
        if (!minLevel) return true;
        const minRank = LEVEL_RANK[minLevel] || 0;
        const rank = LEVEL_RANK[entry.level] || 20;
        return rank >= minRank;
    }

    function filterEntries(entries) {
        const minLevel = document.getElementById('filter-level').value;
        const search = (document.getElementById('filter-search').value || '').trim().toLowerCase();
        return entries.filter(function (e) {
            if (!passesLevelFilter(e, minLevel)) return false;
            if (search && !(e.message || '').toLowerCase().includes(search)) return false;
            return true;
        });
    }

    function showError(msg) {
        const banner = document.getElementById('log-error-banner');
        if (!banner) return;
        if (msg) {
            banner.textContent = msg;
            banner.classList.add('visible');
        } else {
            banner.textContent = '';
            banner.classList.remove('visible');
        }
    }

    function renderStatus(status) {
        const grid = document.getElementById('status-grid');
        if (!grid || !status) return;
        const prog = status.load_progress || {};
        const cards = [
            { label: '차트 수', value: String(status.chart_count || 0) },
            { label: '데이터 소스', value: status.datasource_mode || '—' },
            { label: '로드 상태', value: prog.status ? prog.status + (prog.message ? ' — ' + prog.message : '') : '—' },
            { label: '로그 파일', value: formatBytes(status.file_size || 0) },
            { label: '경로', value: (status.datasource_paths || []).join(', ') || '—' },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="status-card"><div class="label">' + escapeHtml(c.label) +
                '</div><div class="value">' + escapeHtml(c.value) + '</div></div>';
        }).join('');
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderLogs(entries, meta) {
        const out = document.getElementById('log-output');
        const metaLeft = document.getElementById('log-meta-left');
        const metaRight = document.getElementById('log-meta-right');
        if (!out) return;

        const filtered = filterEntries(entries);
        if (!filtered.length) {
            out.innerHTML = '<div class="log-empty">표시할 로그가 없습니다.</div>';
        } else {
            out.innerHTML = filtered.map(function (e) {
                const lvl = e.level || 'INFO';
                return '<div class="log-line level-' + lvl + '">' +
                    '<span class="log-time">' + escapeHtml(e.time || '') + '</span>' +
                    '<span class="log-level level-' + lvl + '">' + escapeHtml(lvl) + '</span>' +
                    '<span class="log-msg">' + escapeHtml(e.message || '') + '</span>' +
                    '</div>';
            }).join('');
        }

        if (metaLeft && meta) {
            metaLeft.textContent = filtered.length + ' / ' + (meta.count || entries.length) + ' 줄 표시';
        }
        if (metaRight && meta) {
            metaRight.textContent = '파일: ' + formatBytes(meta.file_size || 0) +
                ' · 버퍼: ' + (meta.buffer_count || 0);
        }

        if (document.getElementById('auto-scroll') && document.getElementById('auto-scroll').checked) {
            out.scrollTop = out.scrollHeight;
        }
    }

    async function fetchJson(url, options) {
        const resp = await fetch(url, options);
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) {
            throw new Error(data.detail || resp.statusText || 'Request failed');
        }
        return data;
    }

    async function refreshLogs() {
        if (!isAdminMode()) return;
        try {
            const levelSel = document.getElementById('filter-level');
            const apiLevel = levelSel && levelSel.value === 'INFO' ? null : (levelSel && levelSel.value) || null;
            let url = '/api/admin/logs?lines=800';
            if (apiLevel && apiLevel !== 'INFO') {
                url += '&level=' + encodeURIComponent(apiLevel);
            }
            const [logs, status] = await Promise.all([
                fetchJson(url),
                fetchJson('/api/admin/status'),
            ]);
            allEntries = logs.entries || [];
            renderStatus(status);
            renderLogs(allEntries, logs);
            showError('');
        } catch (err) {
            showError(err.message || String(err));
        }
    }

    function scheduleRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        const auto = document.getElementById('auto-refresh');
        if (auto && auto.checked && isAdminMode()) {
            refreshTimer = setInterval(refreshLogs, REFRESH_MS);
        }
    }

    async function clearLogs() {
        if (!confirm('로그 파일과 메모리 버퍼를 모두 지울까요?')) return;
        try {
            await fetchJson('/api/admin/logs', { method: 'DELETE' });
            allEntries = [];
            renderLogs([], { count: 0, file_size: 0, buffer_count: 0 });
            await refreshLogs();
        } catch (err) {
            showError(err.message || String(err));
        }
    }

    function copyLogs() {
        const filtered = filterEntries(allEntries);
        const text = filtered.map(function (e) {
            return (e.time || '') + ' ' + (e.level || '') + ' ' + (e.message || '');
        }).join('\n');
        navigator.clipboard.writeText(text).then(function () {
            const btn = document.getElementById('btn-copy');
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = '복사됨';
                setTimeout(function () { btn.textContent = orig; }, 1500);
            }
        }).catch(function () {
            showError('클립보드 복사에 실패했습니다.');
        });
    }

    function init() {
        const refreshBtn = document.getElementById('btn-refresh');
        const clearBtn = document.getElementById('btn-clear');
        const copyBtn = document.getElementById('btn-copy');
        const levelFilter = document.getElementById('filter-level');
        const searchFilter = document.getElementById('filter-search');
        const autoRefresh = document.getElementById('auto-refresh');

        if (refreshBtn) refreshBtn.addEventListener('click', refreshLogs);
        if (clearBtn) clearBtn.addEventListener('click', clearLogs);
        if (copyBtn) copyBtn.addEventListener('click', copyLogs);
        if (levelFilter) {
            levelFilter.addEventListener('change', function () {
                renderLogs(allEntries, { count: allEntries.length });
                refreshLogs();
            });
        }
        if (searchFilter) {
            searchFilter.addEventListener('input', function () {
                renderLogs(allEntries, { count: allEntries.length });
            });
        }
        if (autoRefresh) autoRefresh.addEventListener('change', scheduleRefresh);

        document.addEventListener('admin-mode-changed', function () {
            scheduleRefresh();
            if (isAdminMode()) refreshLogs();
        });

        if (isAdminMode()) {
            refreshLogs();
            scheduleRefresh();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
