const version = "0.0.6";
const cacheName = `rwtxtoffline-${version}`;
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(cacheName).then(cache => {
            return cache.addAll([
                    `/`,
                    `/index.html`,
                    `/static/style.css`,
                    `/static/js/crypto-js.min.js`,
                    `/static/js/enc-utf16.min.js`,
                    `/static/js/localforage.js`,
                    `/static/js/lunr.min.js`,
                    `/static/js/lz-string.js`,
                    `/static/js/pako.min.js`,
                    `/static/js/showdown.min.js`,
                    '/static/js/pwacompat.min.js',
                    '/static/js/vue.js',
                ])
                .then(() => self.skipWaiting());
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.open(cacheName)
        .then(cache => cache.match(event.request, {
            ignoreSearch: true
        }))
        .then(response => {
            return response || fetch(event.request);
        })
    );
});