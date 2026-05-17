(function (global) {
    'use strict';

    /** Bump when default sample / viewport bake params change (must match bake_default_viewport.py). */
    const BOOT_CACHE_VERSION = '1';
    const IDB_NAME = 's57-viewer-boot';
    const IDB_STORE = 'viewport';
    const IDB_KEY = 'default:' + BOOT_CACHE_VERSION;
    const STATIC_URL = '/default-viewport.json?v=' + BOOT_CACHE_VERSION;

    let staticPrefetch = null;

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!global.indexedDB) {
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            const req = global.indexedDB.open(IDB_NAME, 1);
            req.onerror = function () { reject(req.error); };
            req.onsuccess = function () { resolve(req.result); };
            req.onupgradeneeded = function (ev) {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
        });
    }

    function idbGet(key) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbPut(key, value) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                const req = tx.objectStore(IDB_STORE).put(value, key);
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function fetchStaticBundle() {
        if (!staticPrefetch) {
            staticPrefetch = fetch(STATIC_URL).then(function (resp) {
                if (!resp.ok) return null;
                return resp.json();
            }).catch(function () { return null; });
        }
        return staticPrefetch;
    }

    function normalizeBundle(raw, source) {
        if (!raw || raw.version !== BOOT_CACHE_VERSION) return null;
        const data = raw.data || raw;
        if (!data || !data.features || !data.features.length) return null;
        return {
            version: BOOT_CACHE_VERSION,
            source: source,
            bounds: raw.bounds || null,
            viewport: raw.viewport || null,
            data: data,
            saved_at: raw.saved_at || raw.generated_at || null,
        };
    }

    const BootCache = {
        version: BOOT_CACHE_VERSION,

        prefetchDefaultViewport: function () {
            fetchStaticBundle();
        },

        loadDefaultViewport: async function () {
            try {
                const cached = await idbGet(IDB_KEY);
                const fromIdb = normalizeBundle(cached, 'idb');
                if (fromIdb) return fromIdb;
            } catch (e) {
                /* ignore */
            }
            try {
                const raw = await fetchStaticBundle();
                return normalizeBundle(raw, 'static');
            } catch (e) {
                return null;
            }
        },

        saveDefaultViewport: async function (bundle) {
            if (!bundle || !bundle.data || !bundle.data.features || !bundle.data.features.length) {
                return false;
            }
            const payload = {
                version: BOOT_CACHE_VERSION,
                bounds: bundle.bounds || null,
                viewport: bundle.viewport || null,
                data: bundle.data,
                saved_at: new Date().toISOString(),
            };
            try {
                await idbPut(IDB_KEY, payload);
                return true;
            } catch (e) {
                console.warn('Boot cache save failed:', e);
                return false;
            }
        },
    };

    global.BootCache = BootCache;
    BootCache.prefetchDefaultViewport();
})(typeof window !== 'undefined' ? window : globalThis);
