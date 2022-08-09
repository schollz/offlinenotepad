const version = "1.1.1";
const cacheName = `offlinenotepad-${version}`;
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(cacheName).then(cache => {
            return cache.addAll([
                    `/`,
                    `/index.html`,
                    `/static/css/style.css`,
                    `/static/js/crypto-js.min.js`,
                    `/static/js/crypto-js.min.js.map`,
                    `/static/js/enc-utf16.min.js`,
                    `/static/js/enc-utf16.min.js.map`,
                    `/static/js/localforage.js`,
                    `/static/js/lunr.min.js`,
                    `/static/js/lz-string.js`,
                    `/static/js/pako.min.js`,
                    `/static/js/showdown.min.js`,
                    `/static/js/showdown.min.js.map`,
                    '/static/js/pwacompat.min.js',
                    '/static/js/vue.min.js',
                    '/static/js/sweetalert.js',
                    '/static/js/moment.min.js',
                    '/static/js/js.cookie.min.js',
                    '/static/js/mark.min.js',
                    '/static/js/main.js',
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