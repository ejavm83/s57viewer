(function () {
    'use strict';

    const STORAGE_KEY = 's57viewer-admin-mode';

    const root = document.documentElement;

    function isAdminMode() {
        return root.classList.contains('admin-mode');
    }

    function setAdminMode(on) {
        root.classList.toggle('admin-mode', on);
        const indicator = document.getElementById('admin-mode-indicator');
        if (indicator) indicator.setAttribute('aria-hidden', on ? 'false' : 'true');
        const toggle = document.getElementById('admin-mode-toggle');
        if (toggle) {
            toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
            toggle.classList.toggle('active', on);
        }
        try {
            if (on) sessionStorage.setItem(STORAGE_KEY, '1');
            else sessionStorage.removeItem(STORAGE_KEY);
        } catch (_) { /* private browsing */ }
    }

    function toggleAdminMode() {
        setAdminMode(!isAdminMode());
    }

    function restoreAdminMode() {
        try {
            if (sessionStorage.getItem(STORAGE_KEY) === '1') setAdminMode(true);
        } catch (_) { /* ignore */ }
    }

    document.addEventListener('keydown', function (evt) {
        if (evt.key !== 'F12' || !evt.shiftKey) return;
        evt.preventDefault();
        toggleAdminMode();
    });

    function initAdminToggle() {
        const toggle = document.getElementById('admin-mode-toggle');
        if (!toggle) return;
        toggle.addEventListener('click', toggleAdminMode);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            restoreAdminMode();
            initAdminToggle();
        });
    } else {
        restoreAdminMode();
        initAdminToggle();
    }
})();
