'use strict';

const CACHE_VERSION = 'boot-v2';
const CACHE_NAME = 's57-viewer-' + CACHE_VERSION;

const PRECACHE_URLS = [
    '/s52-preslib.js?v=11',
    '/s52-preslib.json?v=9',
    '/boot-cache.js?v=10',
    '/default-viewport.json?v=1',
    '/s52-settings.json',
    '/s57data/rastersymbols-day.png',
    '/s57data/rastersymbols-dusk.png',
    '/s57data/rastersymbols-dark.png',
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(PRECACHE_URLS);
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) {
                if (key.startsWith('s57-viewer-') && key !== CACHE_NAME) {
                    return caches.delete(key);
                }
            }));
        }).then(function () { return self.clients.claim(); })
    );
});

function isBootAsset(url) {
    const path = url.pathname;
    if (path === '/default-viewport.json' || path.startsWith('/s57data/rastersymbols')) {
        return true;
    }
    if (path === '/s52-preslib.json' || path === '/s52-preslib.js' || path === '/boot-cache.js') {
        return true;
    }
    if (path === '/s52-settings.json') return true;
    return false;
}

self.addEventListener('fetch', function (event) {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    if (!isBootAsset(url)) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.match(event.request).then(function (cached) {
                const network = fetch(event.request).then(function (resp) {
                    if (resp && resp.ok) {
                        cache.put(event.request, resp.clone());
                    }
                    return resp;
                });
                return cached || network;
            });
        })
    );
});
