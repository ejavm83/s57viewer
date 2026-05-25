(function () {
    'use strict';

    const REFRESH_MS = 2000;
    const STORAGE_OPEN = 's57viewer-console-open';
    const STORAGE_HEIGHT = 's57viewer-console-height';
    const STORAGE_TAB = 's57viewer-console-tab';
    const DEFAULT_HEIGHT = 220;
    const MIN_HEIGHT = 120;
    const MAX_HEIGHT_RATIO = 0.55;
    const LEVEL_RANK = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

    let serverEntries = [];
    let processEntries = [];
    let refreshTimer = null;
    let currentTab = 'server';
    let resizeStartY = 0;
    let resizeStartHeight = 0;

    const panel = document.getElementById('admin-console');
    if (!panel) return;

    const serverOut = document.getElementById('admin-console-server');
    const processOut = document.getElementById('admin-console-process');
    const metaLeft = document.getElementById('admin-console-meta-left');
    const metaRight = document.getElementById('admin-console-meta-right');
    const errorBanner = document.getElementById('admin-console-error');
    const filterLevel = document.getElementById('admin-console-filter-level');
    const filterSearch = document.getElementById('admin-console-filter-search');
    const autoRefresh = document.getElementById('admin-console-auto-refresh');
    const autoScroll = document.getElementById('admin-console-auto-scroll');
    const resizeHandle = document.getElementById('admin-console-resize');

    function isAdminMode() {
        return document.documentElement.classList.contains('admin-mode');
    }

    function isOpen() {
        return document.body.classList.contains('admin-console-open');
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
        const rank = LEVEL_RANK[(entry.level || 'INFO').toUpperCase()] || 20;
        return rank >= minRank;
    }

    function filterEntries(entries) {
        const minLevel = filterLevel ? filterLevel.value : '';
        const search = (filterSearch && filterSearch.value || '').trim().toLowerCase();
        return entries.filter(function (e) {
            if (!passesLevelFilter(e, minLevel)) return false;
            const msg = (e.message || e.text || '').toLowerCase();
            if (search && !msg.includes(search)) return false;
            return true;
        });
    }

    function showError(msg) {
        if (!errorBanner) return;
        if (msg) {
            errorBanner.textContent = msg;
            errorBanner.classList.add('visible');
        } else {
            errorBanner.textContent = '';
            errorBanner.classList.remove('visible');
        }
    }

    function setConsoleHeight(px) {
        const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
        const h = Math.max(MIN_HEIGHT, Math.min(px, maxH));
        panel.style.height = h + 'px';
        try { localStorage.setItem(STORAGE_HEIGHT, String(h)); } catch (_) { /* ignore */ }
        document.dispatchEvent(new CustomEvent('admin-console-resize'));
    }

    function restoreConsoleHeight() {
        let h = DEFAULT_HEIGHT;
        try {
            const stored = parseInt(localStorage.getItem(STORAGE_HEIGHT), 10);
            if (Number.isFinite(stored) && stored >= MIN_HEIGHT) h = stored;
        } catch (_) { /* ignore */ }
        setConsoleHeight(h);
    }

    function setTab(tab) {
        currentTab = tab === 'process' ? 'process' : 'server';
        panel.querySelectorAll('[data-console-tab]').forEach(function (btn) {
            const active = btn.getAttribute('data-console-tab') === currentTab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if (serverOut) serverOut.classList.toggle('hidden', currentTab !== 'server');
        if (processOut) processOut.classList.toggle('hidden', currentTab !== 'process');
        const serverTools = document.getElementById('admin-console-server-tools');
        const btnRefresh = document.getElementById('admin-console-btn-refresh');
        const btnClearServer = document.getElementById('admin-console-btn-clear-server');
        const btnClearProcess = document.getElementById('admin-console-btn-clear-process');
        if (serverTools) serverTools.classList.toggle('hidden', currentTab !== 'server');
        if (btnRefresh) btnRefresh.classList.toggle('hidden', currentTab !== 'server');
        if (btnClearServer) btnClearServer.classList.toggle('hidden', currentTab !== 'server');
        if (btnClearProcess) btnClearProcess.classList.toggle('hidden', currentTab !== 'process');
        try { localStorage.setItem(STORAGE_TAB, currentTab); } catch (_) { /* ignore */ }
        renderActiveTab();
    }

    function renderServerLogs(entries, meta) {
        if (!serverOut) return;
        const filtered = filterEntries(entries.map(function (e) {
            return { level: e.level, message: e.message, time: e.time };
        }));
        if (!filtered.length) {
            serverOut.innerHTML = '<div class="admin-console-empty">표시할 서버 로그가 없습니다.</div>';
        } else {
            serverOut.innerHTML = filtered.map(function (e) {
                const lvl = (e.level || 'INFO').toUpperCase();
                return '<div class="admin-console-line level-' + escapeHtml(lvl) + '">' +
                    '<span class="log-time">' + escapeHtml(e.time || '') + '</span>' +
                    '<span class="log-level">' + escapeHtml(lvl) + '</span>' +
                    '<span class="log-msg">' + escapeHtml(e.message || '') + '</span>' +
                    '</div>';
            }).join('');
        }
        if (metaLeft && currentTab === 'server') {
            metaLeft.textContent = filtered.length + ' / ' + (meta && meta.count || entries.length) + ' 줄';
        }
        if (metaRight && currentTab === 'server' && meta) {
            metaRight.textContent = '파일 ' + formatBytes(meta.file_size || 0) +
                ' · 버퍼 ' + (meta.buffer_count || 0);
        }
        if (autoScroll && autoScroll.checked && currentTab === 'server') {
            serverOut.scrollTop = serverOut.scrollHeight;
        }
    }

    function renderProcessLogs(entries) {
        if (!processOut) return;
        const filtered = filterEntries(entries.map(function (e) {
            return {
                level: String(e.level || 'info').toUpperCase(),
                message: e.text,
                time: e.time,
            };
        }));
        if (!filtered.length) {
            processOut.innerHTML = '<div class="admin-console-empty">처리 로그 없음 — 폴더를 불러오면 여기에 표시됩니다.</div>';
        } else {
            processOut.innerHTML = filtered.map(function (e) {
                const lvl = (e.level || 'info').toLowerCase();
                return '<div class="admin-console-line level-' + escapeHtml(lvl) + '">' +
                    '<span class="log-time">' + escapeHtml(e.time || '') + '</span>' +
                    '<span class="log-msg">' + escapeHtml(e.message || '') + '</span>' +
                    '</div>';
            }).join('');
        }
        if (metaLeft && currentTab === 'process') {
            metaLeft.textContent = filtered.length + ' / ' + entries.length + ' 줄';
        }
        if (metaRight && currentTab === 'process') {
            metaRight.textContent = '세션 저장 · 분석 보고서와 공유';
        }
        if (autoScroll && autoScroll.checked && currentTab === 'process') {
            processOut.scrollTop = processOut.scrollHeight;
        }
    }

    function renderActiveTab() {
        if (currentTab === 'server') renderServerLogs(serverEntries, { count: serverEntries.length });
        else renderProcessLogs(processEntries);
    }

    async function fetchJson(url, options) {
        const resp = await fetch(url, options);
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.detail || resp.statusText || 'Request failed');
        return data;
    }

    async function refreshServerLogs() {
        if (!isAdminMode() || !isOpen()) return;
        try {
            const levelSel = filterLevel && filterLevel.value;
            let url = '/api/admin/logs?lines=500';
            if (levelSel && levelSel !== 'INFO') url += '&level=' + encodeURIComponent(levelSel);
            const logs = await fetchJson(url);
            serverEntries = logs.entries || [];
            renderServerLogs(serverEntries, logs);
            showError('');
        } catch (err) {
            showError(err.message || String(err));
        }
    }

    function scheduleRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        if (autoRefresh && autoRefresh.checked && isAdminMode() && isOpen() && currentTab === 'server') {
            refreshTimer = setInterval(refreshServerLogs, REFRESH_MS);
        }
    }

    function releaseConsoleFocus() {
        const active = document.activeElement;
        if (!active || !panel.contains(active)) return;
        const toggle = document.getElementById('admin-console-toggle');
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
        else if (typeof active.blur === 'function') active.blur();
    }

    function setConsoleAccessible(open) {
        if (open) {
            panel.removeAttribute('inert');
            panel.setAttribute('aria-hidden', 'false');
        } else {
            releaseConsoleFocus();
            panel.setAttribute('inert', '');
            panel.setAttribute('aria-hidden', 'true');
        }
    }

    function open(tab) {
        if (!isAdminMode()) return;
        document.body.classList.add('admin-console-open');
        panel.classList.remove('hidden');
        setConsoleAccessible(true);
        const toggle = document.getElementById('admin-console-toggle');
        if (toggle) toggle.setAttribute('aria-pressed', 'true');
        restoreConsoleHeight();
        if (tab) setTab(tab);
        try { localStorage.setItem(STORAGE_OPEN, '1'); } catch (_) { /* ignore */ }
        renderActiveTab();
        if (currentTab === 'server') refreshServerLogs();
        scheduleRefresh();
        setTimeout(function () {
            document.dispatchEvent(new CustomEvent('admin-console-resize'));
        }, 0);
    }

    function close() {
        document.body.classList.remove('admin-console-open');
        panel.classList.add('hidden');
        setConsoleAccessible(false);
        const toggle = document.getElementById('admin-console-toggle');
        if (toggle) toggle.setAttribute('aria-pressed', 'false');
        try { localStorage.removeItem(STORAGE_OPEN); } catch (_) { /* ignore */ }
        scheduleRefresh();
        setTimeout(function () {
            document.dispatchEvent(new CustomEvent('admin-console-resize'));
        }, 0);
    }

    function toggle() {
        if (isOpen()) close();
        else open();
    }

    function setProcessEntries(entries) {
        processEntries = Array.isArray(entries) ? entries.slice() : [];
        if (isOpen() && currentTab === 'process') renderProcessLogs(processEntries);
    }

    async function clearServerLogs() {
        if (!confirm('서버 로그 파일과 메모리 버퍼를 모두 지울까요?')) return;
        try {
            await fetchJson('/api/admin/logs', { method: 'DELETE' });
            serverEntries = [];
            renderServerLogs([], { count: 0, file_size: 0, buffer_count: 0 });
            await refreshServerLogs();
        } catch (err) {
            showError(err.message || String(err));
        }
    }

    function clearProcessLogs() {
        if (!confirm('이 브라우저 세션의 처리 로그를 지울까요?')) return;
        processEntries = [];
        renderProcessLogs([]);
        document.dispatchEvent(new CustomEvent('admin-console-clear-process'));
    }

    function copyActiveLogs() {
        const entries = currentTab === 'server' ? serverEntries : processEntries;
        const filtered = filterEntries(entries.map(function (e) {
            return {
                time: e.time,
                level: e.level,
                message: e.message || e.text,
            };
        }));
        const text = filtered.map(function (e) {
            return (e.time || '') + ' ' + (e.level || '') + ' ' + (e.message || '');
        }).join('\n');
        navigator.clipboard.writeText(text).then(function () {
            const btn = document.getElementById('admin-console-btn-copy');
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = '복사됨';
                setTimeout(function () { btn.textContent = orig; }, 1500);
            }
        }).catch(function () {
            showError('클립보드 복사에 실패했습니다.');
        });
    }

    function bindResize() {
        if (!resizeHandle) return;
        resizeHandle.addEventListener('mousedown', function (evt) {
            evt.preventDefault();
            resizeStartY = evt.clientY;
            resizeStartHeight = panel.getBoundingClientRect().height;
            document.body.classList.add('admin-console-resizing');
            function onMove(e) {
                const dy = resizeStartY - e.clientY;
                setConsoleHeight(resizeStartHeight + dy);
            }
            function onUp() {
                document.body.classList.remove('admin-console-resizing');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function initControls() {
        document.getElementById('admin-console-toggle')?.addEventListener('click', toggle);
        document.getElementById('admin-console-close')?.addEventListener('click', close);
        document.getElementById('admin-console-btn-refresh')?.addEventListener('click', refreshServerLogs);
        document.getElementById('admin-console-btn-clear-server')?.addEventListener('click', clearServerLogs);
        document.getElementById('admin-console-btn-clear-process')?.addEventListener('click', clearProcessLogs);
        document.getElementById('admin-console-btn-copy')?.addEventListener('click', copyActiveLogs);

        panel.querySelectorAll('[data-console-tab]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setTab(btn.getAttribute('data-console-tab'));
                if (btn.getAttribute('data-console-tab') === 'server') refreshServerLogs();
                scheduleRefresh();
            });
        });

        if (filterLevel) {
            filterLevel.addEventListener('change', function () {
                renderActiveTab();
                if (currentTab === 'server') refreshServerLogs();
            });
        }
        if (filterSearch) filterSearch.addEventListener('input', renderActiveTab);
        if (autoRefresh) autoRefresh.addEventListener('change', scheduleRefresh);
        if (autoScroll) autoScroll.addEventListener('change', renderActiveTab);

        bindResize();
    }

    function onAdminModeChanged(enabled) {
        if (!enabled) {
            close();
            showError('');
        } else {
            try {
                if (localStorage.getItem(STORAGE_OPEN) === '1') {
                    const tab = localStorage.getItem(STORAGE_TAB);
                    open(tab === 'process' ? 'process' : 'server');
                }
            } catch (_) { /* ignore */ }
        }
    }

    document.addEventListener('admin-mode-changed', function (evt) {
        onAdminModeChanged(evt.detail && evt.detail.enabled);
    });

    window.S57AdminConsole = {
        open: open,
        close: close,
        toggle: toggle,
        setProcessEntries: setProcessEntries,
        isOpen: isOpen,
    };

    try {
        const tab = localStorage.getItem(STORAGE_TAB);
        if (tab === 'process' || tab === 'server') currentTab = tab;
    } catch (_) { /* ignore */ }

    initControls();
    setTab(currentTab);

    if (isAdminMode()) {
        try {
            if (localStorage.getItem(STORAGE_OPEN) === '1') open(currentTab);
        } catch (_) { /* ignore */ }
    }

    document.dispatchEvent(new CustomEvent('admin-console-ready'));
})();
