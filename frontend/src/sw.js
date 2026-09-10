const cacheName = 'offlinenotepad-react-__CACHE_VERSION__';
const precacheURLs = __PRECACHE_URLS__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(precacheURLs)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('offlinenotepad-') && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/ws' || url.pathname.startsWith('/api/') || url.pathname.endsWith('/raw')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || cache.match('/');
      }
    })());
  } else if (precacheURLs.includes(url.pathname)) {
    event.respondWith(caches.open(cacheName).then(async cache =>
      (await cache.match(url.pathname)) || fetch(request)));
  }
});
