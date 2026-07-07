/*
 * Service worker for JAR Compare (PWA / offline support).
 *
 * Strategy:
 *  - App shell (same-origin HTML/JS/CSS/assets): cache-first, so the page
 *    loads and runs offline after the first visit. Navigations are
 *    network-first so users still pick up new deploys when online.
 *  - CheerpJ CDN (cjrtnc.leaningtech.com): cache-first for full GETs (the
 *    loader and core runtime). NOTE: the JVM streams the JRE with HTTP Range
 *    requests, and the Cache API can't store 206 partial responses — those
 *    are passed straight through, so the *first* compare/decompile still
 *    needs a network connection.
 */
const VERSION = 'v2';
const APP_CACHE = `jarcompare-app-${VERSION}`;
const CDN_CACHE = `jarcompare-cdn-${VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== APP_CACHE && k !== CDN_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // CheerpJ runtime / JRE from the CDN.
  if (url.hostname === 'cjrtnc.leaningtech.com') {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // Same-origin app assets.
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, APP_CACHE));
    } else {
      event.respondWith(cacheFirst(req, APP_CACHE));
    }
  }
  // Anything else: let the browser handle it normally.
});

async function cacheFirst(req, cacheName) {
  // Range requests (used by CheerpJ to stream JRE jars) can't be cached
  // reliably — the Cache API rejects 206 responses — so pass them through.
  if (req.headers.has('range')) return fetch(req);

  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // SPA fallback: serve the cached app entry for offline navigations.
    const fallback =
      (await cache.match(`${self.registration.scope}index.html`)) ||
      (await cache.match(self.registration.scope));
    if (fallback) return fallback;
    throw err;
  }
}
