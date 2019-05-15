const version = "0.0.5";
const cacheName = `rwtxtoffline-${version}`;
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(cacheName).then(cache => {
            return cache.addAll([
                    `/`,
                    `/index.html`,
                    `/style.css`,
                    `/js/crypto-js.min.js`,
                    `/js/localforage.js`,
                    `/js/lunr.min.js`,
                    `/js/lz-string.js`,
                    `/js/pako.min.js`,
                    `/js/showdown.min.js`,
                    '/js/pwacompat.min.js',
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